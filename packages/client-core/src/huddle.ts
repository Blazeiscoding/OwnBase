import {
  CANDIDATE_KINDS,
  shouldInitiateOffer,
  type CallCause,
  type CallReport,
  type CandidateCounts,
  type CandidateKind,
  type HuddleSignal,
  type ID,
} from "@slackoss/protocol";
import { CALL_CAUSES, type CallLogLine } from "./callLog.js";
import {
  cameraConstraints,
  microphoneConstraints,
  openSaved,
  wantsNoiseFilter,
  type FilteredMicrophone,
  type MicrophoneSettings,
  type NoiseFilter,
} from "./devices.js";

export type { CallLogLine } from "./callLog.js";

export interface HuddlePeer {
  userId: ID;
  /** Their microphone. Always attach it, even when there is no video. */
  audioStream: MediaStream | null;
  /** Their camera, or null while it is off. */
  cameraStream: MediaStream | null;
  /** What they are sharing, or null while they are not. */
  screenStream: MediaStream | null;
  /** True once the connection is carrying media. */
  connected: boolean;
  /** Their microphone is off, as they reported it. */
  micMuted: boolean;
  /** They are talking right now. */
  speaking: boolean;
  /**
   * Why the connection has not come up, once it has taken long enough to
   * ask; null while it is fine or still within that time. See `CALL_CAUSES`.
   */
  trouble?: CallCause | null;
}

/**
 * How sharp and how smooth a shared screen is sent: at most this many lines
 * of picture, at most this many frames a second. Each viewer is encoded
 * separately in a mesh, so even a 4K screen is sent at no more than 1080p.
 * That is still sharp text.
 */
export interface ScreenShareQuality {
  height: 720 | 1080;
  frameRate: 15 | 30 | 60;
}

export const SCREEN_SHARE_QUALITY: ScreenShareQuality = { height: 1080, frameRate: 15 };

/** How many lines a call keeps; the oldest go first. */
const CALL_LOG_LIMIT = 400;
/** How long a connection may take before the log says why not, and it tries again. */
export const STALL_MS = 15_000;
/** How many times one connection tries again before leaving it to the person. */
const MAX_RETRIES = 2;

/** What a session is told beyond where to send signals. */
export interface HuddleSessionOptions {
  /** Reads the workspace's call settings again, for a connection trying again. */
  refreshConfig?: () => Promise<RTCConfiguration>;
  /** Hears how each connection went, for the host's call log. */
  onReport?: (peerId: ID, report: CallReport) => void;
  /** The microphone chosen in Voice & video settings, and how to process it. */
  microphone?: MicrophoneSettings;
  /** The camera chosen there; missing for the system's default. */
  cameraId?: string;
  /** Strong noise suppression, where the app has it, for when it is chosen. */
  noiseFilter?: NoiseFilter;
}

/** A microphone as the call sends it: the device's own sound, or that sound cleaned. */
interface MicrophoneFeed {
  /** What everyone hears. */
  stream: MediaStream;
  /** The device itself, whose ending means it went: unplugged, or its permission. */
  device: MediaStreamTrack | undefined;
  /** Closes the device and anything made from it. */
  stop(): void;
}

export interface HuddleState {
  channelId: ID;
  micMuted: boolean;
  cameraOn: boolean;
  sharingScreen: boolean;
  /** Your own camera, for the self-view tile. */
  localCameraStream: MediaStream | null;
  /** Your own share, so you can see what everyone else is seeing. */
  localScreenStream: MediaStream | null;
  /** You are talking right now. */
  speaking: boolean;
  /**
   * Your microphone stopped, unplugged or its permission taken back, and no
   * other could be had: nobody can hear you until one is (CALL-01).
   */
  micLost: boolean;
  peers: HuddlePeer[];
}

/** How the huddle reaches the server; supplied by WorkspaceClient. */
export interface HuddleTransport {
  send: (msg: { type: "huddle.signal"; channelId: ID; to: ID; signal: HuddleSignal }) => void;
}

/**
 * Loud enough to count as talking, and how long a tile keeps saying so after
 * the last loud sample. Without the hold the indicator strobes in the gaps
 * between syllables, which is worse than not having it.
 */
const SPEAKING_LEVEL = 0.02;
const SPEAKING_HOLD_MS = 500;
const LEVEL_POLL_MS = 120;

/**
 * How loud a peer's last audio packet was, read from the RTP header extension
 * the browser already parses for us. One number per participant per poll, and
 * no Web Audio graph per peer — which is the version that would show up in a
 * six-person call's CPU.
 */
function receivedLevel(peer: Peer): number {
  const receiver = peer.audioTx?.receiver;
  if (!receiver?.getSynchronizationSources) return 0;
  let loudest = 0;
  for (const source of receiver.getSynchronizationSources()) {
    loudest = Math.max(loudest, source.audioLevel ?? 0);
  }
  return loudest;
}

/**
 * One connection per participant, with its three media slots fixed up front.
 *
 * The offerer declares microphone, camera, screen in that order. The answerer
 * adopts those slots from the offer. Subsequent camera/screen changes use
 * replaceTrack without renegotiation; incoming tracks use the negotiated order.
 */
export class HuddleSession {
  private destroyed = false;
  private acquiringCamera = false;
  private acquiringScreen = false;
  private peers = new Map<ID, Peer>();
  private connected = new Set<ID>();
  private mic: MicrophoneFeed | null = null;
  /** The person's latest choice, even while the microphone is being replaced. */
  private muted = false;
  private micLost = false;
  private recoveringMic: Promise<boolean> | null = null;
  /** The newest microphone or camera choice, so an older one finishing late is dropped. */
  private micChoice = 0;
  private cameraChoice = 0;
  private microphone: MicrophoneSettings;
  private cameraId: string | undefined;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private localCameraStream: MediaStream | null = null;
  private localScreenStream: MediaStream | null = null;
  /** Who is currently shown as talking, and when each was last loud. */
  private speaking = new Set<ID>();
  private spokeAt = new Map<ID, number>();
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelSamples: Uint8Array<ArrayBuffer> | null = null;
  /** Every step of this call, for whoever has to work out what went wrong. */
  readonly log: CallLogLine[] = [];

  /** Called whenever anything the UI renders has changed. */
  onChange: (() => void) | null = null;

  constructor(
    readonly channelId: ID,
    private selfId: ID,
    private transport: HuddleTransport,
    private rtcConfig: RTCConfiguration = { iceServers: [] },
    private options: HuddleSessionOptions = {},
  ) {
    this.microphone = options.microphone ?? {};
    this.cameraId = options.cameraId;
    this.note(`Call settings: ${describeServers(rtcConfig)}.`);
  }

  /** Adds a line to the call log. */
  note(text: string, peerId?: ID): void {
    this.log.push({ at: Date.now(), ...(peerId ? { peerId } : {}), text });
    if (this.log.length > CALL_LOG_LIMIT) this.log.splice(0, this.log.length - CALL_LOG_LIMIT);
  }

  /**
   * Grabs the microphone. Rejects as the browser does if permission is
   * refused or no device exists, and with `NotSupportedError` where there is
   * no way to ask (an insecure page); `captureFailure` words each for people.
   *
   * `muted` starts it off, for someone who chose to join huddles that way:
   * nothing they say is sent until they turn it on, and each peer is told so
   * as it connects (CALL-01).
   */
  async startLocalAudio(muted = false): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw unsupported("microphone");
    this.muted = muted;
    let feed: MicrophoneFeed;
    try {
      feed = await this.openMicrophone(this.microphone, false);
    } catch (err) {
      this.note(`The microphone did not start: ${describeError(err)}.`);
      throw err;
    }
    this.note(`The microphone started${muted ? ", muted" : ""}.`);
    if (this.destroyed) {
      feed.stop();
      return;
    }
    this.adoptMicrophone(feed);
    this.startLevelPolling();
  }

  /**
   * Opens the microphone with these settings, through the strong noise
   * filter when it is chosen and the app has one. A filter that will not
   * start costs the call nothing: the microphone opens again with the
   * browser's own suppression, and the call log says so. A saved microphone
   * that is not connected opens the default; one `chosenNow` does not.
   */
  private async openMicrophone(
    settings: MicrophoneSettings,
    chosenNow: boolean,
  ): Promise<MicrophoneFeed> {
    const filter = wantsNoiseFilter(settings) ? this.options.noiseFilter : undefined;
    const plain = (stream: MediaStream): MicrophoneFeed => ({
      stream,
      device: stream.getAudioTracks()[0],
      stop: () => stream.getTracks().forEach((track) => track.stop()),
    });
    let missing = false;
    const open = (filtered: boolean) => {
      const ask = (deviceId: string | undefined) =>
        navigator.mediaDevices.getUserMedia(
          microphoneConstraints({ ...settings, deviceId }, filtered),
        );
      if (chosenNow) return ask(settings.deviceId);
      return openSaved(missing ? undefined : settings.deviceId, ask, () => {
        missing = true;
        this.note("The chosen microphone is not connected; using the system's default.");
      });
    };
    const device = await open(!!filter);
    if (!filter) {
      this.note(
        settings.noiseSuppression === false
          ? "Noise suppression: off."
          : "Noise suppression: the browser's own.",
      );
      return plain(device);
    }
    try {
      const filtered = await filter(device);
      this.note("Noise suppression: strong.");
      return {
        stream: filtered.stream,
        device: device.getAudioTracks()[0],
        stop: () => {
          filtered.stop();
          device.getTracks().forEach((track) => track.stop());
        },
      };
    } catch (err) {
      device.getTracks().forEach((track) => track.stop());
      this.note(
        `Strong noise suppression did not start (${describeError(err)}); using the browser's own.`,
      );
      return plain(await open(false));
    }
  }

  /** What everyone hears from this side. */
  private get localStream(): MediaStream | null {
    return this.mic?.stream ?? null;
  }

  /** Makes this the microphone everyone hears, and watches for it stopping. */
  private adoptMicrophone(feed: MicrophoneFeed): void {
    const track = feed.stream.getAudioTracks()[0];
    if (track) track.enabled = !this.muted;
    // Stopping a track ourselves does not end it this way, so this is only
    // ever the device going, or its permission.
    if (feed.device) feed.device.onended = () => void this.recoverMicrophone();
    this.mic = feed;
    this.micLost = false;
    void this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    this.watchLocalLevel(feed.stream);
  }

  /** Closes the microphone in use, without taking that for the device going. */
  private releaseMicrophone(): void {
    if (this.mic?.device) this.mic.device.onended = null;
    this.mic?.stop();
  }

  /**
   * The microphone stopped: unplugged, or its permission taken back. Asks for
   * one again, the chosen one if it is still there and otherwise whatever the
   * system now has as its default, and sends
   * it to everyone in place of the old one, muted if it was (CALL-01). With
   * none to be had the huddle says so, tells the others this side is muted
   * rather than leaving them to wonder at the silence, and tries again when a
   * device is plugged in. Resolves whether there is a microphone now.
   */
  async recoverMicrophone(): Promise<boolean> {
    if (this.destroyed || !this.mic) return false;
    if (this.recoveringMic) return this.recoveringMic;
    const attempt = this.replaceMicrophone();
    this.recoveringMic = attempt;
    void attempt.finally(() => {
      if (this.recoveringMic === attempt) this.recoveringMic = null;
    });
    return attempt;
  }

  private async replaceMicrophone(): Promise<boolean> {
    try {
      const feed = await this.openMicrophone(this.microphone, false);
      if (this.destroyed) {
        feed.stop();
        return false;
      }
      this.releaseMicrophone();
      this.adoptMicrophone(feed);
      this.stopWaitingForMicrophone();
      await this.sendMicrophone(feed);
      return true;
    } catch {
      if (this.destroyed) return false;
      this.micLost = true;
      this.waitForMicrophone();
      return false;
    } finally {
      this.announceMedia();
      this.onChange?.();
    }
  }

  /**
   * Changes the microphone, or how its sound is processed, mid-call. The new
   * one opens before the old one closes, so a device that will not start
   * leaves everyone still hearing the old one, and this rejects as
   * `startLocalAudio` does. Once open it goes to everyone in the old one's
   * place, muted if that was.
   */
  async setMicrophone(settings: MicrophoneSettings): Promise<void> {
    if (this.destroyed) return;
    const choice = ++this.micChoice;
    if (!this.mic) {
      this.microphone = settings;
      return;
    }
    let feed: MicrophoneFeed;
    try {
      feed = await this.openMicrophone(settings, true);
    } catch (err) {
      this.note(`The chosen microphone did not start: ${describeError(err)}.`);
      throw err;
    }
    if (this.destroyed || choice !== this.micChoice) {
      feed.stop();
      return;
    }
    this.microphone = settings;
    this.note("Changed to the chosen microphone.");
    this.releaseMicrophone();
    this.adoptMicrophone(feed);
    this.stopWaitingForMicrophone();
    await this.sendMicrophone(feed);
    this.announceMedia();
    this.onChange?.();
  }

  /** Sends this microphone to everyone in place of the one before. */
  private async sendMicrophone(feed: MicrophoneFeed): Promise<void> {
    const track = feed.stream.getAudioTracks()[0] ?? null;
    await Promise.all(
      [...this.peers.values()].map((peer) =>
        peer.audioTx?.sender.replaceTrack(track).catch(() => {}),
      ),
    );
  }

  private readonly onDeviceChange = () => void this.recoverMicrophone();

  private waitForMicrophone(): void {
    navigator.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);
  }

  private stopWaitingForMicrophone(): void {
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
  }

  /**
   * Your own microphone level, so your tile lights up like everyone else's.
   * A muted track carries silence, so muting stops this on its own.
   */
  private watchLocalLevel(stream: MediaStream): void {
    const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) return;
    try {
      const context = new Ctx();
      void context.resume().catch(() => {});
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      this.audioContext = context;
      this.analyser = analyser;
      this.levelSamples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    } catch {
      // Showing a level is a nicety. Never let it cost someone the call.
    }
  }

  private localLevel(): number {
    if (!this.analyser || !this.levelSamples) return 0;
    return peakLevel(this.analyser, this.levelSamples);
  }

  private startLevelPolling(): void {
    if (this.levelTimer || this.destroyed) return;
    this.levelTimer = setInterval(() => this.sampleLevels(), LEVEL_POLL_MS);
  }

  /** One pass over every participant's loudness, published only on a change. */
  private sampleLevels(): void {
    const now = Date.now();
    if (this.localLevel() > SPEAKING_LEVEL) this.spokeAt.set(this.selfId, now);
    for (const [userId, peer] of this.peers) {
      if (receivedLevel(peer) > SPEAKING_LEVEL) this.spokeAt.set(userId, now);
    }

    let changed = false;
    const present = new Set<ID>([this.selfId, ...this.peers.keys()]);
    for (const userId of present) {
      const talking = now - (this.spokeAt.get(userId) ?? 0) < SPEAKING_HOLD_MS;
      if (talking === this.speaking.has(userId)) continue;
      if (talking) this.speaking.add(userId);
      else this.speaking.delete(userId);
      changed = true;
    }
    for (const userId of this.speaking) {
      if (present.has(userId)) continue;
      this.speaking.delete(userId);
      changed = true;
    }
    // Re-rendering the whole huddle eight times a second is exactly the stutter
    // this is meant to avoid, so only a real transition reaches the UI.
    if (changed) this.onChange?.();
  }

  get micMuted(): boolean {
    return this.muted;
  }

  toggleMic(): void {
    const track = this.localStream?.getAudioTracks()[0];
    if (this.destroyed || !track) return;
    this.muted = !this.muted;
    track.enabled = !this.muted;
    // Everyone else needs to know, or a muted person just looks silent.
    this.announceMedia();
    this.onChange?.();
  }

  get cameraOn(): boolean {
    return this.cameraTrack !== null;
  }

  get sharingScreen(): boolean {
    return this.screenTrack !== null;
  }

  state(): HuddleState {
    return {
      channelId: this.channelId,
      micMuted: this.micMuted,
      cameraOn: this.cameraOn,
      sharingScreen: this.sharingScreen,
      localCameraStream: this.localCameraStream,
      localScreenStream: this.localScreenStream,
      peers: [...this.peers.entries()].map(([userId, peer]) => ({
        userId,
        audioStream: peer.audio,
        cameraStream: peer.cameraOn ? peer.camera : null,
        screenStream: peer.screenOn ? peer.screen : null,
        connected: this.connected.has(userId),
        micMuted: peer.micMuted,
        speaking: this.speaking.has(userId),
        trouble: this.connected.has(userId) ? null : peer.trouble,
      })),
      speaking: this.speaking.has(this.selfId),
      micLost: this.micLost,
    };
  }

  /**
   * Reconciles the mesh against the room roster: dial anyone new, drop anyone
   * who left. Only one side offers, decided by id, so the two don't collide.
   */
  syncParticipants(userIds: ID[]): void {
    if (this.destroyed) return;
    const others = new Set(userIds.filter((id) => id !== this.selfId));

    for (const userId of this.peers.keys()) {
      if (!others.has(userId)) {
        this.note("They left the huddle.", userId);
        this.closePeer(userId);
      }
    }
    for (const userId of others) {
      if (this.peers.has(userId)) continue;
      this.createPeer(userId);
    }
    this.onChange?.();
  }

  private createPeer(userId: ID): Peer {
    const pc = new RTCPeerConnection(this.rtcConfig);

    // Order is the contract: both ends create these identically, so the m-lines
    // line up and each transceiver means the same thing on both sides.
    // Only the offerer creates slots. The answerer adopts the slots from the
    // remote offer; pre-creating them on both sides produces six transceivers
    // in Chromium and a receive-only answer (one-way audio).
    const initiating = shouldInitiateOffer(this.selfId, userId);
    const audioTx = initiating ? pc.addTransceiver("audio", { direction: "sendrecv" }) : null;
    const cameraTx = initiating ? pc.addTransceiver("video", { direction: "sendrecv" }) : null;
    const screenTx = initiating ? pc.addTransceiver("video", { direction: "sendrecv" }) : null;

    const peer: Peer = {
      pc,
      audioTx,
      cameraTx,
      screenTx,
      audio: null,
      camera: null,
      screen: null,
      cameraOn: false,
      screenOn: false,
      micMuted: false,
      pendingIce: [],
      initiating,
      startedAt: Date.now(),
      local: noCandidates(),
      remote: noCandidates(),
      retries: 0,
      retrying: false,
      logged: new Set(),
      trouble: null,
      stallTimer: null,
    };
    this.peers.set(userId, peer);
    this.startLevelPolling();
    this.note(
      initiating
        ? "Connecting to them; this side starts the call setup."
        : "Connecting to them; this side waits for their call setup.",
      userId,
    );
    this.watchForStall(userId, peer);

    // Whatever is already live goes out on the new connection immediately.
    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        this.note(`Found every route here: ${describeCounts(peer.local)}.`, userId);
        return;
      }
      const { kind, protocol } = candidateOf(e.candidate);
      peer.local[kind]++;
      // A machine with many network interfaces offers a dozen of a kind;
      // the first says it, and the counts come later.
      if (firstOf(peer.logged, `here ${kind} ${protocol}`))
        this.note(`Found a route here: ${kind} over ${protocol}.`, userId);
      this.transport.send({
        type: "huddle.signal",
        channelId: this.channelId,
        to: userId,
        signal: {
          kind: "ice",
          candidate: {
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid,
            sdpMLineIndex: e.candidate.sdpMLineIndex,
          },
        },
      });
    };

    pc.ontrack = (e) => {
      // A slot always exists, so a track arrives for it whether or not
      // anything is being sent. Keep the stream; whether it is worth showing
      // is what the peer's "media" signal tells us.
      const stream = new MediaStream([e.track]);
      const slot = pc.getTransceivers().indexOf(e.transceiver);
      if (slot === 1) peer.camera = stream;
      else if (slot === 2) peer.screen = stream;
      else peer.audio = stream;
      this.onChange?.();
    };

    pc.oniceconnectionstatechange = () => {
      if (this.peers.get(userId) === peer) this.note(`ICE: ${pc.iceConnectionState}.`, userId);
    };

    pc.onconnectionstatechange = () => {
      if (this.peers.get(userId) !== peer) return;
      const state = pc.connectionState;
      this.note(`Connection: ${state}.`, userId);
      if (state === "connected") {
        this.connected.add(userId);
        peer.trouble = null;
        this.stopWatching(peer);
        void this.describeRoute(userId, peer);
      } else {
        this.connected.delete(userId);
        if (state === "failed") this.troubled(userId, peer, "failed");
      }
      this.onChange?.();
    };

    // Tell them what we are sending, so someone joining a call that already
    // has video on sees it rather than an empty tile.
    this.announceMedia(userId);
    if (initiating)
      void this.attachLocalTracks(peer)
        .then(() => {
          if (!this.destroyed && this.peers.get(userId) === peer) return this.offer(userId, pc);
        })
        .catch((err) =>
          this.note(`Could not start the call setup: ${describeError(err)}.`, userId),
        );
    return peer;
  }

  /** Looks again once the connection has had time to come up. */
  private watchForStall(userId: ID, peer: Peer): void {
    this.stopWatching(peer);
    peer.stallTimer = setTimeout(() => {
      peer.stallTimer = null;
      if (this.destroyed || this.peers.get(userId) !== peer || this.connected.has(userId)) return;
      this.troubled(userId, peer, "stalled");
    }, STALL_MS);
  }

  private stopWatching(peer: Peer): void {
    if (peer.stallTimer) clearTimeout(peer.stallTimer);
    peer.stallTimer = null;
  }

  /**
   * A connection that has not come up: says why as far as this side can
   * tell, tells the host's log, and tries again with the call settings read
   * afresh, which picks up a STUN or TURN server added since joining.
   */
  private troubled(userId: ID, peer: Peer, outcome: "stalled" | "failed"): void {
    if (peer.retrying) return;
    peer.trouble = this.diagnose(peer);
    const after = Math.round((Date.now() - peer.startedAt) / 1000);
    this.note(
      `${outcome === "failed" ? "The connection failed" : `Still not connected after ${after} s`} ` +
        `(routes here: ${describeCounts(peer.local)}; from them: ${describeCounts(peer.remote)}). ` +
        CALL_CAUSES[peer.trouble],
      userId,
    );
    this.report(userId, peer, outcome);
    this.onChange?.();
    void this.retry(userId, peer);
  }

  /** Why a connection is not up, from the routes each side offered. */
  private diagnose(peer: Peer): CallCause {
    if (!peer.pc.remoteDescription) return "signalling";
    const servers = countServers(this.rtcConfig);
    const publicHere = peer.local.srflx + peer.local.relay;
    if (servers.stun + servers.turn === 0 && publicHere === 0) return "no_ice_servers";
    if (publicHere === 0) return "no_public_route_here";
    if (peer.remote.srflx + peer.remote.relay === 0) return "no_public_route_there";
    if (peer.local.relay === 0 && peer.remote.relay === 0) return "needs_relay";
    return "unknown";
  }

  private async retry(userId: ID, peer: Peer): Promise<void> {
    if (peer.retries >= MAX_RETRIES) {
      this.note("Not trying again. Leaving and rejoining the huddle starts afresh.", userId);
      return;
    }
    peer.retries++;
    peer.retrying = true;
    try {
      const config = await this.options.refreshConfig?.().catch((err: unknown) => {
        this.note(`Could not read the call settings again: ${describeError(err)}.`, userId);
        return null;
      });
      if (this.destroyed || this.peers.get(userId) !== peer) return;
      if (config) {
        this.rtcConfig = config;
        try {
          peer.pc.setConfiguration(config);
          this.note(`Read the call settings again: ${describeServers(config)}.`, userId);
        } catch (err) {
          this.note(`Could not use the call settings: ${describeError(err)}.`, userId);
        }
      }
      if (peer.initiating) {
        this.note(`Trying again (${peer.retries} of ${MAX_RETRIES}) with fresh routes.`, userId);
        await this.offer(userId, peer.pc, true);
      } else {
        this.note("Waiting for them to try again; their side starts the call setup.", userId);
      }
    } catch (err) {
      this.note(`Could not try again: ${describeError(err)}.`, userId);
    } finally {
      peer.retrying = false;
    }
    if (!this.destroyed && this.peers.get(userId) === peer && !this.connected.has(userId))
      this.watchForStall(userId, peer);
  }

  /** Says which kinds of route the connection settled on, and tells the host. */
  private async describeRoute(userId: ID, peer: Peer): Promise<void> {
    const route = await selectedRoute(peer.pc).catch(() => null);
    if (this.peers.get(userId) !== peer) return;
    const after = ((Date.now() - peer.startedAt) / 1000).toFixed(1);
    this.note(
      route
        ? `Connected after ${after} s: ${route.local} here, ${route.remote} there, over ${route.protocol}${
            route.rttMs === null ? "" : `, ${route.rttMs} ms round trip`
          }.`
        : `Connected after ${after} s.`,
      userId,
    );
    this.report(userId, peer, "connected", route ?? undefined);
  }

  private report(
    userId: ID,
    peer: Peer,
    outcome: CallReport["outcome"],
    route?: CallReport["route"],
  ): void {
    try {
      this.options.onReport?.(userId, {
        outcome,
        afterMs: Math.max(0, Date.now() - peer.startedAt),
        iceServers: countServers(this.rtcConfig),
        local: { ...peer.local },
        remote: { ...peer.remote },
        connectionState: peer.pc.connectionState ?? "unknown",
        iceConnectionState: peer.pc.iceConnectionState ?? "unknown",
        ...(route
          ? { route: { local: route.local, remote: route.remote, protocol: route.protocol } }
          : {}),
        retries: peer.retries,
        ...(outcome === "connected" ? {} : { cause: peer.trouble ?? "unknown" }),
      });
    } catch {
      // A report the host never sees is no reason to disturb the call.
    }
  }

  private async attachLocalTracks(peer: Peer): Promise<void> {
    await Promise.all([
      peer.audioTx?.sender.replaceTrack(this.localStream?.getAudioTracks()[0] ?? null),
      peer.cameraTx?.sender.replaceTrack(this.cameraTrack),
      peer.screenTx?.sender.replaceTrack(this.screenTrack),
    ]);
  }

  private async offer(userId: ID, pc: RTCPeerConnection, iceRestart = false): Promise<void> {
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await pc.setLocalDescription(offer);
    this.transport.send({
      type: "huddle.signal",
      channelId: this.channelId,
      to: userId,
      signal: { kind: "offer", sdp: offer.sdp ?? "" },
    });
    this.note("Sent the call setup.", userId);
  }

  /** Handles a relayed offer/answer/candidate from one peer. */
  async handleSignal(from: ID, signal: HuddleSignal): Promise<void> {
    if (this.destroyed) return;
    // A signal can arrive before the roster update that introduces the peer.
    let peer = this.peers.get(from);
    if (!peer) peer = this.createPeer(from);
    try {
      await this.applySignal(from, peer, signal);
    } catch (err) {
      // Said in the log rather than lost: this is the step a stuck call stopped at.
      this.note(`Could not use their ${signal.kind}: ${describeError(err)}.`, from);
    }
  }

  private async applySignal(from: ID, peer: Peer, signal: HuddleSignal): Promise<void> {
    const pc = peer.pc;
    if (signal.kind === "offer") {
      this.note("Received their call setup.", from);
      await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      const slots = pc.getTransceivers();
      peer.audioTx = slots[0] ?? null;
      peer.cameraTx = slots[1] ?? null;
      peer.screenTx = slots[2] ?? null;
      for (const slot of slots) slot.direction = "sendrecv";
      await this.attachLocalTracks(peer);
      await this.flushIce(peer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.transport.send({
        type: "huddle.signal",
        channelId: this.channelId,
        to: from,
        signal: { kind: "answer", sdp: answer.sdp ?? "" },
      });
      this.note("Sent the answer.", from);
    } else if (signal.kind === "answer") {
      // Ignore an answer that arrives when we are not expecting one.
      if (pc.signalingState !== "have-local-offer") {
        this.note(`Ignored an answer that came while ${pc.signalingState}.`, from);
        return;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      this.note("Received their answer.", from);
      await this.flushIce(peer);
    } else if (signal.kind === "media") {
      peer.cameraOn = signal.camera;
      peer.screenOn = signal.screen;
      peer.micMuted = signal.muted ?? false;
      this.onChange?.();
    } else {
      const { kind, protocol } = candidateOf(signal.candidate);
      peer.remote[kind]++;
      if (firstOf(peer.logged, `there ${kind} ${protocol}`))
        this.note(`Route from them: ${kind} over ${protocol}.`, from);
      if (!pc.remoteDescription) {
        if (peer.pendingIce.length < 128) peer.pendingIce.push(signal.candidate);
        return;
      }
      try {
        await pc.addIceCandidate(signal.candidate);
      } catch {
        // Candidates can arrive before the remote description; losing one is
        // survivable, so never let it break the call.
      }
    }
  }

  private async flushIce(peer: Peer): Promise<void> {
    for (const candidate of peer.pendingIce.splice(0)) {
      await peer.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  /** Turns the camera on or off. */
  async toggleCamera(): Promise<void> {
    if (this.destroyed || this.acquiringCamera) return;
    if (this.cameraTrack) {
      this.stopCamera();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw unsupported("camera");
    this.acquiringCamera = true;
    let stream: MediaStream;
    try {
      stream = await openSaved(
        this.cameraId,
        (id) => navigator.mediaDevices.getUserMedia(cameraConstraints(id)),
        () => this.note("The chosen camera is not connected; using the system's default."),
      );
    } finally {
      this.acquiringCamera = false;
    }
    if (this.destroyed) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    this.cameraTrack = track;
    this.localCameraStream = stream;
    track.onended = () => this.stopCamera();
    await this.publish("camera", track);
  }

  /**
   * Changes the camera. While it is on, the new one opens before the old one
   * closes, so one that will not start leaves the picture as it was and this
   * rejects; while it is off, the choice waits for it to be turned on.
   */
  async setCamera(deviceId: string | undefined): Promise<void> {
    if (this.destroyed) return;
    const choice = ++this.cameraChoice;
    const current = this.cameraTrack;
    if (!current) {
      this.cameraId = deviceId;
      return;
    }
    if (deviceId && current.getSettings?.().deviceId === deviceId) {
      this.cameraId = deviceId;
      return;
    }
    const open = (id: string | undefined) =>
      navigator.mediaDevices.getUserMedia(cameraConstraints(id));
    // Turned off, left or chosen again while a camera opened.
    const overtaken = () =>
      this.destroyed || choice !== this.cameraChoice || this.cameraTrack !== current;
    let stream: MediaStream;
    try {
      stream = await open(deviceId);
    } catch (err) {
      if (!isBusy(err) || overtaken()) {
        this.note(`The chosen camera did not start: ${describeError(err)}.`);
        throw err;
      }
      // Many cameras open only once at a time, and one built on another (a
      // virtual camera over the webcam) cannot start while that is held here.
      // Let go of this one and try again, putting it back if that fails too.
      this.note("The chosen camera was busy; trying again with this one closed.");
      const previous = current.getSettings?.().deviceId;
      current.onended = null;
      current.stop();
      try {
        stream = await open(deviceId);
      } catch (again) {
        this.note(`The chosen camera did not start: ${describeError(again)}.`);
        const restored = await openSaved(previous, open).catch(() => null);
        if (restored?.getVideoTracks()[0] && !overtaken()) await this.adoptCamera(restored);
        else {
          restored?.getTracks().forEach((t) => t.stop());
          if (this.cameraTrack === current) this.stopCamera();
        }
        throw again;
      }
    }
    if (overtaken() || !stream.getVideoTracks()[0]) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.cameraId = deviceId;
    await this.adoptCamera(stream);
  }

  /** Puts a newly opened camera in place of the one being sent, and sends it. */
  private async adoptCamera(stream: MediaStream): Promise<void> {
    const track = stream.getVideoTracks()[0]!;
    if (this.cameraTrack) {
      this.cameraTrack.onended = null;
      this.cameraTrack.stop();
    }
    this.cameraTrack = track;
    this.localCameraStream = stream;
    track.onended = () => this.stopCamera();
    await this.publish("camera", track);
  }

  private stopCamera(): void {
    if (!this.cameraTrack) return;
    this.cameraTrack.stop();
    this.cameraTrack = null;
    this.localCameraStream = null;
    void this.publish("camera", null);
  }

  /** Starts sharing the screen, at `quality`, or stops sharing it. */
  async toggleScreenShare(quality: ScreenShareQuality = SCREEN_SHARE_QUALITY): Promise<void> {
    if (this.destroyed || this.acquiringScreen) return;
    if (this.screenTrack) {
      this.stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) throw unsupported("screen");
    this.acquiringScreen = true;
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { max: (quality.height * 16) / 9 },
          height: { max: quality.height },
          frameRate: { ideal: quality.frameRate, max: quality.frameRate },
        },
        audio: false,
      });
    } finally {
      this.acquiringScreen = false;
    }
    if (this.destroyed) {
      display.getTracks().forEach((track) => track.stop());
      return;
    }
    const track = display.getVideoTracks()[0];
    if (!track) return;
    // Screen content: when bandwidth runs short, keep the resolution and drop
    // frames. Without the hint the encoder treats a screen like a camera and
    // blurs the text first. Sixty frames a second is asked for motion, a game
    // or a video, which keeps moving and softens instead.
    track.contentHint = quality.frameRate === 60 ? "motion" : "detail";
    this.screenTrack = track;
    this.localScreenStream = display;
    // Stopping from the browser's own bar must clean up too.
    track.onended = () => this.stopScreenShare();
    await this.publish("screen", track);
  }

  private stopScreenShare(): void {
    if (!this.screenTrack) return;
    this.screenTrack.stop();
    this.screenTrack = null;
    this.localScreenStream = null;
    void this.publish("screen", null);
  }

  /**
   * Pushes one slot's track to every peer. Because the transceiver was created
   * up front this needs no new offer — the track simply starts or stops
   * flowing, and the far side sees its receiver unmute or mute.
   */
  private async publish(slot: "camera" | "screen", track: MediaStreamTrack | null): Promise<void> {
    await Promise.all(
      [...this.peers.values()].map((peer) =>
        (slot === "camera" ? peer.cameraTx : peer.screenTx)?.sender
          .replaceTrack(track)
          // A peer that died mid-call must not stop the others updating.
          .catch(() => {}),
      ),
    );
    this.announceMedia();
    this.onChange?.();
  }

  /** Says which slots we are sending on, to one peer or to all of them. */
  private announceMedia(to?: ID): void {
    if (this.destroyed) return;
    const signal = {
      kind: "media" as const,
      camera: this.cameraTrack !== null,
      screen: this.screenTrack !== null,
      muted: this.micMuted || this.micLost,
    };
    for (const userId of to ? [to] : this.peers.keys()) {
      this.transport.send({
        type: "huddle.signal",
        channelId: this.channelId,
        to: userId,
        signal,
      });
    }
  }

  private closePeer(userId: ID): void {
    const peer = this.peers.get(userId);
    if (peer) this.stopWatching(peer);
    peer?.pc.close();
    this.peers.delete(userId);
    this.connected.delete(userId);
    this.speaking.delete(userId);
    this.spokeAt.delete(userId);
  }

  /** Tears down every connection and releases the camera and microphone. */
  destroy(): void {
    if (!this.destroyed) this.note("Left the huddle.");
    this.destroyed = true;
    this.stopWaitingForMicrophone();
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    this.analyser = null;
    this.levelSamples = null;
    void this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    for (const userId of [...this.peers.keys()]) this.closePeer(userId);
    this.cameraTrack?.stop();
    this.cameraTrack = null;
    this.localCameraStream = null;
    this.screenTrack?.stop();
    this.screenTrack = null;
    this.localScreenStream = null;
    this.releaseMicrophone();
    this.mic = null;
    this.onChange = null;
  }
}

/** One connection and its three fixed media slots. */
interface Peer {
  pendingIce: RTCIceCandidateInit[];
  /** This side sends the offers, by id (`shouldInitiateOffer`). */
  initiating: boolean;
  startedAt: number;
  /** Routes found here, and routes they sent, by kind. */
  local: CandidateCounts;
  remote: CandidateCounts;
  retries: number;
  retrying: boolean;
  /** Which kinds of route the log has already named, each way. */
  logged: Set<string>;
  trouble: CallCause | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
  pc: RTCPeerConnection;
  audioTx: RTCRtpTransceiver | null;
  cameraTx: RTCRtpTransceiver | null;
  screenTx: RTCRtpTransceiver | null;
  audio: MediaStream | null;
  camera: MediaStream | null;
  screen: MediaStream | null;
  /** What they told us they are sending; see the "media" signal. */
  cameraOn: boolean;
  screenOn: boolean;
  micMuted: boolean;
}

const noCandidates = (): CandidateCounts => ({ host: 0, srflx: 0, prflx: 0, relay: 0 });

/** Whether `key` is new to `seen`, adding it. */
function firstOf(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/** Which servers a configuration gives for finding routes, by kind. */
function countServers(config: RTCConfiguration): { stun: number; turn: number } {
  let stun = 0;
  let turn = 0;
  for (const server of config.iceServers ?? []) {
    for (const url of [server.urls].flat()) {
      if (/^turns?:/i.test(url)) turn++;
      else if (/^stuns?:/i.test(url)) stun++;
    }
  }
  return { stun, turn };
}

function describeServers(config: RTCConfiguration): string {
  const { stun, turn } = countServers(config);
  return `${stun} STUN and ${turn} TURN server${turn === 1 ? "" : "s"}${
    stun + turn === 0 ? " (direct routes on the same network only)" : ""
  }`;
}

function describeCounts(counts: CandidateCounts): string {
  const found = CANDIDATE_KINDS.filter((kind) => counts[kind] > 0);
  return found.length ? found.map((kind) => `${counts[kind]} ${kind}`).join(", ") : "none";
}

/**
 * A route's kind and protocol, never its address: the log is meant to be
 * shared. Read from the browser's fields, or from the candidate line itself
 * ("candidate:… 1 udp 2122260223 192.0.2.1 54321 typ srflx …").
 */
function candidateOf(candidate: {
  candidate?: string;
  type?: string | null;
  protocol?: string | null;
}): { kind: CandidateKind; protocol: "udp" | "tcp" } {
  const line = candidate.candidate ?? "";
  const type = candidate.type ?? /\btyp (\w+)/.exec(line)?.[1];
  const protocol = (candidate.protocol ?? line.split(" ")[2] ?? "").toLowerCase();
  return {
    kind: CANDIDATE_KINDS.includes(type as CandidateKind) ? (type as CandidateKind) : "host",
    protocol: protocol === "tcp" ? "tcp" : "udp",
  };
}

/** The route a connected call settled on, as the browser's statistics say. */
async function selectedRoute(
  pc: RTCPeerConnection,
): Promise<(NonNullable<CallReport["route"]> & { rttMs: number | null }) | null> {
  if (typeof pc.getStats !== "function") return null;
  type Entry = {
    type: string;
    id: string;
    selectedCandidatePairId?: string;
    selected?: boolean;
    nominated?: boolean;
    state?: string;
    localCandidateId?: string;
    remoteCandidateId?: string;
    currentRoundTripTime?: number;
    candidateType?: string;
    protocol?: string;
  };
  const entries = new Map<string, Entry>();
  (await pc.getStats()).forEach((entry: Entry) => entries.set(entry.id, entry));
  const all = [...entries.values()];
  // Chrome and Safari name the pair on the transport; Firefox marks it selected.
  const pairId = all.find(
    (e) => e.type === "transport" && e.selectedCandidatePairId,
  )?.selectedCandidatePairId;
  const pair = all.find(
    (e) =>
      e.type === "candidate-pair" &&
      (pairId ? e.id === pairId : e.selected || (e.nominated && e.state === "succeeded")),
  );
  if (!pair) return null;
  const local = entries.get(pair.localCandidateId ?? "");
  const remote = entries.get(pair.remoteCandidateId ?? "");
  const kind = (type: string | undefined): CandidateKind =>
    CANDIDATE_KINDS.includes(type as CandidateKind) ? (type as CandidateKind) : "host";
  return {
    local: kind(local?.candidateType),
    remote: kind(remote?.candidateType),
    protocol: local?.protocol === "tcp" ? "tcp" : "udp",
    rttMs:
      typeof pair.currentRoundTripTime === "number"
        ? Math.round(pair.currentRoundTripTime * 1000)
        : null,
  };
}

/** An error in a few words, for the log. */
function describeError(err: unknown): string {
  if (err instanceof Error)
    return err.name && err.name !== "Error" ? `${err.name}: ${err.message}` : err.message;
  return String(err);
}

/** A device another app, or another device built on it, is holding. */
function isBusy(err: unknown): boolean {
  const name = typeof err === "object" && err !== null && "name" in err ? err.name : "";
  return name === "NotReadableError" || name === "AbortError";
}

/** What the browser would have said, had it offered a way to ask at all. */
function unsupported(kind: string): DOMException {
  return new DOMException(`No way to reach the ${kind} here.`, "NotSupportedError");
}

/** The loudest of the latest samples, from 0 (silence) to 1. */
function peakLevel(analyser: AnalyserNode, samples: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(samples);
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
  return peak / 128;
}

/** A microphone opened only to hear whether it works (CALL-01). */
export interface MicrophoneTest {
  /** The device's name, where the browser gives one; empty otherwise. */
  label: string;
  /** What it hears, for playing back to the person testing it. */
  stream: MediaStream;
  /** False where the browser cannot measure sound, so no level will come. */
  metered: boolean;
  /** Whether what it hears went through the strong noise filter. */
  filtered: boolean;
  /** Closes the microphone. Safe to call more than once. */
  stop(): void;
}

/**
 * Opens the microphone the way a huddle would with the settings being tried,
 * through the strong noise filter when it is chosen, and reports how loud it
 * is several times a second, until stopped, so someone can check it before a
 * call and hear what others would. Nothing is sent anywhere. Rejects as
 * `startLocalAudio` does, for `captureFailure` to word.
 */
export async function testMicrophone(
  onLevel: (level: number) => void,
  settings: MicrophoneSettings = {},
  noiseFilter?: NoiseFilter,
): Promise<MicrophoneTest> {
  if (!navigator.mediaDevices?.getUserMedia) throw unsupported("microphone");
  const filter = wantsNoiseFilter(settings) ? noiseFilter : undefined;
  let device = await navigator.mediaDevices.getUserMedia(microphoneConstraints(settings, !!filter));
  let filtered: FilteredMicrophone | null = null;
  if (filter) {
    try {
      filtered = await filter(device);
    } catch {
      // As in a call: the browser's own suppression stands in.
      device.getTracks().forEach((track) => track.stop());
      device = await navigator.mediaDevices.getUserMedia(microphoneConstraints(settings));
    }
  }
  const stream = filtered?.stream ?? device;
  let context: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (Ctx) {
    try {
      context = new Ctx();
      void context.resume().catch(() => {});
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      timer = setInterval(() => onLevel(peakLevel(analyser, samples)), LEVEL_POLL_MS);
    } catch {
      // The microphone opened; only the meter is missing.
      void context?.close().catch(() => {});
      context = null;
    }
  }
  return {
    // The device's name: the filter's output is named for the audio node.
    label: device.getAudioTracks()[0]?.label ?? "",
    stream,
    metered: timer !== null,
    filtered: filtered !== null,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      filtered?.stop();
      filtered = null;
      device.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => {});
      context = null;
    },
  };
}
