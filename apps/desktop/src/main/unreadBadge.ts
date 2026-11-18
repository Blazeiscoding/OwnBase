/**
 * What waits, outside the window (J16): a circle with the count on the
 * Windows taskbar button, the count on the Mac dock, and the tray icon with a
 * dot. The page says what to show (`unread:set`); this module only draws it,
 * from images the icon script made (apps/desktop/build/badge-*.png).
 */

export interface Unread {
  count: number;
  dot: boolean;
}

const NONE: Unread = { count: 0, dot: false };

/** What the module draws on, so tests can stand in for Electron. */
export interface UnreadSurfaces {
  platform: NodeJS.Platform;
  /** The taskbar button's overlay: an image file in the tray folder, or none. */
  overlay(file: string | null, description: string): void;
  /** The Mac dock's badge; "" for none. */
  dock(text: string): void;
  /** The tray icon: its own, or the one with a dot. */
  tray(unread: boolean): void;
}

/** One update at most in this long: counts change in bursts. */
const THROTTLE_MS = 250;

/** The overlay image for what waits, or none. */
export function badgeFile({ count, dot }: Unread): string | null {
  if (count > 9) return "badge-9plus.png";
  if (count > 0) return `badge-${count}.png`;
  return dot ? "badge-dot.png" : null;
}

/** What a screen reader says of the overlay. */
function described({ count, dot }: Unread): string {
  if (count > 0) return `${count} unread ${count === 1 ? "mention" : "mentions"}`;
  return dot ? "Unread messages" : "";
}

/** What the page sent, checked: it comes over IPC. */
export function readUnread(value: unknown): Unread {
  const { count, dot } = (value ?? {}) as { count?: unknown; dot?: unknown };
  return {
    count: typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    dot: dot === true,
  };
}

export class UnreadIndicator {
  private shown: Unread | null = null;
  private wanted: Unread = NONE;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly surfaces: UnreadSurfaces) {}

  set(unread: Unread): void {
    this.wanted = unread;
    if (this.timer) return;
    this.flush();
  }

  /** Draws it again, on a window made again. */
  reapply(): void {
    this.draw(this.wanted);
  }

  /** Takes everything off at once, as the app quits. */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wanted = NONE;
    this.draw(NONE);
  }

  private flush(): void {
    const next = this.wanted;
    if (this.shown && this.shown.count === next.count && this.shown.dot === next.dot) return;
    this.draw(next);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, THROTTLE_MS);
  }

  private draw(unread: Unread): void {
    this.shown = unread;
    const { platform } = this.surfaces;
    if (platform === "win32") this.surfaces.overlay(badgeFile(unread), described(unread));
    if (platform === "darwin")
      this.surfaces.dock(unread.count > 0 ? String(unread.count) : unread.dot ? "•" : "");
    this.surfaces.tray(unread.count > 0 || unread.dot);
  }
}

/** What `electronSurfaces` needs of Electron, passed in so this file never imports it. */
interface ElectronParts<Image> {
  platform: NodeJS.Platform;
  /** The path of an image in the tray folder (`extraResources`, or build/ in development). */
  file(name: string): string;
  image(path: string): Image & { resize(size: { width: number; height: number }): Image };
  window(): {
    isDestroyed(): boolean;
    setOverlayIcon(image: Image | null, description: string): void;
  } | null;
  dock: { setBadge(text: string): void } | undefined;
  tray(): { setImage(image: Image | string): void } | null;
}

/** The surfaces as Electron draws them. */
export function electronSurfaces<Image>(e: ElectronParts<Image>): UnreadSurfaces {
  return {
    platform: e.platform,
    overlay: (file, description) => {
      const win = e.window();
      if (win && !win.isDestroyed())
        win.setOverlayIcon(file ? e.image(e.file(file)) : null, description);
    },
    dock: (text) => e.dock?.setBadge(text),
    tray: (unread) => {
      const tray = e.tray();
      if (!tray) return;
      // As createTray sets it: the ICO's own sizes on Windows, 18 pixels elsewhere.
      if (e.platform === "win32") tray.setImage(e.file(unread ? "tray-unread.ico" : "icon.ico"));
      else
        tray.setImage(
          e
            .image(e.file(unread ? "tray-unread.png" : "icon.png"))
            .resize({ width: 18, height: 18 }),
        );
    },
  };
}
