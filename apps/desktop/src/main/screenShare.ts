/**
 * The desktop app's own screen picker (CALL-01). The window lists what can be
 * shared, with a picture of each, and names the one chosen; the
 * getDisplayMedia request that follows shares that one. Nothing here needs
 * Electron, so it can be exercised without it.
 */

/** A screen or window as the renderer receives it. */
export interface ShareableSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** A picture of it as a data URL, or "" while there is none yet. */
  thumbnail: string;
  /** The icon of the app that owns a window as a data URL, or "" for a screen or an app without one. */
  icon: string;
}

/** What is read from Electron's `NativeImage`. */
interface Picture {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(size: { width: number; height: number; quality?: "best" }): Picture;
  toBitmap(): Uint8Array;
  toDataURL(): string;
  toJPEG(quality: number): Uint8Array;
}

/** What is read from Electron's `DesktopCapturerSource`. */
export interface CapturedSource {
  id: string;
  name: string;
  thumbnail: Picture;
  appIcon: Picture | null;
}

/** What the picker's pictures are drawn from: big enough for a sharp tile on a high-density screen. */
export const THUMBNAIL_SIZE = { width: 480, height: 270 };
/** Icons are drawn at 20 px, so 64 stays sharp at three times that and keeps the list small. */
const ICON_SIZE = 64;

/** A screen's id starts `screen:`, a window's `window:`. */
const kindOf = (id: string): ShareableSource["kind"] =>
  id.startsWith("screen:") ? "screen" : "window";

/** Electron names a single screen "Entire Screen"; the app's titles use sentence case. */
const nameOf = (source: { id: string; name: string }) =>
  kindOf(source.id) === "screen" && /^entire screen$/i.test(source.name)
    ? "Entire screen"
    : source.name;

/**
 * Whether a window's picture shows nothing: none at all, or black to the
 * last pixel. That is what the system gives for a window it cannot capture,
 * which is no window anyone means to share: one an app in the tray keeps
 * open out of sight (Raycast's), or an overlay drawn over games (NVIDIA's).
 * A minimized window is not listed at all. Every pixel is read, so a dark
 * window with a line of text in it still counts as showing something.
 */
export function blank(picture: Picture): boolean {
  if (picture.isEmpty()) return true;
  const bitmap = picture.toBitmap();
  // Blue, green and red, then alpha, which is left out.
  for (let i = 0; i < bitmap.length; i += 4) {
    if (bitmap[i] || bitmap[i + 1] || bitmap[i + 2]) return false;
  }
  return true;
}

/** A source as the picker shows it. */
function describe(source: CapturedSource): ShareableSource {
  let icon = "";
  if (source.appIcon && !source.appIcon.isEmpty()) {
    const { width } = source.appIcon.getSize();
    icon = (
      width > ICON_SIZE
        ? source.appIcon.resize({ width: ICON_SIZE, height: ICON_SIZE, quality: "best" })
        : source.appIcon
    ).toDataURL();
  }
  return {
    id: source.id,
    name: nameOf(source),
    kind: kindOf(source.id),
    thumbnail: source.thumbnail.isEmpty()
      ? ""
      : `data:image/jpeg;base64,${Buffer.from(source.thumbnail.toJPEG(75)).toString("base64")}`,
    icon,
  };
}

const screensFirst = (sources: ShareableSource[]) => [
  ...sources.filter((source) => source.kind === "screen"),
  ...sources.filter((source) => source.kind === "window"),
];

/**
 * What the picker lists. Taking a picture of every window is slow: each one
 * the system cannot capture costs it about a second before it gives up, and
 * hidden windows like that are common. So the last full list is kept, and a
 * picker opening again is answered at once from it, with a list of names,
 * which is quick, saying which of those windows are still open.
 */
export class SourceList {
  private last: Map<string, ShareableSource> | null = null;
  private running: Promise<ShareableSource[]> | null = null;

  /** `capture` lists every screen and window, with pictures and icons or without. */
  constructor(private readonly capture: (pictures: boolean) => Promise<CapturedSource[]>) {}

  /**
   * Every screen, and every window showing something, each with a picture
   * taken now. Asked again while one is being made, it answers with that one.
   */
  full(): Promise<ShareableSource[]> {
    this.running ??= this.capture(true)
      .then((sources) => {
        const shown = sources
          .filter((source) => kindOf(source.id) === "screen" || !blank(source.thumbnail))
          .map(describe);
        this.last = new Map(shown.map((source) => [source.id, source]));
        return screensFirst(shown);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /**
   * The last full list, with its pictures, less what has closed since and
   * with names as they are now; null before there has been one. A window
   * opened since waits for the next full list, which can tell whether it
   * shows anything.
   */
  async quick(): Promise<ShareableSource[] | null> {
    const last = this.last;
    if (!last) return null;
    const open = await this.capture(false);
    return screensFirst(
      open.flatMap((source) => {
        const known = last.get(source.id);
        return known ? [{ ...known, name: nameOf(source) }] : [];
      }),
    );
  }
}

/** What getDisplayMedia is given: Electron needs only the id and a name. */
export interface ChosenSource {
  id: string;
  name: string;
}

/**
 * The source chosen in the picker, if it is still there. Rejects, in words
 * the picker shows, a source that has gone since the list was drawn.
 */
export async function findSource(
  id: unknown,
  list: () => Promise<{ id: string; name: string }[]>,
): Promise<ChosenSource> {
  if (typeof id !== "string" || !id) throw new Error("Choose a screen or window to share.");
  const found = (await list()).find((source) => source.id === id);
  if (!found) {
    throw new Error(
      kindOf(id) === "screen"
        ? "That screen is no longer connected. Choose another."
        : "That window has closed. Choose another.",
    );
  }
  return { id: found.id, name: nameOf(found) };
}

/**
 * Whether this system can share a screen's sound with the app's own left out
 * of it: Windows 10 version 2004 (build 19041) and later, which can record
 * the speakers less one app's sound. Electron's macOS loopback needs a
 * permission this app does not ask for, and Linux has none, so there a share
 * is its picture only.
 */
export function screenSoundSupported(platform: string, systemVersion: string): boolean {
  if (platform !== "win32") return false;
  const [major = 0, , build = 0] = systemVersion.split(".").map(Number);
  return major > 10 || (major === 10 && build >= 19041);
}

/**
 * What a getDisplayMedia request is answered with. "loopback" is what the
 * speakers play; asked for with `restrictOwnAudio`, as the huddle does,
 * Electron records it without this app's own sound (Chromium's
 * "loopbackWithoutChrome"), so the call is not sent back to itself.
 */
export interface ShareStreams {
  video: ChosenSource;
  audio?: "loopback";
}

/**
 * Holds the picker's choice for the getDisplayMedia request it is made for,
 * which comes moments later. It is used once, and only while fresh: a request
 * the picker did not just answer shares nothing.
 */
export class ScreenChoice {
  private held: { source: ChosenSource; sound: boolean; at: number } | null = null;

  constructor(
    private readonly freshForMs = 15_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** `sound`: the picker allowed the screen's sound, where this system can share it. */
  hold(source: ChosenSource, sound = false): void {
    this.held = { source, sound, at: this.now() };
  }

  /**
   * What to share, once, if the choice was made within the last few seconds;
   * otherwise null. The sound goes only when the page asked for it too.
   */
  take(audioRequested = false): ShareStreams | null {
    const held = this.held;
    this.held = null;
    if (!held || this.now() - held.at > this.freshForMs) return null;
    return held.sound && audioRequested
      ? { video: held.source, audio: "loopback" }
      : { video: held.source };
  }
}
