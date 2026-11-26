import {
  shouldInitiateOffer,
  type CallCause,
  type CallReport,
  type CandidateCounts,
  type HuddleSignal,
  type ID,
} from "@ownbase/protocol";
import { CALL_CAUSES, type CallLogLine } from "./callLog.js";
import {
  candidateOf,
  countServers,
  describeCounts,
  describeServers,
  firstOf,
  noCandidates,
  selectedRoute,
} from "./callRoutes.js";
import {
  LEVEL_POLL_MS,
  SCREEN_SHARE_QUALITY,
  cameraConstraints,
  microphoneConstraints,
  openSaved,
  describeError,
  levelMeter,
  openMicrophone,
  unsupported,
  wantsNoiseFilter,
  wantsSystemMicrophone,
  type FilteredMicrophone,
  type LevelMeter,
  type MicrophoneFeed,
  type MicrophoneSettings,
  type NoiseFilter,
  type OpenSystemMicrophone,
  type ScreenShareQuality,
  type SystemMicrophone,
} from "./devices.js";
import {
  IDLE_ENCODING,
  cameraEncodingFor,
  pictureHeight,
  screenEncodingFor,
  viewHeight,
  type CallView,
  type SentEncoding,
} from "./callSizing.js";
import {
  SCREEN_SOUND,
  canShareScreenSound,
  leavesCallOut,
  shareHint,
  shareVideo,
  withStereoScreenSound,
  type ShareRequest,
} from "./screenShare.js";

export type { CallLogLine } from "./callLog.js";
export type { CallView } from "./callSizing.js";
export type { MicrophoneTest, ScreenShareQuality } from "./devices.js";

export interface HuddlePeer {
  userId: ID;
  /** Their microphone. Always attach it, even when there is no video. */
  audioStream: MediaStream | null;
  cameraStream: MediaStream | null;
  screenStream: MediaStream | null;
  screenSoundStream?: MediaStream | null;
  /** True once the connection is carrying media. */
  connected: boolean;
  /** Their microphone is off, as they reported it. */
  micMuted: boolean;
  /** They hear nobody, as they reported it (K16). */
  deafened?: boolean;
  speaking: boolean;
  /**
   * Why the connection has not come up, once it has taken long enough to
   * ask; null while it is fine or still within that time. See `CALL_CAUSES`.
   */
  trouble?: CallCause | null;
  /** The connection carried media before and dropped; it is being made again. */
  reconnecting?: boolean;
}

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
  /**
   * Opens the microphone as other apps on this computer do, where the app
   * can, for when none of the browser's processing is chosen.
   */
  systemMicrophone?: OpenSystemMicrophone;
  /** Push to talk from the start, so nothing is sent before the key is first held (K16). */
  pushToTalk?: PushToTalk;
}

/** The microphone sends only while a key is held, and for `releaseMs` after it is let go. */
export interface PushToTalk {
  releaseMs: number;
}

export interface HuddleState {
  channelId: ID;
  micMuted: boolean;
  /** You hear nobody, and your microphone is off with it (K16). */
  deafened?: boolean;
  /** Push to talk is on: your microphone sends only while its key is held. */
  pushToTalk?: boolean;
  /** The push-to-talk key is held, or was let go less than the release delay ago. */
  holdingTalk?: boolean;
  cameraOn: boolean;
  sharingScreen: boolean;
  /** Your share sends its sound too. */
  sharingScreenSound?: boolean;
  /** How sharp and smooth your share goes, while you share. */
  screenQuality?: ScreenShareQuality;
  /** Your own camera, for the self-view tile. */
  localCameraStream: MediaStream | null;
  /** Your own share, so you can see what everyone else is seeing. */
  localScreenStream: MediaStream | null;
  speaking: boolean;
  /**
   * Your microphone stopped, unplugged or its permission taken back, and no
   * other could be had: nobody can hear you until one is (CALL-01).
   */
  micLost: boolean;
  /**
   * You have been talking for a while with the microphone off: nobody hears
   * it, and you may not know. Clears a few seconds after you stop, or on unmute.
   */
  talkingWhileMuted?: boolean;
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

/**
 * Talking while muted, as against a cough or a door: loud in this many polls
 * within the window, and said for this long after the last of them.
 */
const MUTED_TALK_WINDOW_MS = 1500;
const MUTED_TALK_POLLS = 5;
const MUTED_TALK_HOLD_MS = 4000;

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
    // The browser goes on reporting a source's last packet for seconds after
    // the packets stop, as they do when push to talk lets go: a packet heard
    // at the last poll already is no longer anyone talking.
    const heard = source.rtpTimestamp;
    if (typeof heard === "number") {
      const before = peer.heard.get(source.source);
      peer.heard.set(source.source, heard);
      if (before === heard) continue;
    }
    loudest = Math.max(loudest, source.audioLevel ?? 0);
  }
  return loudest;
}

/**
 * One connection per participant, with its media slots fixed up front.
 *
 * The offerer declares microphone, camera, screen and screen sound in that
 * order. The answerer adopts those slots from the offer. Subsequent changes
 * use replaceTrack without renegotiation; incoming tracks use the negotiated
 * order.
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
  /** Hearing nobody (K16), with the microphone off; `mutedBeforeDeafen` is put back after. */
  private deafened = false;
  private mutedBeforeDeafen = false;
  /** Push to talk (K16), and whether its key is held, or let go within its release delay. */
  private pushToTalk: PushToTalk | null;
  private talkHeld = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private micLost = false;
  private recoveringMic: Promise<boolean> | null = null;
  /** The newest microphone or camera choice, so an older one finishing late is dropped. */
  private micChoice = 0;
  private cameraChoice = 0;
  private microphone: MicrophoneSettings;
  private cameraId: string | undefined;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  /**
   * Whether the camera, and a share, have been on in this call: from then on
   * every connection has an encoder for it, which `sizeCamera` and
   * `sizeScreen` shrink while it is off.
   */
  private cameraUsed = false;
  private screenUsed = false;
  /** What the share was last asked for, while it goes. */
  private screenQuality: ScreenShareQuality | null = null;
  /** The share's sound, sent apart from the microphone so each mutes alone. */
  private screenSoundTrack: MediaStreamTrack | null = null;
  private localCameraStream: MediaStream | null = null;
  private localScreenStream: MediaStream | null = null;
  /** How tall this side draws each other person's camera and share; see `setViews`. */
  private views: ReadonlyMap<ID, CallView> = new Map();
  /** Who is currently shown as talking, and when each was last loud. */
  private speaking = new Set<ID>();
  private spokeAt = new Map<ID, number>();
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  /** This side's own level, so its tile lights up like everyone else's. */
  private meter: LevelMeter | null = null;
  /** Loud polls while muted, newest last, within `MUTED_TALK_WINDOW_MS`. */
  private mutedLoud: number[] = [];
  private mutedTalkAt = 0;
  private talkingWhileMuted = false;
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
    this.pushToTalk = options.pushToTalk ?? null;
    this.note(`Call settings: ${describeServers(rtcConfig)}.`);
  }

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
      feed = await openMicrophone(this.microphone, this.options, {
        chosenNow: false,
        note: (line) => this.note(line),
      });
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

  /** What everyone hears from this side. */
  private get localStream(): MediaStream | null {
    return this.mic?.stream ?? null;
  }

  /** Whether the microphone goes out at all: not while muted, nor while push to talk's key is up. */
  private get sendingVoice(): boolean {
    return !this.muted && (!this.pushToTalk || this.talkHeld);
  }

  /**
   * What the microphone's slot sends one peer: the microphone, or nothing at
   * all while muted (E13b), while push to talk's key is up, or to someone
   * deafened (K16). A muted track would still be encoded as silence once for
   * every connection, and heard as silence on every one, which in a big call
   * of mostly muted people is most of what each of them spends on sound.
   */
  private sentMicrophone(peer: Peer): MediaStreamTrack | null {
    if (!this.sendingVoice || peer.deafened) return null;
    return this.localStream?.getAudioTracks()[0] ?? null;
  }

  /** The share's sound, for anyone not deafened. */
  private sentScreenSound(peer: Peer): MediaStreamTrack | null {
    return peer.deafened ? null : this.screenSoundTrack;
  }

  /** Makes this the microphone everyone hears, and watches for it stopping. */
  private adoptMicrophone(feed: MicrophoneFeed): void {
    const track = feed.stream.getAudioTracks()[0];
    if (track) track.enabled = !this.muted;
    // Stopping a track ourselves does not end it this way, so this is only
    // ever the device going, or its permission.
    if (feed.device) feed.device.onended = () => void this.recoverMicrophone();
    if (feed.system) feed.system.onEnded = () => void this.recoverMicrophone();
    this.mic = feed;
    this.micLost = false;
    this.meter?.stop();
    this.meter = levelMeter(feed.stream);
  }

  /** Closes the microphone in use, without taking that for the device going. */
  private releaseMicrophone(): void {
    this.meter?.stop();
    this.meter = null;
    if (this.mic?.device) this.mic.device.onended = null;
    if (this.mic?.system) this.mic.system.onEnded = null;
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
      const feed = await openMicrophone(this.microphone, this.options, {
        chosenNow: false,
        note: (line) => this.note(line),
      });
      if (this.destroyed) {
        feed.stop();
        return false;
      }
      this.releaseMicrophone();
      this.adoptMicrophone(feed);
      this.stopWaitingForMicrophone();
      await this.sendMicrophone();
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
      feed = await openMicrophone(settings, this.options, {
        chosenNow: true,
        note: (line) => this.note(line),
      });
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
    await this.sendMicrophone();
    this.announceMedia();
    this.onChange?.();
  }

  /** Sends the microphone, or nothing while muted, to everyone in place of what was before. */
  private async sendMicrophone(): Promise<void> {
    await Promise.all(
      [...this.peers.values()].flatMap((peer) =>
        peer.audioTx
          ? [peer.audioTx.sender.replaceTrack(this.sentMicrophone(peer)).catch(() => {})]
          : [],
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

  private localLevel(): number {
    return this.meter?.level() ?? 0;
  }

  private startLevelPolling(): void {
    if (this.levelTimer || this.destroyed) return;
    this.levelTimer = setInterval(() => this.sampleLevels(), LEVEL_POLL_MS);
  }

  /** One pass over every participant's loudness, published only on a change. */
  private sampleLevels(): void {
    const now = Date.now();
    const loud = this.localLevel() > SPEAKING_LEVEL;
    if (loud && this.sendingVoice) this.spokeAt.set(this.selfId, now);
    let changed = this.noticeMutedTalk(loud, now);
    for (const [userId, peer] of this.peers) {
      // Muted, they send nothing, and the browser goes on reporting their last
      // packet for seconds: someone muting mid-word would stay lit.
      if (!peer.micMuted && receivedLevel(peer) > SPEAKING_LEVEL) this.spokeAt.set(userId, now);
    }

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

  /** Whether `talkingWhileMuted` changed with this poll. */
  private noticeMutedTalk(loud: boolean, now: number): boolean {
    const was = this.talkingWhileMuted;
    if (!this.muted) {
      this.mutedLoud = [];
      this.talkingWhileMuted = false;
      return was;
    }
    if (loud) this.mutedLoud.push(now);
    while (this.mutedLoud.length && now - this.mutedLoud[0]! > MUTED_TALK_WINDOW_MS)
      this.mutedLoud.shift();
    if (this.mutedLoud.length >= MUTED_TALK_POLLS) {
      this.mutedTalkAt = this.mutedLoud.at(-1)!;
      this.talkingWhileMuted = true;
    } else if (now - this.mutedTalkAt > MUTED_TALK_HOLD_MS) {
      this.talkingWhileMuted = false;
    }
    return was !== this.talkingWhileMuted;
  }

  get micMuted(): boolean {
    return this.muted;
  }

  toggleMic(): void {
    const track = this.localStream?.getAudioTracks()[0];
    if (this.destroyed || !track) return;
    // Unmuting while deafened hears everyone again too, as Discord does.
    if (this.deafened) {
      this.deafened = false;
      this.muted = false;
    } else this.muted = !this.muted;
    this.micChanged();
  }

  /**
   * Deafens: nobody's voice nor share's sound plays here, nobody sends any,
   * and the microphone goes off with it. Undeafening puts the microphone back
   * as it was before (K16).
   */
  toggleDeafen(): void {
    if (this.destroyed) return;
    if (this.deafened) {
      this.deafened = false;
      this.muted = this.mutedBeforeDeafen;
    } else {
      this.mutedBeforeDeafen = this.muted;
      this.deafened = true;
      this.muted = true;
    }
    this.note(this.deafened ? "Deafened: hearing nobody, the microphone off." : "Undeafened.");
    this.micChanged();
  }

  private micChanged(): void {
    const track = this.localStream?.getAudioTracks()[0];
    if (track) track.enabled = !this.muted;
    this.noticeMutedTalk(false, Date.now());
    void this.sendMicrophone();
    // Everyone else needs to know, or a muted person just looks silent.
    this.announceMedia();
    this.onChange?.();
  }

  /**
   * Turns push to talk on, or off with null, mid-call. While it is on the
   * microphone sends nothing until `pressTalk`, through the same empty slot
   * as muting, so nothing is offered again and the others see no change.
   */
  setPushToTalk(choice: PushToTalk | null): void {
    if (this.destroyed) return;
    const was = this.pushToTalk !== null;
    this.pushToTalk = choice;
    if (was === (choice !== null)) return;
    this.clearRelease();
    this.talkHeld = false;
    this.note(choice ? "Push to talk is on." : "Push to talk is off.");
    void this.sendMicrophone();
    this.onChange?.();
  }

  /** The push-to-talk key went down: the microphone sends from now. */
  pressTalk(): void {
    if (this.destroyed || !this.pushToTalk) return;
    this.clearRelease();
    if (this.talkHeld) return;
    this.talkHeld = true;
    void this.sendMicrophone();
    this.onChange?.();
  }

  /**
   * The push-to-talk key came up: the microphone stops after the release
   * delay, so the end of the last word still goes.
   */
  releaseTalk(): void {
    if (this.destroyed || !this.pushToTalk || !this.talkHeld || this.releaseTimer) return;
    const stop = () => {
      this.releaseTimer = null;
      this.talkHeld = false;
      void this.sendMicrophone();
      this.onChange?.();
    };
    if (this.pushToTalk.releaseMs > 0)
      this.releaseTimer = setTimeout(stop, this.pushToTalk.releaseMs);
    else stop();
  }

  /** Starts talking, or stops, for a key that says when it is pressed but not when let go. */
  toggleTalk(): void {
    if (this.talkHeld && !this.releaseTimer) this.releaseTalk();
    else this.pressTalk();
  }

  private clearRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
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
      deafened: this.deafened,
      pushToTalk: this.pushToTalk !== null,
      holdingTalk: this.pushToTalk !== null && this.talkHeld && !this.muted,
      cameraOn: this.cameraOn,
      sharingScreen: this.sharingScreen,
      sharingScreenSound: this.screenSoundTrack !== null,
      ...(this.screenQuality ? { screenQuality: this.screenQuality } : {}),
      localCameraStream: this.localCameraStream,
      localScreenStream: this.localScreenStream,
      peers: [...this.peers.entries()].map(([userId, peer]) => ({
        userId,
        audioStream: peer.audio,
        cameraStream: peer.cameraOn ? peer.camera : null,
        screenStream: peer.screenOn ? peer.screen : null,
        screenSoundStream: peer.screenOn && peer.screenSoundOn ? peer.screenSound : null,
        connected: this.connected.has(userId),
        micMuted: peer.micMuted,
        deafened: peer.deafened,
        speaking: this.speaking.has(userId),
        trouble: this.connected.has(userId) ? null : peer.trouble,
        reconnecting: !this.connected.has(userId) && peer.everConnected,
      })),
      speaking: this.speaking.has(this.selfId),
      micLost: this.micLost,
      talkingWhileMuted: this.talkingWhileMuted,
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
    this.sizeSenders();
    this.onChange?.();
  }

  /**
   * How tall this side draws each other person's camera and share, in device
   * pixels; anyone left out draws as 0, not at all (E13b). Each of them is
   * told when what they should send this side changes (`viewHeight`), and
   * sends no more than that.
   */
  setViews(views: ReadonlyMap<ID, CallView>): void {
    this.views = new Map(views);
    for (const [userId, peer] of this.peers) {
      const view = this.viewOf(userId);
      if (peer.viewTold?.camera !== view.camera || peer.viewTold.screen !== view.screen)
        this.announceMedia(userId);
    }
  }

  /** What to ask someone to send this side, by how tall it draws them. */
  private viewOf(userId: ID): CallView {
    const drawn = this.views.get(userId);
    return { camera: viewHeight(drawn?.camera ?? 0), screen: viewHeight(drawn?.screen ?? 0) };
  }

  /**
   * Sizes what the camera and the share send on every connection, to how many
   * others there are and how big each draws them, without a new offer: a
   * sender's parameters change in place. A connection that is not set up yet
   * has nothing to size, and is sized once its setup is done.
   */
  private sizeSenders(): void {
    for (const [userId, peer] of this.peers) this.sizeFor(userId, peer);
  }

  private sizeFor(userId: ID, peer: Peer): void {
    peer.sizing = peer.sizing
      .then(() => this.sizeCamera(userId, peer))
      .then(() => this.sizeScreen(userId, peer));
  }

  private async sizeCamera(userId: ID, peer: Peer): Promise<void> {
    const others = this.peers.size;
    const view = peer.wants?.camera;
    // Turned off after being on, its encoders are left with as little as one
    // that is not shown. Before it is first on there are none, and it is
    // sized ahead for when it starts.
    const stopped = this.cameraTrack === null && this.cameraUsed;
    const wanted = stopped
      ? IDLE_ENCODING
      : cameraEncodingFor(others, view, pictureHeight(this.cameraTrack, true) ?? 540);
    const key = JSON.stringify(wanted);
    if (this.destroyed || this.peers.get(userId) !== peer || peer.cameraSized === key) return;
    const before = peer.cameraSized;
    if (!(await this.setEncoding(userId, peer.cameraTx?.sender, wanted, "camera"))) return;
    peer.cameraSized = key;
    const call = `a call of ${others + 1}`;
    if (stopped) return;
    if (!wanted.active) this.note("Sending them no camera, since they are not showing it.", userId);
    else if (wanted.maxBitrate !== undefined)
      this.note(
        `Sending them the camera at ${Math.round(100 / wanted.scaleResolutionDownBy)}% of its ` +
          `size, at most ${wanted.maxFramerate} frames a second and ` +
          `${Math.round(wanted.maxBitrate / 1000)} kbit/s, ` +
          (view === undefined ? `for ${call}.` : `as they show it ${view} high, in ${call}.`),
        userId,
      );
    else if (before !== null)
      this.note(`Sending them the camera at its full size, for ${call}.`, userId);
  }

  private async sizeScreen(userId: ID, peer: Peer): Promise<void> {
    const view = peer.wants?.screen;
    const height = pictureHeight(this.screenTrack, false) ?? SCREEN_SHARE_QUALITY.height;
    // As the camera's: a share that has stopped leaves its encoders little.
    const stopped = this.screenTrack === null && this.screenUsed;
    const wanted = stopped ? IDLE_ENCODING : screenEncodingFor(view, height);
    const key = JSON.stringify(wanted);
    if (this.destroyed || this.peers.get(userId) !== peer || peer.screenSized === key) return;
    // Nobody has asked for anything yet, and the share goes as it comes.
    if (!stopped && view === undefined && peer.screenSized === null) return;
    if (!(await this.setEncoding(userId, peer.screenTx?.sender, wanted, "share"))) return;
    peer.screenSized = key;
    if (stopped) return;
    if (!wanted.active) this.note("Sending them no share, since they are not showing it.", userId);
    else
      this.note(
        `Sending them the share at ${Math.round(100 / wanted.scaleResolutionDownBy)}% of its size` +
          (view === undefined ? "." : `, as they show it ${view} high.`),
        userId,
      );
  }

  /** Changes what one sender sends; false where it could not. */
  private async setEncoding(
    userId: ID,
    sender: RTCRtpSender | undefined,
    wanted: SentEncoding,
    what: "camera" | "share",
  ): Promise<boolean> {
    // A browser without sender parameters sends the picture as it comes.
    if (!sender || typeof sender.getParameters !== "function") return false;
    const params = sender.getParameters();
    const encoding = params.encodings?.[0];
    if (!encoding) return false;
    encoding.active = wanted.active;
    encoding.scaleResolutionDownBy = wanted.scaleResolutionDownBy;
    if (wanted.maxFramerate === undefined) delete encoding.maxFramerate;
    else encoding.maxFramerate = wanted.maxFramerate;
    if (wanted.maxBitrate === undefined) delete encoding.maxBitrate;
    else encoding.maxBitrate = wanted.maxBitrate;
    try {
      await sender.setParameters(params);
      return true;
    } catch (err) {
      this.note(`Could not size the ${what} for them: ${describeError(err)}.`, userId);
      return false;
    }
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
    const screenSoundTx = initiating ? pc.addTransceiver("audio", { direction: "sendrecv" }) : null;

    const peer: Peer = {
      pc,
      audioTx,
      cameraTx,
      screenTx,
      screenSoundTx,
      audio: null,
      camera: null,
      screen: null,
      screenSound: null,
      cameraOn: false,
      screenOn: false,
      screenSoundOn: false,
      micMuted: false,
      deafened: false,
      heard: new Map(),
      pendingIce: [],
      heldIce: null,
      everConnected: false,
      initiating,
      startedAt: Date.now(),
      local: noCandidates(),
      remote: noCandidates(),
      retries: 0,
      retrying: false,
      logged: new Set(),
      trouble: null,
      stallTimer: null,
      cameraSized: null,
      screenSized: null,
      wants: undefined,
      viewTold: null,
      sizing: Promise.resolve(),
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
      const candidate = {
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex,
      };
      if (peer.heldIce) peer.heldIce.push(candidate);
      else this.sendIce(userId, candidate);
    };

    pc.ontrack = (e) => {
      // A slot always exists, so a track arrives for it whether or not
      // anything is being sent. Keep the stream; whether it is worth showing
      // is what the peer's "media" signal tells us.
      const stream = new MediaStream([e.track]);
      const slot = pc.getTransceivers().indexOf(e.transceiver);
      if (slot === 1) peer.camera = stream;
      else if (slot === 2) peer.screen = stream;
      else if (slot === 3) peer.screenSound = stream;
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
        peer.everConnected = true;
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
          if (!this.destroyed && this.peers.get(userId) === peer) return this.offer(userId, peer);
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
        await this.offer(userId, peer, true);
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
      peer.audioTx?.sender.replaceTrack(this.sentMicrophone(peer)),
      peer.cameraTx?.sender.replaceTrack(this.cameraTrack),
      peer.screenTx?.sender.replaceTrack(this.screenTrack),
      peer.screenSoundTx?.sender.replaceTrack(this.sentScreenSound(peer)),
    ]);
  }

  /**
   * Sends the call setup. This side's routes wait for their answer. Sent
   * with the offer, they let the other side check them and finish the
   * encryption handshake while this side is still taking in the answer.
   * WebKit then keeps this side's connectionState at "connecting" for good,
   * though its ICE and DTLS transports say connected and sound arrives
   * (Playwright's WebKit 27.2 on CI: about one call in six), so the call
   * shows "Connecting…" and is restarted as stalled. Their routes come with
   * the answer, so this side starts checking the moment it has it.
   */
  private async offer(userId: ID, peer: Peer, iceRestart = false): Promise<void> {
    const pc = peer.pc;
    // Routes of an offer never answered belong to it, not to this one.
    peer.heldIce = [];
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await pc.setLocalDescription(offer);
    this.sizeSenders();
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
      await pc.setRemoteDescription({ type: "offer", sdp: withStereoScreenSound(signal.sdp) });
      const slots = pc.getTransceivers();
      peer.audioTx = slots[0] ?? null;
      peer.cameraTx = slots[1] ?? null;
      peer.screenTx = slots[2] ?? null;
      peer.screenSoundTx = slots[3] ?? null;
      for (const slot of slots) slot.direction = "sendrecv";
      await this.attachLocalTracks(peer);
      await this.flushIce(peer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      // The slots it adopted have parameters now, and the call has grown by one.
      this.sizeSenders();
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
      await pc.setRemoteDescription({ type: "answer", sdp: withStereoScreenSound(signal.sdp) });
      this.note("Received their answer.", from);
      for (const candidate of peer.heldIce?.splice(0) ?? []) this.sendIce(from, candidate);
      peer.heldIce = null;
      await this.flushIce(peer);
    } else if (signal.kind === "media") {
      peer.cameraOn = signal.camera;
      peer.screenOn = signal.screen;
      peer.micMuted = signal.muted;
      peer.screenSoundOn = signal.screenSound;
      const deafened = signal.deafened ?? false;
      if (deafened !== peer.deafened) {
        peer.deafened = deafened;
        this.note(
          deafened
            ? "They deafened. Sending them no sound, since they would hear none."
            : "They undeafened.",
          from,
        );
        void Promise.all([
          peer.audioTx?.sender.replaceTrack(this.sentMicrophone(peer)).catch(() => {}),
          peer.screenSoundTx?.sender.replaceTrack(this.sentScreenSound(peer)).catch(() => {}),
        ]);
      }
      const view = signal.view;
      if (view.camera !== peer.wants?.camera || view.screen !== peer.wants.screen) {
        peer.wants = { camera: view.camera, screen: view.screen };
        this.sizeFor(from, peer);
      }
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

  private sendIce(to: ID, candidate: SignalledCandidate): void {
    this.transport.send({
      type: "huddle.signal",
      channelId: this.channelId,
      to,
      signal: { kind: "ice", candidate },
    });
  }

  private async flushIce(peer: Peer): Promise<void> {
    for (const candidate of peer.pendingIce.splice(0)) {
      await peer.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

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

  /**
   * Starts sharing the screen, at `quality`, or stops sharing it. With
   * `sound`, where the browser can leave this call's own sound out of it, the
   * share's sound goes too, in a slot of its own: muting the microphone leaves
   * it playing, and it stops with the share. The browser's picker may still
   * share none, which is fine.
   */
  async toggleScreenShare(
    quality: ScreenShareQuality = SCREEN_SHARE_QUALITY,
    sound = true,
  ): Promise<void> {
    if (this.destroyed || this.acquiringScreen) return;
    if (this.screenTrack) {
      this.stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) throw unsupported("screen");
    const withSound = sound && canShareScreenSound();
    this.acquiringScreen = true;
    let display: MediaStream;
    try {
      const request: ShareRequest = {
        video: shareVideo(quality),
        audio: withSound ? SCREEN_SOUND : false,
        // Chrome's defaults, said because they matter here: sound is offered
        // for a screen and a window as well as a tab, and this page's own tab
        // is not offered at all.
        ...(withSound
          ? { systemAudio: "include", windowAudio: "system", selfBrowserSurface: "exclude" }
          : {}),
      };
      display = await navigator.mediaDevices.getDisplayMedia(request);
    } finally {
      this.acquiringScreen = false;
    }
    if (this.destroyed) {
      display.getTracks().forEach((track) => track.stop());
      return;
    }
    const track = display.getVideoTracks()[0];
    if (!track) {
      display.getTracks().forEach((t) => t.stop());
      return;
    }
    const sharedSound = withSound ? display.getAudioTracks()[0] : undefined;
    if (sharedSound && leavesCallOut(sharedSound, track)) {
      this.screenSoundTrack = sharedSound;
      // The sound can end on its own, its device gone; the picture goes on.
      sharedSound.onended = () => this.stopScreenSound();
      this.note("Sharing the screen with its sound.");
    } else if (sharedSound) {
      sharedSound.stop();
      this.note("Sharing the screen without its sound: the browser could not leave the call out.");
    }
    // Screen content: when bandwidth runs short, keep the resolution and drop
    // frames. Without the hint the encoder treats a screen like a camera and
    // blurs the text first. Sixty frames a second is asked for motion, a game
    // or a video, which keeps moving and softens instead.
    track.contentHint = shareHint(quality);
    this.screenTrack = track;
    this.screenQuality = quality;
    this.localScreenStream = display;
    // Stopping from the browser's own bar must clean up too.
    track.onended = () => this.stopScreenShare();
    await this.sendScreenSound();
    await this.publish("screen", track);
  }

  /**
   * Changes how sharp and smooth the share goes while it goes, as Discord's
   * stream quality does: the same capture is asked for another size and
   * frame rate, so nobody's picture stops and nothing is offered again. False
   * where there is no share, or the browser would not change it.
   */
  async setScreenShareQuality(quality: ScreenShareQuality): Promise<boolean> {
    const track = this.screenTrack;
    if (!track || this.destroyed) return false;
    try {
      await track.applyConstraints(shareVideo(quality));
    } catch (err) {
      this.note(`The share's quality was not changed: ${describeError(err)}`);
      return false;
    }
    // Stopped, or another share started, while the browser was changing it.
    if (this.screenTrack !== track || this.destroyed) return false;
    track.contentHint = shareHint(quality);
    this.screenQuality = quality;
    this.note(`Sharing the screen at ${quality.height}p, ${quality.frameRate} frames a second.`);
    // A taller or shorter picture is scaled anew for whoever shows it small.
    this.sizeSenders();
    this.onChange?.();
    return true;
  }

  private stopScreenShare(): void {
    if (!this.screenTrack) return;
    this.screenTrack.stop();
    this.screenTrack = null;
    this.screenQuality = null;
    this.localScreenStream = null;
    this.stopScreenSound(false);
    void this.publish("screen", null);
  }

  /** Stops the share's sound, and says so unless the share is stopping too. */
  private stopScreenSound(announce = true): void {
    const track = this.screenSoundTrack;
    if (!track) return;
    track.onended = null;
    track.stop();
    this.screenSoundTrack = null;
    void this.sendScreenSound();
    if (!announce || this.destroyed) return;
    this.note("The share's sound stopped; the picture goes on.");
    this.announceMedia();
    this.onChange?.();
  }

  /** Puts the share's sound, or none, in every connection's slot for it. */
  private async sendScreenSound(): Promise<void> {
    await Promise.all(
      [...this.peers.values()].flatMap((peer) =>
        peer.screenSoundTx
          ? [peer.screenSoundTx.sender.replaceTrack(this.sentScreenSound(peer)).catch(() => {})]
          : [],
      ),
    );
  }

  /**
   * Pushes one slot's track to every peer. Because the transceiver was created
   * up front this needs no new offer — the track simply starts or stops
   * flowing, and the far side sees its receiver unmute or mute.
   */
  private async publish(slot: "camera" | "screen", track: MediaStreamTrack | null): Promise<void> {
    if (track && slot === "camera") this.cameraUsed = true;
    if (track && slot === "screen") this.screenUsed = true;
    await Promise.all(
      [...this.peers.values()].flatMap((peer) => {
        const tx = slot === "camera" ? peer.cameraTx : peer.screenTx;
        // A peer that died mid-call must not stop the others updating.
        return tx ? [tx.sender.replaceTrack(track).catch(() => {})] : [];
      }),
    );
    // A picture of another height is scaled to their tiles anew.
    this.sizeSenders();
    this.announceMedia();
    this.onChange?.();
  }

  /**
   * Says which slots we are sending on, and how big we draw theirs, to one
   * peer or to all of them.
   */
  private announceMedia(to?: ID): void {
    if (this.destroyed) return;
    for (const userId of to ? [to] : this.peers.keys()) {
      const view = this.viewOf(userId);
      const peer = this.peers.get(userId);
      if (peer) peer.viewTold = view;
      this.transport.send({
        type: "huddle.signal",
        channelId: this.channelId,
        to: userId,
        signal: {
          kind: "media",
          camera: this.cameraTrack !== null,
          screen: this.screenTrack !== null,
          muted: this.micMuted || this.micLost,
          deafened: this.deafened,
          // Said either way: saying it at all tells them this side has the slot.
          screenSound: this.screenSoundTrack !== null,
          view,
        },
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

  /**
   * Closes every peer connection, keeping the microphone and camera, for
   * coming back after the server gave this device's place up: the others
   * closed their end, so each connection is made afresh once let back in.
   */
  closePeers(): void {
    if (this.destroyed) return;
    for (const userId of [...this.peers.keys()]) {
      this.note("Connecting again, since the server let this device's place go.", userId);
      this.closePeer(userId);
    }
    this.onChange?.();
  }

  /** Tears down every connection and releases the camera and microphone. */
  destroy(): void {
    if (!this.destroyed) this.note("Left the huddle.");
    this.destroyed = true;
    this.clearRelease();
    this.stopWaitingForMicrophone();
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    this.meter?.stop();
    this.meter = null;
    for (const userId of [...this.peers.keys()]) this.closePeer(userId);
    this.cameraTrack?.stop();
    this.cameraTrack = null;
    this.localCameraStream = null;
    this.screenTrack?.stop();
    this.screenTrack = null;
    this.localScreenStream = null;
    this.stopScreenSound(false);
    this.releaseMicrophone();
    this.mic = null;
    this.onChange = null;
  }
}

/** One connection and its fixed media slots. */
interface Peer {
  pendingIce: RTCIceCandidateInit[];
  /**
   * This side's routes, kept back while its offer waits for their answer;
   * null when they go out as found. See `offer`.
   */
  heldIce: SignalledCandidate[] | null;
  /** The connection has carried media at least once. */
  everConnected: boolean;
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
  /** Null where they offered no slot for it, from a client older than it. */
  screenSoundTx: RTCRtpTransceiver | null;
  audio: MediaStream | null;
  camera: MediaStream | null;
  screen: MediaStream | null;
  screenSound: MediaStream | null;
  /** What they told us they are sending; see the "media" signal. */
  cameraOn: boolean;
  screenOn: boolean;
  screenSoundOn: boolean;
  micMuted: boolean;
  /** They hear nobody, so they are sent pictures but no sound (K16). */
  deafened: boolean;
  /** Each of their sound's sources by the RTP time of its last packet, as last polled. */
  heard: Map<number, number>;
  /** What the camera's and the share's senders were last set to (`SentEncoding`, as JSON). */
  cameraSized: string | null;
  screenSized: string | null;
  /** How big they draw this side's camera and share, as they last said; missing from a client before E13b. */
  wants: CallView | undefined;
  /** How big this side last told them it draws theirs. */
  viewTold: CallView | null;
  /** Sizing the senders, one change at a time. */
  sizing: Promise<void>;
}

/** A route as the signal carries it. */
type SignalledCandidate = Extract<HuddleSignal, { kind: "ice" }>["candidate"];

/** A device another app, or another device built on it, is holding. */
function isBusy(err: unknown): boolean {
  const name = typeof err === "object" && err !== null && "name" in err ? err.name : "";
  return name === "NotReadableError" || name === "AbortError";
}
