/**
 * Who may ask the main process for work (REV-14). Every request reaches the
 * same handlers: saved credentials and settings, hosting, files on disk. So
 * each one must come from the app's own window, from its top frame, showing
 * the app's own page, and not from another window that happens to load the
 * same preload, or a frame inside the page. This does not defend against
 * script already running in the app's own page: that page is the app.
 */

/** The parts of an IPC event the boundary reads. */
export interface IpcSender {
  sender: { id: number };
  senderFrame: {
    url: string;
    processId: number;
    routingId: number;
    parent: unknown;
  } | null;
}

/** The parts of the main window the boundary reads. */
export interface TrustedWindow {
  isDestroyed(): boolean;
  webContents: {
    id: number;
    isDestroyed(): boolean;
    mainFrame: { processId: number; routingId: number };
  };
}

/**
 * Whether a URL is the app's own page: the same origin and path it was
 * loaded from, the dev server's or the packaged file's. Its query and hash
 * may differ, since the app keeps its place in the hash.
 */
export function rendererUrlTrust(rendererUrl: string): (url: string) => boolean {
  const expected = new URL(rendererUrl);
  return (url) => {
    try {
      const parsed = new URL(url);
      return parsed.origin === expected.origin && parsed.pathname === expected.pathname;
    } catch {
      return false;
    }
  };
}

/** Whether a request came from the live main window's top frame, showing the app. */
export function fromTrustedWindow(
  event: IpcSender,
  window: TrustedWindow | null,
  trusted: (url: string) => boolean,
): boolean {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
  if (event.sender.id !== window.webContents.id) return false;
  const frame = event.senderFrame;
  // Gone already (navigated away or closed), or a frame inside the page.
  if (!frame || frame.parent) return false;
  const top = window.webContents.mainFrame;
  if (frame.processId !== top.processId || frame.routingId !== top.routingId) return false;
  return trusted(frame.url);
}

/** The parts of a window a push to the app reads. */
export interface Recipient {
  isDestroyed(): boolean;
  webContents: { id: number; isDestroyed(): boolean; getURL(): string };
}

/**
 * The windows allowed to hear what the main process pushes (F09): drafts,
 * unsent messages, choices, invite links, hosting. The same rule as for
 * requests: the app's own window, live, showing the app's page. Any other
 * window, one loading the same preload or the app's window navigated away,
 * hears nothing, though it is refused only when it asks. `except` leaves out
 * the window whose own change is being told to the rest.
 */
export function appRecipients<W extends Recipient>(
  window: W | null,
  trusted: (url: string) => boolean,
  except?: number,
): W[] {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return [];
  if (window.webContents.id === except) return [];
  return trusted(window.webContents.getURL()) ? [window] : [];
}

/** What a refused request is told; it names no channel and echoes no input. */
export const REFUSED = "This request did not come from the OwnBase window.";

/**
 * Wraps a handler so it runs only for the trusted window, refusing anything
 * else before any of its work starts.
 */
export function guarded<Event extends IpcSender, Args extends unknown[], Result>(
  window: () => TrustedWindow | null,
  trusted: (url: string) => boolean,
  handler: (event: Event, ...args: Args) => Result,
): (event: Event, ...args: Args) => Result {
  return (event, ...args) => {
    if (!fromTrustedWindow(event, window(), trusted)) throw new Error(REFUSED);
    return handler(event, ...args);
  };
}

/**
 * A settings key the renderer may read or write. Keys name a workspace by
 * its address, so they hold slashes, colons and brackets; they are property
 * names in one settings file, so length and control characters are what to
 * refuse.
 */
export function settingKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024 || /\p{Cc}/u.test(key))
    throw new Error("Not a settings key.");
  return key;
}
