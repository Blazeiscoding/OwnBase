import type { EphemeralEvent, HuddleRing, ID, ReadySnapshot } from "@ownbase/protocol";
import type { StoreApi } from "zustand/vanilla";
import type { Api } from "./api.js";
import { captureFailure } from "./capture.js";
import type { MicrophoneSettings, NoiseFilter, OpenSystemMicrophone } from "./devices.js";
import type {
  CallLogLine,
  CallView,
  HuddleSession,
  PushToTalk,
  ScreenShareQuality,
} from "./huddle.js";
import type { WorkspaceState } from "./workspaceState.js";

class HuddleJoinRefusedError extends Error {}
/** A rejoin given up because the socket dropped again; the next one asks afresh. */
class HuddleRejoinCancelled extends Error {}

/** How long a request to join a huddle waits for the server's answer. */
const HUDDLE_JOIN_WAIT_MS = 10_000;

/** Keeps this device in at most one huddle, from joining, through a dropped socket, to leaving. */
export class Calls {
  constructor(
    private readonly api: Api,
    private readonly store: StoreApi<WorkspaceState>,
    private readonly sendSocket: (msg: unknown) => void,
  ) {}

  private get state(): WorkspaceState {
    return this.store.getState();
  }

  private session: HuddleSession | null = null;
  /** How tall the call draws everyone's pictures; see `setCallViews`. */
  private callViews: ReadonlyMap<ID, CallView> = new Map();
  private huddleAttempt = 0;
  private huddleAdmitted = false;
  /** Whether the session was let into its huddle, so a returning socket asks to go on with it. */
  private inHuddle = false;
  private rejoins = 0;
  /** The call log of the last huddle, kept after leaving it for Diagnostics. */
  private lastCallLog: CallLogLine[] = [];
  private pendingHuddleJoin: {
    channelId: ID;
    requestId: string;
    finish: (error?: Error) => void;
  } | null = null;

  callLog(): CallLogLine[] {
    return [...(this.session?.log ?? this.lastCallLog)];
  }

  /** Mirrors the live session into the store so React can render it. */
  private publishHuddleState(): void {
    this.store.setState({ huddle: this.session?.state() ?? null });
  }

  async joinHuddle(
    channelId: ID,
    options: {
      muted?: boolean;
      microphone?: MicrophoneSettings;
      cameraId?: string;
      noiseFilter?: NoiseFilter;
      systemMicrophone?: OpenSystemMicrophone;
      pushToTalk?: PushToTalk;
    } = {},
  ): Promise<void> {
    this.leaveHuddle();
    const attempt = this.huddleAttempt;
    const selfId = this.state.self?.id;
    if (!selfId) return;
    this.store.setState({ huddleEnded: null, ringNotice: null });

    let config: RTCConfiguration;
    try {
      config = await this.api.rtcConfig();
    } catch (err) {
      this.lastCallLog = [
        {
          at: Date.now(),
          text: `Could not read the call settings: ${err instanceof Error ? err.message : String(err)}.`,
        },
      ];
      throw err;
    }
    if (attempt !== this.huddleAttempt) return;

    // Calls are loaded when someone joins one, not with every visit.
    const { HuddleSession } = await import("./huddle.js");
    if (attempt !== this.huddleAttempt) return;
    const session = new HuddleSession(
      channelId,
      selfId,
      {
        send: (msg) => this.sendSocket(msg),
      },
      config,
      {
        refreshConfig: () => this.api.rtcConfig(),
        microphone: options.microphone,
        cameraId: options.cameraId,
        noiseFilter: options.noiseFilter,
        systemMicrophone: options.systemMicrophone,
        pushToTalk: options.pushToTalk,
        onReport: (peer, report) => {
          if (this.session === session)
            this.sendSocket({ type: "huddle.report", channelId, peer, report });
        },
      },
    );
    session.setViews(this.callViews);
    this.session = session;
    this.lastCallLog = session.log;
    try {
      await session.startLocalAudio(options.muted);
    } catch (err) {
      session.destroy();
      if (this.session === session) this.session = null;
      // Said as what to do about it, not as the browser's "Permission denied".
      throw new Error(captureFailure("microphone", err) ?? "Your microphone could not start.", {
        cause: err,
      });
    }
    if (attempt !== this.huddleAttempt) {
      session.destroy();
      return;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        this.askToJoin(
          channelId,
          `join-${attempt}`,
          "The huddle did not answer. Check your connection, then try again.",
          (error) => (error ? reject(error) : resolve()),
        );
        session.note("Asked the server to join the huddle.");
      });
      session.note("The server let this device into the huddle.");
    } catch (error) {
      session.note(`Not let in: ${error instanceof Error ? error.message : String(error)}`);
      session.destroy();
      if (this.session === session) {
        this.session = null;
        if (!(error instanceof HuddleJoinRefusedError))
          this.sendSocket({ type: "huddle.leave", channelId });
        this.publishHuddleState();
      }
      throw error;
    }
    if (attempt !== this.huddleAttempt) {
      session.destroy();
      return;
    }
    this.huddleAdmitted = true;
    this.inHuddle = true;
    session.onChange = () => this.publishHuddleState();
    // Dial whoever is already there; later arrivals come via participants events.
    session.syncParticipants(this.state.huddles[channelId] ?? []);
    this.publishHuddleState();
  }

  leaveHuddle(): void {
    this.endHuddle();
  }

  /**
   * What the caller's device in the call says as its ring changes (E10): who
   * has just declined, or, once it ends with nobody answering, that nobody
   * did. Their other devices say nothing, nor does anyone rung.
   */
  ringNoticeFor(before: HuddleRing | undefined, after: HuddleRing): string | null {
    if (after.callerId !== this.state.self?.id || this.state.huddle?.channelId !== after.channelId)
      return null;
    const declined = after.declined.filter((id) => !before?.declined.includes(id));
    if (declined.length > 0)
      return `${declined.map((id) => this.state.users[id]?.displayName ?? "Someone").join(" and ")} declined`;
    if (after.ringing.length === 0 && after.answered.length === 0) return "No answer";
    return null;
  }

  declineRing(channelId: ID): void {
    const ring = this.state.rings[channelId];
    const selfId = this.state.self?.id;
    if (!ring || !selfId || !ring.ringing.includes(selfId)) return;
    this.sendSocket({ type: "huddle.decline", channelId });
    const ringing = ring.ringing.filter((id) => id !== selfId);
    const rings = { ...this.state.rings };
    if (ringing.length > 0)
      rings[channelId] = { ...ring, ringing, declined: [...ring.declined, selfId] };
    else delete rings[channelId];
    this.store.setState({ rings });
  }

  /**
   * Ends this device's part in the huddle: tells the server unless it already
   * knows, and says why on screen when the person did not choose it.
   */
  private endHuddle(
    why: { message: string; error: boolean } | null = null,
    tellServer = true,
  ): void {
    this.huddleAttempt++;
    this.huddleAdmitted = false;
    this.inHuddle = false;
    this.pendingHuddleJoin?.finish(new Error("Joining the huddle was cancelled."));
    const session = this.session;
    if (!session) return;
    this.session = null;
    if (tellServer) this.sendSocket({ type: "huddle.leave", channelId: session.channelId });
    if (why) session.note(why.message);
    session.destroy();
    this.publishHuddleState();
    if (why)
      this.store.setState({
        huddleEnded: { channelId: session.channelId, ...why, at: Date.now() },
      });
  }

  /**
   * The socket dropped mid-call. The call goes on: its sound and video pass
   * between the devices, and the server keeps this one's place a while. Only
   * a join still waiting for its answer is given up, since none will come.
   */
  holdHuddle(): void {
    const session = this.session;
    if (!session) return;
    this.huddleAdmitted = false;
    if (!this.inHuddle) {
      this.pendingHuddleJoin?.finish(
        new Error("The connection dropped while joining the huddle. Try again."),
      );
      return;
    }
    // A rejoin still waiting is asked again when the socket returns.
    const pending = this.pendingHuddleJoin;
    this.pendingHuddleJoin = null;
    pending?.finish(new HuddleRejoinCancelled());
    session.note("The connection to the server dropped. Staying in the call meanwhile.");
  }

  /**
   * Back in the huddle once the socket returns. The snapshot says whether
   * the server kept this device's place: if it did, the others never saw it
   * go and every peer connection stays; if not (it waited too long, or the
   * server restarted), they closed theirs, so this side closes its own and
   * dials again once let back in. Refused, the call ends and says why.
   */
  resumeHuddle(snap: ReadySnapshot): void {
    const session = this.session;
    const selfId = this.state.self?.id;
    if (!session || !this.inHuddle || !selfId) return;
    const channelId = session.channelId;
    const kept = (snap.huddles[channelId] ?? []).includes(selfId);
    if (!kept) session.closePeers();
    const attempt = this.huddleAttempt;
    const back = () => {
      if (attempt !== this.huddleAttempt || this.session !== session) return;
      this.huddleAdmitted = true;
      session.note(
        kept ? "Back in the huddle, in the place the server kept." : "Let into the huddle again.",
      );
      session.syncParticipants(this.state.huddles[channelId] ?? []);
      this.publishHuddleState();
    };
    session.note("The connection to the server came back. Asking to go on with the huddle.");
    this.askToJoin(
      channelId,
      `rejoin-${attempt}-${++this.rejoins}`,
      "The huddle did not answer.",
      (error) => {
        if (!error) return back();
        if (error instanceof HuddleRejoinCancelled) return;
        if (attempt !== this.huddleAttempt || this.session !== session) return;
        this.endHuddle(
          {
            message: `The huddle ended here after the connection dropped. ${error.message}`,
            error: true,
          },
          !(error instanceof HuddleJoinRefusedError),
        );
      },
    );
  }

  /**
   * Asks the server to let this device into the huddle. `onFinish` hears its
   * answer, or, after `HUDDLE_JOIN_WAIT_MS` without one, `unanswered`.
   */
  private askToJoin(
    channelId: ID,
    requestId: string,
    unanswered: string,
    onFinish: (error?: Error) => void,
  ): void {
    const timer = setTimeout(() => {
      if (this.pendingHuddleJoin?.requestId === requestId)
        this.pendingHuddleJoin.finish(new Error(unanswered));
    }, HUDDLE_JOIN_WAIT_MS);
    this.pendingHuddleJoin = {
      channelId,
      requestId,
      finish: (error) => {
        clearTimeout(timer);
        if (this.pendingHuddleJoin?.requestId === requestId) this.pendingHuddleJoin = null;
        onFinish(error);
      },
    };
    this.sendSocket({ type: "huddle.join", channelId, requestId });
  }

  toggleMic(): void {
    this.session?.toggleMic();
  }

  toggleDeafen(): void {
    this.session?.toggleDeafen();
  }

  setPushToTalk(choice: PushToTalk | null): void {
    this.session?.setPushToTalk(choice);
  }

  pressTalk(): void {
    this.session?.pressTalk();
  }

  releaseTalk(): void {
    this.session?.releaseTalk();
  }

  toggleTalk(): void {
    this.session?.toggleTalk();
  }

  retryMicrophone(): void {
    void this.session?.recoverMicrophone();
  }

  async toggleScreenShare(quality?: ScreenShareQuality, sound?: boolean): Promise<void> {
    await this.session?.toggleScreenShare(quality, sound);
  }

  async setScreenShareQuality(quality: ScreenShareQuality): Promise<boolean> {
    return (await this.session?.setScreenShareQuality(quality)) ?? false;
  }

  async toggleCamera(): Promise<void> {
    await this.session?.toggleCamera();
  }

  setCallViews(views: ReadonlyMap<ID, CallView>): void {
    this.callViews = views;
    this.session?.setViews(views);
  }

  async setMicrophone(settings: MicrophoneSettings): Promise<void> {
    await this.session?.setMicrophone(settings);
  }

  async setCamera(deviceId: string | undefined): Promise<void> {
    await this.session?.setCamera(deviceId);
  }

  /** Someone joined or left the huddle in a conversation. */
  participantsChanged(event: Extract<EphemeralEvent, { type: "huddle.participants" }>): void {
    // Reconcile our own mesh against the new roster.
    if (this.session?.channelId === event.channelId && this.huddleAdmitted) {
      this.session.setHands(event.hands ?? []);
      this.session.syncParticipants(event.userIds);
      this.publishHuddleState();
    }
  }

  /** This account joined the huddle on another device. */
  moved(event: Extract<EphemeralEvent, { type: "huddle.moved" }>): void {
    // The server already gave the place to the other device; saying so
    // again here would only be refused.
    if (this.session?.channelId === event.channelId)
      this.endHuddle(
        {
          message: "You joined this huddle on another device, so it ended here.",
          error: false,
        },
        false,
      );
  }

  /** The server's answer to a request to join. */
  joinResult(event: Extract<EphemeralEvent, { type: "huddle.join.result" }>): void {
    const pending = this.pendingHuddleJoin;
    if (pending?.channelId === event.channelId && pending.requestId === event.requestId) {
      if (event.accepted) {
        this.huddleAdmitted = true;
        // The roster that came before this answer was not yet this device's to read.
        this.session?.setHands(event.hands ?? []);
      }
      pending.finish(event.accepted ? undefined : new HuddleJoinRefusedError(event.message));
    }
  }

  /** A peer's signalling message for this device's call. */
  signal(event: Extract<EphemeralEvent, { type: "huddle.signal" }>): void {
    if (this.session?.channelId === event.channelId && this.huddleAdmitted) {
      void this.session.handleSignal(event.from, event.signal);
    }
  }

  /** Someone in this device's call reacted (K17). */
  reacted(event: Extract<EphemeralEvent, { type: "huddle.react" }>): void {
    if (this.session?.channelId === event.channelId && this.huddleAdmitted)
      this.session.heardReaction(event.from, event.emoji);
  }

  toggleHand(): void {
    this.session?.toggleHand();
  }

  react(emoji: string): void {
    this.session?.react(emoji);
  }

  /** Leaves the huddle when it is in this conversation. */
  leaveIfIn(channelId: ID): void {
    if (this.session?.channelId === channelId) this.leaveHuddle();
  }
}
