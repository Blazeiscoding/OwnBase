/**
 * Which microphone a huddle opens, and how the browser cleans up its sound
 * (Voice & video settings). Everything missing means the browser's default.
 */
export interface MicrophoneSettings {
  /** The device to open; missing or empty for the system's default. */
  deviceId?: string;
  /** Takes the other people's voices back out of the microphone. */
  echoCancellation?: boolean;
  /** Takes out background noise; off sends the microphone as it is. */
  noiseSuppression?: boolean;
  /**
   * Strong noise suppression: a small neural network that takes out typing
   * and clatter as well as steady sound, in place of the browser's own,
   * which only takes out steady sound such as fans and hum. On unless turned
   * off, and never while `noiseSuppression` is.
   */
  noiseFilter?: boolean;
  /** Evens out a voice that is too quiet or too loud. */
  autoGainControl?: boolean;
}

export function wantsNoiseFilter(settings: MicrophoneSettings = {}): boolean {
  return settings.noiseSuppression !== false && settings.noiseFilter !== false;
}

/**
 * Whether the system can open the microphone for these settings rather than
 * the browser: none of the browser's own processing is wanted, its noise
 * suppression included unless the strong filter (`filtered`) takes its place.
 */
export function wantsSystemMicrophone(
  settings: MicrophoneSettings = {},
  filtered = false,
): boolean {
  return (
    settings.echoCancellation === false &&
    settings.autoGainControl === false &&
    (settings.noiseSuppression === false || filtered)
  );
}

/**
 * A microphone the app opened itself rather than through the browser: the
 * desktop app on Windows opens one the way other apps there do, so the
 * sound effects set up in Windows reach it. The browser opens it raw, which
 * leaves them out.
 */
export interface SystemMicrophone {
  stream: MediaStream;
  /** The device's name, as the system gives it. */
  label: string;
  /** Called once if the device goes, or stops sending sound. */
  onEnded: (() => void) | null;
  /** Lets the device go. Safe to call more than once. */
  stop(): void;
}

/**
 * Opens a microphone the way other apps on this computer do: the one the
 * browser calls `deviceId`, or the system's default without one. Supplied by
 * the app where it can. Resolves null where it cannot tell which device that
 * is, and rejects with `NotFoundError` for one the browser does not list, as
 * getUserMedia does.
 */
export type OpenSystemMicrophone = (
  deviceId: string | undefined,
) => Promise<SystemMicrophone | null>;

/** A microphone with its background noise taken out, as it is sent. */
export interface FilteredMicrophone {
  stream: MediaStream;
  /** Lets go of what the filter made; the microphone itself is the caller's. */
  stop(): void;
}

/**
 * Takes background noise out of a microphone. Supplied by the app, which
 * knows how to load the filter's code; rejects where it cannot run.
 */
export type NoiseFilter = (microphone: MediaStream) => Promise<FilteredMicrophone>;

/**
 * Names the device the browser should open, exactly. Chromium passes over a
 * device asked for any other way (`deviceId: id`, even `{ ideal: id }`) and
 * opens the system's default whether or not that one is connected, which is
 * how every saved choice was once ignored; `openSaved` falls back instead.
 */
function device(deviceId: string | undefined) {
  return deviceId ? { deviceId: { exact: deviceId } } : {};
}

/** Whether the browser refused because the device asked for is not connected. */
function isMissingDevice(err: unknown): boolean {
  const { name, constraint } = (typeof err === "object" && err !== null ? err : {}) as {
    name?: unknown;
    constraint?: unknown;
  };
  return name === "NotFoundError" || (name === "OverconstrainedError" && constraint === "deviceId");
}

/**
 * Opens a saved device, or the system's default while it is not connected
 * (a headset left at home) rather than failing the call. `open` is given the
 * saved one first and, only if that is missing, nothing for the default. A
 * choice made just now does not come here, so a device that will not open
 * says so instead of quietly opening another.
 */
export async function openSaved<T = MediaStream>(
  deviceId: string | undefined,
  open: (deviceId: string | undefined) => Promise<T>,
  onMissing?: () => void,
): Promise<T> {
  if (!deviceId) return open(undefined);
  try {
    return await open(deviceId);
  } catch (err) {
    if (!isMissingDevice(err)) throw err;
    onMissing?.();
    return open(undefined);
  }
}

/**
 * What a huddle asks the browser for when it opens the microphone. With the
 * strong filter to follow, the browser's own suppression is left off rather
 * than run twice.
 */
export function microphoneConstraints(
  settings: MicrophoneSettings = {},
  filtered = false,
): MediaStreamConstraints {
  return {
    audio: {
      channelCount: 1,
      echoCancellation: settings.echoCancellation ?? true,
      noiseSuppression: !filtered && (settings.noiseSuppression ?? true),
      autoGainControl: settings.autoGainControl ?? true,
      ...device(settings.deviceId),
    },
    video: false,
  };
}

export function cameraConstraints(deviceId?: string): MediaStreamConstraints {
  // TypeScript's DOM types do not know resizeMode yet; every engine that does
  // not either ignores it.
  const video: MediaTrackConstraints & { resizeMode?: string } = {
    // 360p went soft as soon as a tile was bigger than a thumbnail. The
    // encoder still steps down on its own when the network cannot keep up.
    width: { ideal: 960, max: 1280 },
    height: { ideal: 540, max: 720 },
    frameRate: { ideal: 24, max: 30 },
    // Without it Chromium may hand over a camera's full 1080p untouched (a
    // virtual camera opened while its source is in use did), and a mesh
    // sends that to everyone.
    resizeMode: "crop-and-scale",
    ...device(deviceId),
  };
  return { video, audio: false };
}

export interface MediaDeviceOption {
  id: string;
  label: string;
}

/** The devices this computer has, for choosing between them. */
export interface MediaDeviceLists {
  microphones: MediaDeviceOption[];
  cameras: MediaDeviceOption[];
  speakers: MediaDeviceOption[];
  /**
   * Whether the browser gave the devices' names. It keeps them back until a
   * page has been allowed the microphone or camera once.
   */
  named: boolean;
  /** What the system's default microphone and speaker are called, where it says. */
  defaultMicrophone: string;
  defaultSpeaker: string;
}

/** Chromium's stand-ins for whatever the system's default is, not devices of their own. */
const ALIASES = new Set(["", "default", "communications"]);

/** Every microphone, camera and speaker, without the browser's stand-ins for the default. */
export async function listMediaDevices(): Promise<MediaDeviceLists> {
  const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  const of = (kind: MediaDeviceKind, noun: string) =>
    all
      .filter((d) => d.kind === kind && !ALIASES.has(d.deviceId))
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${noun} ${i + 1}` }));
  const defaultOf = (kind: MediaDeviceKind) =>
    all
      .find((d) => d.kind === kind && d.deviceId === "default")
      ?.label.replace(/^Default - /, "") ?? "";
  return {
    microphones: of("audioinput", "Microphone"),
    cameras: of("videoinput", "Camera"),
    speakers: of("audiooutput", "Speaker"),
    named: all.some((d) => d.label !== ""),
    defaultMicrophone: defaultOf("audioinput"),
    defaultSpeaker: defaultOf("audiooutput"),
  };
}

/** Whether this browser can play sound through a speaker other than the default. */
export function canChooseSpeaker(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
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

/** How often a microphone's level is measured. */
export const LEVEL_POLL_MS = 120;

/** What the browser would have said, had it offered a way to ask at all. */
export function unsupported(kind: string): DOMException {
  return new DOMException(`No way to reach the ${kind} here.`, "NotSupportedError");
}

/** The loudest of the latest samples, from 0 (silence) to 1. */
function peakLevel(analyser: AnalyserNode, samples: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(samples);
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
  return peak / 128;
}

/** How loud a microphone is, read when asked. */
export interface LevelMeter {
  /** The loudest of the latest samples, from 0 (silence) to 1. */
  level(): number;
  stop(): void;
}

/**
 * A meter on the microphone's sound, or null where the browser cannot
 * measure sound. It listens to a copy of the track that muting leaves on, so
 * talking while muted can be pointed out; nothing of the copy is sent.
 */
export function levelMeter(stream: MediaStream): LevelMeter | null {
  const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctx) return null;
  let context: AudioContext | null = null;
  let copy: MediaStreamTrack | null = null;
  try {
    context = new Ctx();
    void context.resume().catch(() => {});
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    const track = stream.getAudioTracks()[0];
    copy = typeof track?.clone === "function" ? track.clone() : null;
    if (copy) copy.enabled = true;
    context.createMediaStreamSource(copy ? new MediaStream([copy]) : stream).connect(analyser);
    const samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    const opened = context;
    const listened = copy;
    return {
      level: () => peakLevel(analyser, samples),
      stop() {
        listened?.stop();
        void opened.close().catch(() => {});
      },
    };
  } catch {
    // Showing a level is a nicety: the microphone works without one.
    copy?.stop();
    void context?.close().catch(() => {});
    return null;
  }
}

/** An error in a few words, for the call log. */
export function describeError(err: unknown): string {
  if (err instanceof Error)
    return err.name && err.name !== "Error" ? `${err.name}: ${err.message}` : err.message;
  return String(err);
}

/** A microphone as a call or a test hears it: the device's own sound, or that sound cleaned. */
export interface MicrophoneFeed {
  /** What it hears, cleaned when `filtered`. */
  stream: MediaStream;
  /** The device itself, whose ending means it went: unplugged, or its permission. */
  device: MediaStreamTrack | undefined;
  /** In place of `device`, a microphone the system opened, which says itself when it goes. */
  system?: SystemMicrophone;
  /** The device's name, where it is known; empty otherwise. */
  label: string;
  /** Whether it went through the strong noise filter. */
  filtered: boolean;
  /** Closes the device and anything made from it. */
  stop(): void;
}

export interface MicrophoneOpeners {
  noiseFilter?: NoiseFilter;
  systemMicrophone?: OpenSystemMicrophone;
}

/**
 * Opens the microphone with these settings, through the strong noise filter
 * when it is chosen and there is one. A filter that will not start costs
 * nothing: the microphone opens again with the browser's own suppression,
 * and `note` says so. A saved microphone that is not connected opens the
 * default; one `chosenNow` does not. With none of the browser's processing
 * chosen, the system opens it where the app can (see `SystemMicrophone`).
 * Rejects as the browser does, for `captureFailure` to word.
 */
export async function openMicrophone(
  settings: MicrophoneSettings,
  openers: MicrophoneOpeners,
  {
    chosenNow = false,
    note = () => {},
  }: { chosenNow?: boolean; note?: (line: string) => void } = {},
): Promise<MicrophoneFeed> {
  if (!navigator.mediaDevices?.getUserMedia) throw unsupported("microphone");
  const filter = wantsNoiseFilter(settings) ? openers.noiseFilter : undefined;
  const plain = (stream: MediaStream): MicrophoneFeed => {
    const device = stream.getAudioTracks()[0];
    return {
      stream,
      device,
      label: device?.label ?? "",
      filtered: false,
      stop: () => stream.getTracks().forEach((track) => track.stop()),
    };
  };
  let missing = false;
  const onMissing = () => {
    missing = true;
    note("The chosen microphone is not connected; using the system's default.");
  };
  const open = (filtered: boolean) => {
    const ask = (deviceId: string | undefined) =>
      navigator.mediaDevices.getUserMedia(
        microphoneConstraints({ ...settings, deviceId }, filtered),
      );
    if (chosenNow) return ask(settings.deviceId);
    return openSaved(missing ? undefined : settings.deviceId, ask, onMissing);
  };
  const source =
    (await openSystemMicrophone(settings, openers, chosenNow, !!filter, onMissing, note)) ??
    plain(await open(!!filter));
  if (!filter) {
    note(
      settings.noiseSuppression === false
        ? "Noise suppression: off."
        : "Noise suppression: the browser's own.",
    );
    return source;
  }
  try {
    const filtered = await filter(source.stream);
    note("Noise suppression: strong.");
    return {
      ...source,
      stream: filtered.stream,
      filtered: true,
      stop: () => {
        filtered.stop();
        source.stop();
      },
    };
  } catch (err) {
    source.stop();
    note(
      `Strong noise suppression did not start (${describeError(err)}); using the browser's own.`,
    );
    return plain(await open(false));
  }
}

/**
 * The microphone as the system opens it, when the app can and none of the
 * browser's processing is chosen (`filtered`: the strong filter stands in for
 * its noise suppression). Null otherwise, or when it does not open, for the
 * browser to open it.
 */
async function openSystemMicrophone(
  settings: MicrophoneSettings,
  { systemMicrophone }: MicrophoneOpeners,
  chosenNow: boolean,
  filtered: boolean,
  onMissing: () => void,
  note: (line: string) => void,
): Promise<MicrophoneFeed | null> {
  if (!systemMicrophone || !wantsSystemMicrophone(settings, filtered)) return null;
  let system: SystemMicrophone | null;
  try {
    system = chosenNow
      ? await systemMicrophone(settings.deviceId)
      : await openSaved(settings.deviceId, systemMicrophone, onMissing);
  } catch (err) {
    note(`The system did not open the microphone (${describeError(err)}); the browser does.`);
    return null;
  }
  if (!system) {
    note("The system could not tell which microphone this is; the browser opens it.");
    return null;
  }
  note("The microphone opened as other apps hear it, with the system's sound effects.");
  const opened = system;
  return {
    stream: opened.stream,
    device: undefined,
    system: opened,
    label: opened.label,
    filtered: false,
    stop: () => opened.stop(),
  };
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
  /** Whether the system opened it, as other apps on this computer hear it. */
  system: boolean;
  /** Closes the microphone. Safe to call more than once. */
  stop(): void;
}

/**
 * Opens the microphone the way a huddle would with the settings being tried
 * and reports how loud it is several times a second, until stopped, so
 * someone can check it before a call and hear what others would. Nothing is
 * sent anywhere.
 */
export async function testMicrophone(
  onLevel: (level: number) => void,
  settings: MicrophoneSettings = {},
  noiseFilter?: NoiseFilter,
  systemMicrophone?: OpenSystemMicrophone,
): Promise<MicrophoneTest> {
  const feed = await openMicrophone(settings, { noiseFilter, systemMicrophone });
  const meter = levelMeter(feed.stream);
  let timer = meter ? setInterval(() => onLevel(meter.level()), LEVEL_POLL_MS) : null;
  let stopped = false;
  return {
    label: feed.label,
    stream: feed.stream,
    metered: meter !== null,
    filtered: feed.filtered,
    system: feed.system !== undefined,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      meter?.stop();
      feed.stop();
    },
  };
}
