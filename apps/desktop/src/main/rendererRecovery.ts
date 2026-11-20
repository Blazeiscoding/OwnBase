/**
 * What the main window does when its page dies or fails to load (REV-09).
 * The window is only a view: hosting, backups and the tray live in the main
 * process and carry on. So the page is loaded again, a few times, and if it
 * keeps failing the person is asked rather than left with a blank window or
 * a window that reloads forever.
 */
export const RENDERER_RECOVERY = {
  /** How many failures within `windowMs` are reloaded before asking. */
  maxReloads: 3,
  windowMs: 60_000,
  /** A pause before reloading, so a page that dies at once does not spin. */
  reloadDelayMs: 500,
} as const;

export type RecoveryStep = "reload" | "ask";

export class RendererRecovery {
  private failures: number[] = [];

  /** The page died or did not load: whether to load it again, or to ask. */
  failed(): RecoveryStep {
    const at = Date.now();
    this.failures = this.failures.filter((time) => at - time < RENDERER_RECOVERY.windowMs);
    this.failures.push(at);
    return this.failures.length <= RENDERER_RECOVERY.maxReloads ? "reload" : "ask";
  }

  /** Someone asked to try again: their try starts a fresh count. */
  reset(): void {
    this.failures = [];
  }
}

/**
 * Whether a failed load is one to recover from: the window's own page, not
 * a frame inside it, and not a navigation that something newer replaced.
 */
export function isRendererLoadFailure(errorCode: number, isMainFrame: boolean): boolean {
  // -3 is ERR_ABORTED: another navigation took over, which is not a failure.
  return isMainFrame && errorCode !== -3;
}

const PLACE_MAX_BYTES = 32 * 1024;

/** A place as the page reports it: its address and its history entry's state. */
export interface Place {
  url: string;
  state: unknown;
}

/**
 * Where the window's page was, kept outside the page so recovery can put it
 * back (F08). Reloading after a crash keeps the address but not the history
 * entry, and the entry is what holds an open side panel, thread, dialog and
 * reading position, for which workspace; Try again used to start from the
 * bare page. The page reports its place as it changes; a recovery loads
 * that address and hands the entry back, once, to the page that loads next.
 * The page checks the entry names the workspace it shows before using it,
 * as it does any history entry, so one workspace's place never opens
 * another's. Only the app's own page, and only a small, plain value.
 */
export class PlaceCheckpoint {
  private place: Place | null = null;
  private restoring: Place | null = null;

  constructor(private readonly trusted: (url: string) => boolean) {}

  /** Notes where the page is now. Says whether it was taken. */
  remember(url: unknown, state: unknown): boolean {
    if (typeof url !== "string" || !this.trusted(url)) return false;
    let json: string | undefined;
    try {
      json = JSON.stringify(state ?? null);
    } catch {
      return false;
    }
    if (json === undefined || json.length > PLACE_MAX_BYTES) return false;
    this.place = { url, state: JSON.parse(json) as unknown };
    return true;
  }

  /**
   * A recovery is starting: the address to load, if a place is known, and
   * the entry the next page asks for is armed.
   */
  recover(): string | null {
    this.restoring = this.place;
    return this.place?.url ?? null;
  }

  /** The entry the page loading after a recovery starts from; given once. */
  take(): unknown {
    const restoring = this.restoring;
    this.restoring = null;
    return restoring?.state ?? null;
  }

  /** Starts afresh: nothing remembered, nothing handed back. */
  forget(): void {
    this.place = null;
    this.restoring = null;
  }
}
