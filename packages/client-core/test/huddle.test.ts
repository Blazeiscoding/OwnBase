import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HuddleSignal, ID } from "@slackoss/protocol";
import type { CallReport } from "@slackoss/protocol";
import { HuddleSession, STALL_MS, testMicrophone } from "../src/huddle.js";

/**
 * Just enough WebRTC to exercise the session's own logic. The parts that
 * matter here are which transceiver a track lands on and what gets signalled —
 * not whether media actually flows, which only a real browser can tell us.
 */
interface FakeSender {
  track: unknown;
  replaceTrack: (t: unknown) => Promise<void>;
}
interface FakeReceiver {
  /** What the far side's last packet was worth, as the browser reports it. */
  level: number;
  getSynchronizationSources: () => { audioLevel: number }[];
}
interface FakeTransceiver {
  sender: FakeSender;
  receiver: FakeReceiver;
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  transceivers: FakeTransceiver[] = [];
  connectionState = "new";
  iceConnectionState = "new";
  signalingState = "stable";
  /** What each offer was asked for, as `createOffer` was called. */
  offerOptions: unknown[] = [];
  /** Configurations set after creation, newest last. */
  configs: unknown[] = [];
  /** The browser's statistics, where a test gives some. */
  stats: Map<string, Record<string, unknown>> | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  closed = false;
  remoteDescription: unknown = null;
  candidates: unknown[] = [];
  onicecandidate: ((e: unknown) => void) | null = null;
  ontrack: ((e: { transceiver: FakeTransceiver; track: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTransceiver(_kind: string, _init: unknown): FakeTransceiver {
    const tx: FakeTransceiver = {
      sender: {
        track: null,
        replaceTrack(t: unknown) {
          this.track = t;
          return Promise.resolve();
        },
      },
      receiver: {
        level: 0,
        getSynchronizationSources() {
          return [{ audioLevel: this.level }];
        },
      },
    };
    this.transceivers.push(tx);
    return tx;
  }

  createOffer(options?: unknown) {
    this.offerOptions.push(options);
    return Promise.resolve({ type: "offer", sdp: "fake-offer" });
  }
  setConfiguration(config: unknown) {
    this.configs.push(config);
  }
  getStats() {
    return Promise.resolve(this.stats ?? new Map());
  }
  /** Moves the connection on, as the browser would. */
  become(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  createAnswer() {
    return Promise.resolve({ type: "answer", sdp: "fake-answer" });
  }
  setLocalDescription() {
    return Promise.resolve();
  }
  setRemoteDescription(description: unknown) {
    this.remoteDescription = description;
    if (this.transceivers.length === 0) {
      this.addTransceiver("audio", {});
      this.addTransceiver("video", {});
      this.addTransceiver("video", {});
    }
    return Promise.resolve();
  }
  getTransceivers() {
    return this.transceivers;
  }
  addIceCandidate(candidate: unknown) {
    this.candidates.push(candidate);
    return Promise.resolve();
  }
  close() {
    this.closed = true;
  }

  /** Simulates the far side's track arriving on one slot. */
  emitTrack(slot: 0 | 1 | 2): void {
    this.ontrack?.({ transceiver: this.transceivers[slot]!, track: { kind: "video" } });
  }
}

class FakeMediaStream {
  constructor(public tracks: unknown[] = []) {}
  getAudioTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

const g = globalThis as unknown as Record<string, unknown>;

/** Offers are sent after a couple of awaits; let them land before asserting. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Collects everything the session tries to send to the server. */
function makeSession(selfId: ID) {
  const sent: { to: ID; signal: HuddleSignal }[] = [];
  const session = new HuddleSession("C1", selfId, {
    send: (msg) => sent.push({ to: msg.to, signal: msg.signal }),
  });
  return { session, sent };
}

beforeEach(() => {
  FakePeerConnection.instances = [];
  g.RTCPeerConnection = FakePeerConnection;
  g.MediaStream = FakeMediaStream;
  // `navigator` is getter-only on the Node global, so define rather than assign.
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => Promise.resolve(new FakeMediaStream([{ kind: "video", stop() {} }])),
        getDisplayMedia: () => Promise.resolve(new FakeMediaStream([{ kind: "video", stop() {} }])),
      },
    },
  });
});

describe("HuddleSession", () => {
  it("buffers early ICE until the remote description is set", async () => {
    const { session } = makeSession("Z");
    const candidate = { candidate: "candidate:early", sdpMid: "0", sdpMLineIndex: 0 };
    await session.handleSignal("B", { kind: "ice", candidate });
    const pc = FakePeerConnection.instances[0]!;
    expect(pc.candidates).toEqual([]);
    await session.handleSignal("B", { kind: "offer", sdp: "offer" });
    expect(pc.candidates).toEqual([candidate]);
    session.destroy();
  });

  it.each(["audio", "camera", "screen"])(
    "releases %s permission results after leaving",
    async (kind) => {
      const { session } = makeSession("A");
      let resolve!: (stream: MediaStream) => void;
      const pending = new Promise<MediaStream>((r) => {
        resolve = r;
      });
      const method = kind === "screen" ? "getDisplayMedia" : "getUserMedia";
      vi.spyOn(navigator.mediaDevices, method).mockReturnValue(pending);
      const stop = vi.fn();
      const task =
        kind === "audio"
          ? session.startLocalAudio()
          : kind === "camera"
            ? session.toggleCamera()
            : session.toggleScreenShare();
      session.destroy();
      resolve(new FakeMediaStream([{ stop }]) as unknown as MediaStream);
      await task;
      expect(stop).toHaveBeenCalledOnce();
      expect(session.cameraOn).toBe(false);
      expect(session.sharingScreen).toBe(false);
      session.syncParticipants(["A", "B"]);
      expect(FakePeerConnection.instances).toHaveLength(0);
    },
  );

  it.each(["audio", "camera", "screen"])(
    "says %s cannot be reached at all where the page has no way to ask",
    async (kind) => {
      // As on a page served over plain HTTP: no mediaDevices to ask.
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
      const { session } = makeSession("A");
      const task =
        kind === "audio"
          ? session.startLocalAudio()
          : kind === "camera"
            ? session.toggleCamera()
            : session.toggleScreenShare();
      await expect(task).rejects.toMatchObject({ name: "NotSupportedError" });
      expect(session.cameraOn).toBe(false);
      expect(session.sharingScreen).toBe(false);
      session.destroy();
    },
  );

  it("shares a screen as detail, keeping text sharp, and at no more than 1080p", async () => {
    const { session } = makeSession("A");
    const track: { kind: string; stop(): void; contentHint?: string } = {
      kind: "video",
      stop() {},
    };
    const capture = vi
      .spyOn(navigator.mediaDevices, "getDisplayMedia")
      .mockResolvedValue(new FakeMediaStream([track]) as unknown as MediaStream);
    await session.toggleScreenShare();
    // Without the hint, an encoder short of bandwidth blurs a screen like a face.
    expect(track.contentHint).toBe("detail");
    const video = capture.mock.calls[0]![0]!.video as MediaTrackConstraints;
    expect(video.width).toEqual({ max: 1920 });
    expect(video.height).toEqual({ max: 1080 });
    expect(video.frameRate).toEqual({ ideal: 15, max: 15 });
    session.destroy();
  });

  it("shares a screen at the resolution and frame rate chosen, sixty as motion", async () => {
    const { session } = makeSession("A");
    const track: { kind: string; stop(): void; contentHint?: string } = {
      kind: "video",
      stop() {},
    };
    const capture = vi
      .spyOn(navigator.mediaDevices, "getDisplayMedia")
      .mockResolvedValue(new FakeMediaStream([track]) as unknown as MediaStream);
    await session.toggleScreenShare({ height: 720, frameRate: 60 });
    const video = capture.mock.calls[0]![0]!.video as MediaTrackConstraints;
    expect(video.width).toEqual({ max: 1280 });
    expect(video.height).toEqual({ max: 720 });
    expect(video.frameRate).toEqual({ ideal: 60, max: 60 });
    // Asked for smoothness, a game or a video keeps moving and softens instead.
    expect(track.contentHint).toBe("motion");
    session.destroy();
  });

  it("deduplicates camera permission requests", async () => {
    const { session } = makeSession("A");
    const capture = vi.spyOn(navigator.mediaDevices, "getUserMedia");
    await Promise.all([session.toggleCamera(), session.toggleCamera()]);
    expect(capture).toHaveBeenCalledOnce();
    session.destroy();
  });
  it("gives every connection the same three slots before offering", async () => {
    const { session, sent } = makeSession("A");
    session.syncParticipants(["A", "B"]);
    await flush();

    const pc = FakePeerConnection.instances[0]!;
    expect(pc.transceivers).toHaveLength(3);
    // "A" < "B", so this side offers.
    expect(sent.some((m) => m.signal.kind === "offer")).toBe(true);
    session.destroy();
  });

  it("lets the higher id wait to be offered to, so the two do not collide", () => {
    const { session, sent } = makeSession("Z");
    session.syncParticipants(["Z", "B"]);
    expect(sent.some((m) => m.signal.kind === "offer")).toBe(false);
    session.destroy();
  });

  it("hides a peer's video until they say they are sending it", () => {
    const { session } = makeSession("A");
    session.syncParticipants(["A", "B"]);
    const pc = FakePeerConnection.instances[0]!;

    // Tracks arrive for every slot regardless, because the slots always exist.
    pc.emitTrack(1);
    pc.emitTrack(2);
    expect(session.state().peers[0]!.cameraStream).toBeNull();
    expect(session.state().peers[0]!.screenStream).toBeNull();

    void session.handleSignal("B", { kind: "media", camera: true, screen: false });
    expect(session.state().peers[0]!.cameraStream).not.toBeNull();
    expect(session.state().peers[0]!.screenStream).toBeNull();

    void session.handleSignal("B", { kind: "media", camera: false, screen: true });
    expect(session.state().peers[0]!.cameraStream).toBeNull();
    expect(session.state().peers[0]!.screenStream).not.toBeNull();
    session.destroy();
  });

  it("announces the camera to everyone without a new offer", async () => {
    const { session, sent } = makeSession("A");
    session.syncParticipants(["A", "B", "C"]);
    await flush();
    sent.length = 0;

    await session.toggleCamera();

    const media = sent.filter((m) => m.signal.kind === "media");
    expect(media).toHaveLength(2); // one per peer
    expect(media.every((m) => m.signal.kind === "media" && m.signal.camera)).toBe(true);
    // The whole point of fixed slots: no renegotiation.
    expect(sent.some((m) => m.signal.kind === "offer")).toBe(false);
    // The track really was attached to the camera slot on both connections.
    for (const pc of FakePeerConnection.instances) {
      expect(pc.transceivers[1]!.sender.track).not.toBeNull();
      expect(pc.transceivers[2]!.sender.track).toBeNull();
    }
    session.destroy();
  });

  it("tells a late joiner what is already being sent", async () => {
    const { session, sent } = makeSession("A");
    session.syncParticipants(["A", "B"]);
    await session.toggleCamera();
    await flush();
    sent.length = 0;

    session.syncParticipants(["A", "B", "C"]);
    const toC = sent.filter((m) => m.to === "C" && m.signal.kind === "media");
    expect(toC).toHaveLength(1);
    expect(toC[0]!.signal).toMatchObject({ camera: true, screen: false });
    session.destroy();
  });

  it("drops anyone who leaves the room", () => {
    const { session } = makeSession("A");
    session.syncParticipants(["A", "B"]);
    const pc = FakePeerConnection.instances[0]!;
    session.syncParticipants(["A"]);
    expect(pc.closed).toBe(true);
    expect(session.state().peers).toHaveLength(0);
    session.destroy();
  });
  it("shows a peer as talking only while their audio is loud", () => {
    vi.useFakeTimers();
    try {
      const { session } = makeSession("A");
      session.syncParticipants(["A", "B"]);
      const audioSlot = FakePeerConnection.instances[0]!.transceivers[0]!;

      expect(session.state().peers[0]!.speaking).toBe(false);
      audioSlot.receiver.level = 0.4;
      vi.advanceTimersByTime(200);
      expect(session.state().peers[0]!.speaking).toBe(true);

      // Silence holds the indicator briefly, so it does not strobe between words.
      audioSlot.receiver.level = 0;
      vi.advanceTimersByTime(300);
      expect(session.state().peers[0]!.speaking).toBe(true);
      vi.advanceTimersByTime(400);
      expect(session.state().peers[0]!.speaking).toBe(false);
      session.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the others when the microphone goes off", async () => {
    const { session, sent } = makeSession("A");
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(
      new FakeMediaStream([{ kind: "audio", enabled: true, stop() {} }]) as unknown as MediaStream,
    );
    await session.startLocalAudio();
    session.syncParticipants(["A", "B"]);
    sent.length = 0;

    session.toggleMic();
    expect(sent.at(-1)!.signal).toMatchObject({ kind: "media", muted: true });
    session.toggleMic();
    expect(sent.at(-1)!.signal).toMatchObject({ kind: "media", muted: false });
    session.destroy();
  });

  it("starts with the microphone off when asked, and says so to each peer as it connects", async () => {
    const { session, sent } = makeSession("A");
    const mic = { kind: "audio", enabled: true, stop() {} };
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(
      new FakeMediaStream([mic]) as unknown as MediaStream,
    );
    await session.startLocalAudio(true);
    expect(mic.enabled).toBe(false);
    expect(session.state().micMuted).toBe(true);

    session.syncParticipants(["A", "B"]);
    expect(sent.find((m) => m.to === "B" && m.signal.kind === "media")?.signal).toMatchObject({
      kind: "media",
      muted: true,
    });
    session.toggleMic();
    expect(mic.enabled).toBe(true);
    session.destroy();
  });

  describe("a microphone that stops mid-call (CALL-01)", () => {
    type Track = { kind: string; enabled: boolean; stop: () => void; onended?: () => void };
    const track = (): Track => ({ kind: "audio", enabled: true, stop: vi.fn() });
    const stream = (t: Track) => new FakeMediaStream([t]) as unknown as MediaStream;
    let listeners: Map<string, () => void>;

    beforeEach(() => {
      listeners = new Map();
      Object.assign(navigator.mediaDevices, {
        addEventListener: vi.fn((type: string, fn: () => void) => listeners.set(type, fn)),
        removeEventListener: vi.fn((type: string) => listeners.delete(type)),
      });
    });

    async function inCall(first: Track) {
      const { session, sent } = makeSession("A");
      const ask = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(stream(first));
      await session.startLocalAudio();
      session.syncParticipants(["A", "B"]);
      await flush();
      return { session, sent, ask, pc: FakePeerConnection.instances[0]! };
    }

    it("sends everyone the system's microphone in its place, muted as it was", async () => {
      const unplugged = track();
      const { session, ask, pc } = await inCall(unplugged);
      expect(pc.transceivers[0]!.sender.track).toBe(unplugged);
      session.toggleMic();

      const next = track();
      ask.mockResolvedValueOnce(stream(next));
      unplugged.onended!();
      await flush();
      await flush();
      expect(ask).toHaveBeenCalledTimes(2);
      expect(pc.transceivers[0]!.sender.track).toBe(next);
      expect(next.enabled).toBe(false);
      expect(session.state()).toMatchObject({ micMuted: true, micLost: false });
      session.destroy();
    });

    it.each([
      { initiallyMuted: false, toggles: 1, muted: true },
      { initiallyMuted: true, toggles: 1, muted: false },
      { initiallyMuted: false, toggles: 3, muted: true },
    ])(
      "uses the latest mute choice while capture is held: $initiallyMuted / $toggles",
      async ({ initiallyMuted, toggles, muted }) => {
        const { session, sent, ask, pc } = await inCall(track());
        try {
          if (initiallyMuted) session.toggleMic();
          let finish!: (stream: MediaStream) => void;
          ask.mockReturnValueOnce(
            new Promise<MediaStream>((resolve) => {
              finish = resolve;
            }),
          );
          const recovery = session.recoverMicrophone();
          for (let i = 0; i < toggles; i++) session.toggleMic();
          const next = track();
          finish(stream(next));
          expect(await recovery).toBe(true);
          expect(next.enabled).toBe(!muted);
          expect(pc.transceivers[0]!.sender.track).toBe(next);
          expect(session.state().micMuted).toBe(muted);
          expect(sent.at(-1)!.signal).toMatchObject({ kind: "media", muted });
        } finally {
          session.destroy();
        }
      },
    );

    it("keeps a mute made during failed recovery for the later retry", async () => {
      const { session, ask, pc } = await inCall(track());
      try {
        let refuse!: (reason: Error) => void;
        ask.mockReturnValueOnce(
          new Promise<MediaStream>((_resolve, reject) => {
            refuse = reject;
          }),
        );
        const recovery = session.recoverMicrophone();
        session.toggleMic();
        refuse(new Error("Microphone not available"));
        expect(await recovery).toBe(false);
        expect(session.state()).toMatchObject({ micMuted: true, micLost: true });
        const next = track();
        ask.mockResolvedValueOnce(stream(next));
        expect(await session.recoverMicrophone()).toBe(true);
        expect(next.enabled).toBe(false);
        expect(pc.transceivers[0]!.sender.track).toBe(next);
      } finally {
        session.destroy();
      }
    });

    it("releases a replacement microphone returned after leaving", async () => {
      const { session, ask } = await inCall(track());
      let finish!: (stream: MediaStream) => void;
      ask.mockReturnValueOnce(
        new Promise<MediaStream>((resolve) => {
          finish = resolve;
        }),
      );
      const recovery = session.recoverMicrophone();
      session.destroy();
      const next = track();
      finish(stream(next));
      expect(await recovery).toBe(false);
      expect(next.stop).toHaveBeenCalledOnce();
    });

    it("says so when there is none, tells the others it is muted, and takes the next plugged in", async () => {
      const unplugged = track();
      const { session, sent, ask, pc } = await inCall(unplugged);
      sent.length = 0;
      ask.mockRejectedValueOnce(new DOMException("Requested device not found", "NotFoundError"));
      unplugged.onended!();
      await flush();
      expect(session.state().micLost).toBe(true);
      expect(sent.at(-1)!.signal).toMatchObject({ kind: "media", muted: true });

      const plugged = track();
      ask.mockResolvedValueOnce(stream(plugged));
      listeners.get("devicechange")!();
      await flush();
      await flush();
      expect(session.state()).toMatchObject({ micMuted: false, micLost: false });
      expect(pc.transceivers[0]!.sender.track).toBe(plugged);
      expect(sent.at(-1)!.signal).toMatchObject({ kind: "media", muted: false });
      expect(listeners.has("devicechange")).toBe(false);
      session.destroy();
    });

    it("stops listening for microphones once the huddle ends", async () => {
      const unplugged = track();
      const { session, ask } = await inCall(unplugged);
      ask.mockRejectedValueOnce(new DOMException("Requested device not found", "NotFoundError"));
      unplugged.onended!();
      await flush();
      expect(listeners.has("devicechange")).toBe(true);
      session.destroy();
      expect(listeners.has("devicechange")).toBe(false);
    });
  });

  it("takes a peer's word for whether they are muted", () => {
    const { session } = makeSession("A");
    session.syncParticipants(["A", "B"]);
    expect(session.state().peers[0]!.micMuted).toBe(false);

    void session.handleSignal("B", { kind: "media", camera: false, screen: false, muted: true });
    expect(session.state().peers[0]!.micMuted).toBe(true);

    // A client from before the field simply does not say, and is not muted.
    void session.handleSignal("B", { kind: "media", camera: false, screen: false });
    expect(session.state().peers[0]!.micMuted).toBe(false);
    session.destroy();
  });
});

describe("the call log", () => {
  /** A session given call settings, a way to read them again, and a place to report to. */
  function loggedSession(
    selfId: ID,
    servers: RTCIceServer[] = [{ urls: "stun:stun.example.com:3478" }],
    fresh: RTCIceServer[] = servers,
  ) {
    const sent: { to: ID; signal: HuddleSignal }[] = [];
    const reports: { peer: ID; report: CallReport }[] = [];
    const refreshConfig = vi.fn(async () => ({ iceServers: fresh }));
    const session = new HuddleSession(
      "C1",
      selfId,
      { send: (msg) => sent.push({ to: msg.to, signal: msg.signal }) },
      { iceServers: servers },
      { refreshConfig, onReport: (peer, report) => reports.push({ peer, report }) },
    );
    return { session, sent, reports, refreshConfig };
  }
  const line = (session: HuddleSession) => session.log.map((l) => l.text).join("\n");
  const route = (type: string, protocol = "udp") =>
    `candidate:1 1 ${protocol} 2122260223 198.51.100.7 54321 typ ${type} generation 0`;

  afterEach(() => vi.useRealTimers());

  it("says each step of the setup, with the kinds of route and never an address", async () => {
    const { session } = loggedSession("A");
    session.syncParticipants(["A", "B"]);
    await flush();
    const pc = FakePeerConnection.instances[0]!;
    pc.onicecandidate?.({
      candidate: { candidate: route("srflx"), type: "srflx", protocol: "udp", sdpMid: "0" },
    });
    pc.onicecandidate?.({ candidate: null });
    await session.handleSignal("B", { kind: "answer", sdp: "answer" });
    pc.signalingState = "have-local-offer";
    await session.handleSignal("B", { kind: "answer", sdp: "answer" });
    // Many of a kind, as from a machine with many interfaces, are named once.
    for (let i = 0; i < 3; i++)
      await session.handleSignal("B", {
        kind: "ice",
        candidate: { candidate: route("relay", "tcp"), sdpMid: "0", sdpMLineIndex: 0 },
      });
    expect(session.log.map((l) => l.text)).toEqual([
      "Call settings: 1 STUN and 0 TURN servers.",
      "Connecting to them; this side starts the call setup.",
      "Sent the call setup.",
      "Found a route here: srflx over udp.",
      "Found every route here: 1 srflx.",
      "Ignored an answer that came while stable.",
      "Received their answer.",
      "Route from them: relay over tcp.",
    ]);
    expect(session.log.slice(1).every((l) => l.peerId === "B")).toBe(true);
    expect(line(session)).not.toContain("198.51.100.7");
    session.destroy();
    expect(session.log.at(-1)?.text).toBe("Left the huddle.");
  });

  it("writes down a call setup it could not use, rather than losing it", async () => {
    const { session } = loggedSession("Z");
    session.syncParticipants(["Z", "B"]);
    vi.spyOn(FakePeerConnection.prototype, "setRemoteDescription").mockRejectedValueOnce(
      new DOMException("Failed to parse SessionDescription.", "OperationError"),
    );
    await session.handleSignal("B", { kind: "offer", sdp: "garbled" });
    expect(line(session)).toContain(
      "Could not use their offer: OperationError: Failed to parse SessionDescription.",
    );
    session.destroy();
  });

  it.each([
    ["the setup never finished", "signalling", [] as string[], [] as string[], true],
    ["no servers and no public route here", "no_ice_servers", ["host"], ["srflx"], false],
    ["servers, and still no public route here", "no_public_route_here", ["host"], ["srflx"], true],
    [
      "only their own network's routes from them",
      "no_public_route_there",
      ["srflx"],
      ["host"],
      true,
    ],
    ["public routes on both sides that do not meet", "needs_relay", ["srflx"], ["srflx"], true],
    ["a relay that still did not work", "unknown", ["relay"], ["srflx"], true],
  ] as const)(
    "after a while without connecting, says why: %s",
    async (_name, cause, here, there, withServers) => {
      vi.useFakeTimers();
      const { session, reports } = loggedSession(
        "Z",
        withServers ? [{ urls: "stun:stun.example.com" }] : [],
      );
      session.syncParticipants(["Z", "B"]);
      const pc = FakePeerConnection.instances[0]!;
      if (cause !== "signalling") await session.handleSignal("B", { kind: "offer", sdp: "o" });
      for (const type of here)
        pc.onicecandidate?.({ candidate: { candidate: route(type), sdpMid: "0" } });
      for (const type of there)
        await session.handleSignal("B", {
          kind: "ice",
          candidate: { candidate: route(type), sdpMid: "0", sdpMLineIndex: 0 },
        });
      expect(session.state().peers[0]!.trouble).toBeNull();
      await vi.advanceTimersByTimeAsync(STALL_MS);
      expect(session.state().peers[0]!.trouble).toBe(cause);
      expect(reports[0]).toMatchObject({
        peer: "B",
        report: { outcome: "stalled", cause, retries: 0 },
      });
      expect(line(session)).toContain(
        `Still not connected after ${STALL_MS / 1000} s (routes here:`,
      );
      session.destroy();
    },
  );

  it("tries again with the call settings read afresh, twice, and then leaves it to the person", async () => {
    vi.useFakeTimers();
    const fresh = [{ urls: "turn:turn.example.com", username: "u", credential: "c" }];
    const { session, refreshConfig } = loggedSession("A", [], fresh);
    session.syncParticipants(["A", "B"]);
    await vi.advanceTimersByTimeAsync(0);
    const pc = FakePeerConnection.instances[0]!;
    expect(pc.offerOptions).toEqual([undefined]);

    pc.become("failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshConfig).toHaveBeenCalledOnce();
    expect(pc.configs).toEqual([{ iceServers: fresh }]);
    expect(pc.offerOptions.at(-1)).toEqual({ iceRestart: true });
    expect(line(session)).toContain("Read the call settings again: 0 STUN and 1 TURN server.");
    expect(line(session)).toContain("Trying again (1 of 2) with fresh routes.");

    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(pc.offerOptions).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(pc.offerOptions).toHaveLength(3);
    expect(line(session)).toContain(
      "Not trying again. Leaving and rejoining the huddle starts afresh.",
    );
    session.destroy();
  });

  it("leaves the trying again to the side that starts the setup", async () => {
    vi.useFakeTimers();
    const { session, sent, refreshConfig } = loggedSession("Z");
    session.syncParticipants(["Z", "B"]);
    await session.handleSignal("B", { kind: "offer", sdp: "o" });
    const offers = () => sent.filter((s) => s.signal.kind === "offer").length;
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(refreshConfig).toHaveBeenCalledOnce();
    expect(offers()).toBe(0);
    expect(line(session)).toContain("Waiting for them to try again");
    session.destroy();
  });

  it("says the route a connection settled on, and reports it to the host", async () => {
    const { session, reports } = loggedSession("A");
    session.syncParticipants(["A", "B"]);
    await flush();
    const pc = FakePeerConnection.instances[0]!;
    pc.stats = new Map<string, Record<string, unknown>>([
      ["T1", { id: "T1", type: "transport", selectedCandidatePairId: "P1" }],
      [
        "P1",
        {
          id: "P1",
          type: "candidate-pair",
          localCandidateId: "L1",
          remoteCandidateId: "R1",
          currentRoundTripTime: 0.042,
        },
      ],
      ["L1", { id: "L1", type: "local-candidate", candidateType: "srflx", protocol: "udp" }],
      ["R1", { id: "R1", type: "remote-candidate", candidateType: "prflx" }],
    ]);
    pc.become("connected");
    await flush();
    expect(session.state().peers[0]).toMatchObject({ connected: true, trouble: null });
    expect(line(session)).toMatch(
      /Connected after \d+\.\d s: srflx here, prflx there, over udp, 42 ms round trip\./,
    );
    expect(reports).toEqual([
      {
        peer: "B",
        report: expect.objectContaining({
          outcome: "connected",
          route: { local: "srflx", remote: "prflx", protocol: "udp" },
          iceServers: { stun: 1, turn: 0 },
        }),
      },
    ]);
    expect(reports[0]!.report).not.toHaveProperty("cause");
    session.destroy();
  });
});

describe("testing a microphone before a call (CALL-01)", () => {
  const mic = () => ({ kind: "audio", label: "USB Headset", stop: vi.fn() });

  /** Just enough Web Audio to measure: the samples the analyser hands back. */
  function fakeAudio(samples: number) {
    const close = vi.fn(() => Promise.resolve());
    class FakeAudioContext {
      resume = () => Promise.resolve();
      close = close;
      createAnalyser() {
        return {
          fftSize: 0,
          getByteTimeDomainData: (into: Uint8Array) => into.fill(samples),
        };
      }
      createMediaStreamSource() {
        return { connect() {} };
      }
    }
    g.AudioContext = FakeAudioContext;
    return { close };
  }

  it("says which microphone it opened and how loud it is, until stopped", async () => {
    vi.useFakeTimers();
    try {
      const { close } = fakeAudio(128 + 64);
      const track = mic();
      vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(
        new FakeMediaStream([track]) as unknown as MediaStream,
      );
      const levels: number[] = [];
      const test = await testMicrophone((level) => levels.push(level));
      expect(test).toMatchObject({ label: "USB Headset", metered: true });
      vi.advanceTimersByTime(250);
      expect(levels).toEqual([0.5, 0.5]);

      test.stop();
      test.stop();
      expect(track.stop).toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(500);
      expect(levels).toHaveLength(2);
    } finally {
      delete g.AudioContext;
      vi.useRealTimers();
    }
  });

  it("opens the microphone without a meter where nothing can measure it", async () => {
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(
      new FakeMediaStream([mic()]) as unknown as MediaStream,
    );
    const test = await testMicrophone(() => {});
    expect(test.metered).toBe(false);
    test.stop();
  });

  it("rejects as the browser does, for captureFailure to word", async () => {
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockRejectedValue(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    await expect(testMicrophone(() => {})).rejects.toMatchObject({ name: "NotAllowedError" });
  });
});

describe("choosing the microphone and camera (Voice & video)", () => {
  type Track = {
    kind: string;
    enabled: boolean;
    stop: () => void;
    onended?: (() => void) | null;
    getSettings?: () => { deviceId?: string };
  };
  const track = (kind: string, deviceId = ""): Track => ({
    kind,
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ deviceId }),
  });
  const stream = (t: Track) => new FakeMediaStream([t]) as unknown as MediaStream;

  /** A call with one peer, its microphone and choices as given. */
  async function inCall(first: Track, options: ConstructorParameters<typeof HuddleSession>[4]) {
    const sent: { to: ID; signal: HuddleSignal }[] = [];
    const session = new HuddleSession(
      "C1",
      "A",
      { send: (msg) => sent.push({ to: msg.to, signal: msg.signal }) },
      undefined,
      options,
    );
    const ask = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(stream(first));
    await session.startLocalAudio();
    session.syncParticipants(["A", "B"]);
    await flush();
    return { session, sent, ask, pc: FakePeerConnection.instances[0]! };
  }

  /** What Chromium rejects with when the device asked for exactly is not connected. */
  const unplugged = () =>
    Object.assign(new Error(""), { name: "OverconstrainedError", constraint: "deviceId" });

  it("opens the chosen microphone, exactly and cleaned up as chosen", async () => {
    const { session, ask } = await inCall(track("audio"), {
      microphone: { deviceId: "usb-mic", noiseSuppression: false },
    });
    // Chromium opens the default for a device asked for any other way.
    expect(ask.mock.calls[0]![0]).toEqual({
      audio: {
        channelCount: 1,
        deviceId: { exact: "usb-mic" },
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
      },
      video: false,
    });
    session.destroy();
  });

  it("joins on the default microphone when the chosen one is not connected", async () => {
    const session = new HuddleSession("C1", "A", { send: () => {} }, undefined, {
      microphone: { deviceId: "headset", echoCancellation: false },
    });
    const ask = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockRejectedValueOnce(unplugged())
      .mockResolvedValue(stream(track("audio", "default")));

    await session.startLocalAudio();

    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1]![0]).toEqual({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    expect(session.log.map((l) => l.text)).toContain(
      "The chosen microphone is not connected; using the system's default.",
    );
    session.destroy();
  });

  it("does not open the default in place of a chosen microphone that is there but will not start", async () => {
    const session = new HuddleSession("C1", "A", { send: () => {} }, undefined, {
      microphone: { deviceId: "headset" },
    });
    const ask = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockRejectedValueOnce(new DOMException("busy", "NotReadableError"));

    await expect(session.startLocalAudio()).rejects.toMatchObject({ name: "NotReadableError" });
    expect(ask).toHaveBeenCalledTimes(1);
    session.destroy();
  });

  it("turns on the default camera when the chosen one is not connected", async () => {
    const { session, ask, pc } = await inCall(track("audio"), { cameraId: "desk" });
    const builtIn = track("video", "built-in");
    ask.mockRejectedValueOnce(unplugged()).mockResolvedValueOnce(stream(builtIn));

    await session.toggleCamera();

    expect(ask.mock.calls[1]![0]).toMatchObject({ video: { deviceId: { exact: "desk" } } });
    expect((ask.mock.calls[2]![0] as { video: MediaTrackConstraints }).video).not.toHaveProperty(
      "deviceId",
    );
    expect(pc.transceivers[1]!.sender.track).toBe(builtIn);
    expect(session.log.map((l) => l.text)).toContain(
      "The chosen camera is not connected; using the system's default.",
    );
    session.destroy();
  });

  it("changes the microphone mid-call for everyone, without a new offer, muted as it was", async () => {
    const old = track("audio", "built-in");
    const { session, sent, ask, pc } = await inCall(old, {});
    session.toggleMic();
    sent.length = 0;
    const next = track("audio", "usb-mic");
    ask.mockResolvedValueOnce(stream(next));

    await session.setMicrophone({ deviceId: "usb-mic", echoCancellation: false });

    // Asked for exactly: a choice made just now that will not open says so.
    expect(ask.mock.calls[1]![0]).toMatchObject({
      audio: { deviceId: { exact: "usb-mic" }, echoCancellation: false },
    });
    expect(pc.transceivers[0]!.sender.track).toBe(next);
    expect(old.stop).toHaveBeenCalled();
    expect(next.enabled).toBe(false);
    expect(sent.some((m) => m.signal.kind === "offer")).toBe(false);
    expect(sent.at(-1)!.signal).toMatchObject({ kind: "media", muted: true });
    // Losing it later asks for the chosen one again before the default.
    next.onended!();
    await flush();
    expect(ask.mock.calls[2]![0]).toMatchObject({ audio: { deviceId: { exact: "usb-mic" } } });
    session.destroy();
  });

  it("keeps the microphone it has when the chosen one will not start", async () => {
    const old = track("audio");
    const { session, ask, pc } = await inCall(old, {});
    ask.mockRejectedValueOnce(new DOMException("busy", "NotReadableError"));

    await expect(session.setMicrophone({ deviceId: "busy-mic" })).rejects.toMatchObject({
      name: "NotReadableError",
    });
    expect(pc.transceivers[0]!.sender.track).toBe(old);
    expect(old.stop).not.toHaveBeenCalled();
    expect(session.log.at(-1)!.text).toMatch(/chosen microphone did not start/);
    session.destroy();
  });

  it("keeps only the newest of two choices made in quick succession", async () => {
    const { session, ask, pc } = await inCall(track("audio"), {});
    let finishFirst!: (s: MediaStream) => void;
    ask.mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)));
    const second = track("audio", "second");
    ask.mockResolvedValueOnce(stream(second));
    const first = track("audio", "first");

    const slow = session.setMicrophone({ deviceId: "first" });
    await session.setMicrophone({ deviceId: "second" });
    finishFirst(stream(first));
    await slow;

    expect(pc.transceivers[0]!.sender.track).toBe(second);
    expect(first.stop).toHaveBeenCalled();
    session.destroy();
  });

  it("changes a camera that is on in place, and keeps a choice for one that is off", async () => {
    const { session, ask, pc } = await inCall(track("audio"), { cameraId: "front" });
    const front = track("video", "front");
    ask.mockResolvedValueOnce(stream(front));
    await session.toggleCamera();
    expect(ask.mock.calls[1]![0]).toMatchObject({
      video: { deviceId: { exact: "front" }, resizeMode: "crop-and-scale", width: { max: 1280 } },
      audio: false,
    });
    expect(pc.transceivers[1]!.sender.track).toBe(front);

    const desk = track("video", "desk");
    ask.mockResolvedValueOnce(stream(desk));
    await session.setCamera("desk");
    expect(ask.mock.calls[2]![0]).toMatchObject({ video: { deviceId: { exact: "desk" } } });
    expect(pc.transceivers[1]!.sender.track).toBe(desk);
    expect(front.stop).toHaveBeenCalled();
    expect(session.state().localCameraStream?.getVideoTracks()[0]).toBe(desk);
    // The one already showing is not opened twice.
    await session.setCamera("desk");
    expect(ask).toHaveBeenCalledTimes(3);

    await session.toggleCamera();
    await session.setCamera("front");
    expect(ask).toHaveBeenCalledTimes(3);
    ask.mockResolvedValueOnce(stream(track("video", "front")));
    await session.toggleCamera();
    expect(ask.mock.calls[3]![0]).toMatchObject({ video: { deviceId: { exact: "front" } } });
    session.destroy();
  });

  it("leaves the camera as it was when the chosen one will not start", async () => {
    const { session, ask, pc } = await inCall(track("audio"), {});
    const front = track("video", "front");
    ask.mockResolvedValueOnce(stream(front));
    await session.toggleCamera();
    ask.mockRejectedValueOnce(new DOMException("gone", "NotFoundError"));

    await expect(session.setCamera("unplugged")).rejects.toMatchObject({ name: "NotFoundError" });
    expect(pc.transceivers[1]!.sender.track).toBe(front);
    expect(front.stop).not.toHaveBeenCalled();
    expect(session.cameraOn).toBe(true);
    session.destroy();
  });

  describe("a camera that is busy while another is held (a virtual camera over the webcam)", () => {
    const busy = () => new DOMException("Could not start video source", "NotReadableError");
    async function sending(previous: Track) {
      const call = await inCall(track("audio"), {});
      call.ask.mockResolvedValueOnce(stream(previous));
      await call.session.toggleCamera();
      return call;
    }

    it("lets go of the one it has and tries again", async () => {
      const webcam = track("video", "webcam");
      const { session, ask, pc } = await sending(webcam);
      const virtual = track("video", "virtual");
      ask.mockRejectedValueOnce(busy()).mockResolvedValueOnce(stream(virtual));

      await session.setCamera("virtual");
      expect(webcam.stop).toHaveBeenCalled();
      expect(pc.transceivers[1]!.sender.track).toBe(virtual);
      expect(session.cameraOn).toBe(true);
      expect(session.log.map((l) => l.text)).toContain(
        "The chosen camera was busy; trying again with this one closed.",
      );
      session.destroy();
    });

    it("puts the old one back when the chosen one still will not start", async () => {
      const webcam = track("video", "webcam");
      const { session, ask, pc } = await sending(webcam);
      const again = track("video", "webcam");
      ask
        .mockRejectedValueOnce(busy())
        .mockRejectedValueOnce(busy())
        .mockResolvedValueOnce(stream(again));

      await expect(session.setCamera("virtual")).rejects.toMatchObject({
        name: "NotReadableError",
      });
      expect(ask.mock.calls.at(-1)![0]).toMatchObject({ video: { deviceId: { exact: "webcam" } } });
      expect(pc.transceivers[1]!.sender.track).toBe(again);
      expect(session.cameraOn).toBe(true);
      session.destroy();
    });

    it("turns the camera off, and says so, when neither will start", async () => {
      const { session, sent, ask, pc } = await sending(track("video", "webcam"));
      ask.mockRejectedValue(busy());
      sent.length = 0;

      await expect(session.setCamera("virtual")).rejects.toMatchObject({
        name: "NotReadableError",
      });
      expect(session.cameraOn).toBe(false);
      await flush();
      expect(pc.transceivers[1]!.sender.track).toBeNull();
      expect(sent.at(-1)!.signal).toMatchObject({ kind: "media", camera: false });
      session.destroy();
    });
  });

  describe("strong noise suppression", () => {
    /** A filter that hands back `cleaned` as the microphone's sound, and can be told to fail. */
    function filter(...cleaned: Track[]) {
      const stops: ReturnType<typeof vi.fn>[] = [];
      const noiseFilter = vi.fn(async (_microphone: MediaStream) => {
        const next = cleaned.shift();
        if (!next) throw new Error("no AudioWorklet here");
        const stop = vi.fn();
        stops.push(stop);
        return { stream: stream(next), stop };
      });
      return { noiseFilter, stops };
    }

    it("sends the microphone through it, with the browser's own left off", async () => {
      const device = track("audio");
      const cleaned = track("audio");
      const { noiseFilter } = filter(cleaned);
      const { session, ask, pc } = await inCall(device, { noiseFilter });
      expect(ask.mock.calls[0]![0]).toMatchObject({ audio: { noiseSuppression: false } });
      expect((noiseFilter.mock.calls[0]![0] as unknown as FakeMediaStream).tracks).toEqual([
        device,
      ]);
      expect(pc.transceivers[0]!.sender.track).toBe(cleaned);
      expect(session.log.map((line) => line.text)).toContain("Noise suppression: strong.");
      // Muting silences what is sent, which is the cleaned sound.
      session.toggleMic();
      expect(cleaned.enabled).toBe(false);
      session.destroy();
    });

    it("cleans a microphone opened again after the device went, still muted", async () => {
      const device = track("audio");
      const { noiseFilter, stops } = filter(track("audio"), track("audio"));
      const { session, ask, pc } = await inCall(device, { noiseFilter });
      session.toggleMic();
      const replacement = track("audio");
      ask.mockResolvedValueOnce(stream(replacement));

      // The device itself ending is what says it went, not the filter's output.
      device.onended!();
      await vi.waitFor(() => expect(noiseFilter).toHaveBeenCalledTimes(2));
      await flush();
      expect(stops[0]).toHaveBeenCalled();
      expect(device.stop).toHaveBeenCalled();
      const sent = pc.transceivers[0]!.sender.track as Track;
      expect(sent).not.toBe(replacement);
      expect(sent.enabled).toBe(false);
      session.destroy();
      expect(stops[1]).toHaveBeenCalled();
      expect(replacement.stop).toHaveBeenCalled();
    });

    it("uses the browser's own when it will not start, and says why", async () => {
      const unfiltered = track("audio");
      const fallback = track("audio");
      const { noiseFilter } = filter();
      const session = new HuddleSession("C1", "A", { send: () => {} }, undefined, { noiseFilter });
      const ask = vi
        .spyOn(navigator.mediaDevices, "getUserMedia")
        .mockResolvedValueOnce(stream(unfiltered))
        .mockResolvedValueOnce(stream(fallback));
      await session.startLocalAudio();
      expect(ask.mock.calls[0]![0]).toMatchObject({ audio: { noiseSuppression: false } });
      // Opened again with the browser's suppression, rather than sent raw.
      expect(ask.mock.calls[1]![0]).toMatchObject({ audio: { noiseSuppression: true } });
      expect(unfiltered.stop).toHaveBeenCalled();
      expect(session.log.map((line) => line.text)).toContain(
        "Strong noise suppression did not start (no AudioWorklet here); using the browser's own.",
      );
      session.syncParticipants(["A", "B"]);
      await flush();
      expect(FakePeerConnection.instances[0]!.transceivers[0]!.sender.track).toBe(fallback);
      session.destroy();
    });

    it("is left out for the browser's own suppression, and for none", async () => {
      for (const [microphone, said] of [
        [{ noiseFilter: false }, "Noise suppression: the browser's own."],
        [{ noiseSuppression: false }, "Noise suppression: off."],
      ] as const) {
        const { noiseFilter } = filter(track("audio"));
        const { session, ask } = await inCall(track("audio"), { noiseFilter, microphone });
        expect(noiseFilter).not.toHaveBeenCalled();
        expect(ask.mock.calls[0]![0]).toMatchObject({
          audio: { noiseSuppression: microphone.noiseSuppression ?? true },
        });
        expect(session.log.map((line) => line.text)).toContain(said);
        session.destroy();
        vi.restoreAllMocks();
        FakePeerConnection.instances = [];
      }
    });

    it("is what a microphone test plays back, and lets go of both when stopped", async () => {
      const device = { ...track("audio"), label: "USB Headset" };
      const cleaned = { ...track("audio"), label: "MediaStreamAudioDestinationNode" };
      const { noiseFilter, stops } = filter(cleaned);
      const ask = vi
        .spyOn(navigator.mediaDevices, "getUserMedia")
        .mockResolvedValue(stream(device));
      const test = await testMicrophone(() => {}, {}, noiseFilter);
      expect(ask.mock.calls[0]![0]).toMatchObject({ audio: { noiseSuppression: false } });
      expect((test.stream as unknown as FakeMediaStream).tracks).toEqual([cleaned]);
      expect(test.filtered).toBe(true);
      // Named as the microphone, not as the filter.
      expect(test.label).toBe("USB Headset");
      test.stop();
      expect(stops[0]).toHaveBeenCalled();
      expect(device.stop).toHaveBeenCalled();
    });

    it("leaves a microphone test on the browser's own when it will not start", async () => {
      const fallback = track("audio");
      const { noiseFilter } = filter();
      vi.spyOn(navigator.mediaDevices, "getUserMedia")
        .mockResolvedValueOnce(stream(track("audio")))
        .mockResolvedValueOnce(stream(fallback));
      const test = await testMicrophone(() => {}, {}, noiseFilter);
      expect((test.stream as unknown as FakeMediaStream).tracks).toEqual([fallback]);
      expect(test.filtered).toBe(false);
      test.stop();
    });
  });

  it("tests the microphone being chosen, exactly, and hands back what it hears", async () => {
    const opened = stream(track("audio", "usb-mic"));
    const ask = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(opened);
    const test = await testMicrophone(() => {}, { deviceId: "usb-mic", autoGainControl: false });
    expect(ask.mock.calls[0]![0]).toMatchObject({
      audio: { deviceId: { exact: "usb-mic" }, autoGainControl: false },
    });
    expect(test.stream).toBe(opened);
    test.stop();
  });
});
