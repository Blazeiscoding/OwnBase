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
export function peakLevel(analyser: AnalyserNode, samples: Uint8Array<ArrayBuffer>): number {
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
  /** Whether the system opened it, as other apps on this computer hear it. */
  system: boolean;
  /** Closes the microphone. Safe to call more than once. */
  stop(): void;
}

/**
 * Opens the microphone the way a huddle would with the settings being tried,
 * through the strong noise filter when it is chosen, and reports how loud it
 * is several times a second, until stopped, so someone can check it before a
 * call and hear what others would. Nothing is sent anywhere. Rejects as
 * `startLocalAudio` does, for `captureFailure` to word. As in a call, the
 * system opens it where the app can and none of the browser's processing is
 * chosen.
 */
export async function testMicrophone(
  onLevel: (level: number) => void,
  settings: MicrophoneSettings = {},
  noiseFilter?: NoiseFilter,
  systemMicrophone?: OpenSystemMicrophone,
): Promise<MicrophoneTest> {
  if (!navigator.mediaDevices?.getUserMedia) throw unsupported("microphone");
  const filter = wantsNoiseFilter(settings) ? noiseFilter : undefined;
  let system: SystemMicrophone | null = null;
  if (systemMicrophone && wantsSystemMicrophone(settings, !!filter)) {
    // As in a call: the browser opens it when the system does not.
    system = await systemMicrophone(settings.deviceId).catch(() => null);
  }
  let device: MediaStream | null = system
    ? null
    : await navigator.mediaDevices.getUserMedia(microphoneConstraints(settings, !!filter));
  let filtered: FilteredMicrophone | null = null;
  if (filter) {
    try {
      filtered = await filter(system?.stream ?? device!);
    } catch {
      // As in a call: the browser's own suppression stands in.
      system?.stop();
      system = null;
      device?.getTracks().forEach((track) => track.stop());
      device = await navigator.mediaDevices.getUserMedia(microphoneConstraints(settings));
    }
  }
  const stream = filtered?.stream ?? system?.stream ?? device!;
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
    label: system?.label ?? device?.getAudioTracks()[0]?.label ?? "",
    stream,
    metered: timer !== null,
    filtered: filtered !== null,
    system: system !== null,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      filtered?.stop();
      filtered = null;
      system?.stop();
      device?.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => {});
      context = null;
    },
  };
}
