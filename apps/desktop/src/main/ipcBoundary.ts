import type { Args, Channel, Reply, Result } from "../shared/bridge.js";
import { toFailure } from "../shared/desktopError.js";

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
 * The windows allowed to hear what the main process pushes (F09): invite
 * links, hosting, workspaces found nearby. The same rule as for
 * requests: the app's own window, live, showing the app's page. Any other
 * window, one loading the same preload or the app's window navigated away,
 * hears nothing, though it is refused only when it asks.
 */
export function appRecipients<W extends Recipient>(
  window: W | null,
  trusted: (url: string) => boolean,
): W[] {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return [];
  return trusted(window.webContents.getURL()) ? [window] : [];
}

/** What a refused request is told; it names no channel and echoes no input. */
export const REFUSED = "This request did not come from the OwnBase window.";

/** A call's arguments as they arrive: the window says what they are, but nothing checks it. */
export type Untrusted<A extends unknown[]> = { [K in keyof A]: unknown };

/** How the main process answers one call: whatever the contract says it resolves to. */
export type Handler<C extends Channel, Event = unknown> = (
  event: Event,
  ...args: Untrusted<Args<C>>
) => Result<C> | Promise<Result<C>>;

export type Handlers<Event, C extends Channel = Channel> = { [K in C]: Handler<K, Event> };

/**
 * Wraps a handler so it runs only for the trusted window, refusing anything
 * else before any of its work starts, and answers with what it resolved to
 * or why it failed. Nothing rejects through Electron, which would wrap the
 * reason in words of its own and drop its code.
 */
export function answering<Event extends IpcSender, C extends Channel>(
  window: () => TrustedWindow | null,
  trusted: (url: string) => boolean,
  handler: Handler<C, Event>,
): (event: Event, ...args: unknown[]) => Promise<Reply<C>> {
  return async (event, ...args) => {
    if (!fromTrustedWindow(event, window(), trusted))
      return { ok: false, error: { code: "refused", message: REFUSED } };
    try {
      return { ok: true, value: await handler(event, ...(args as Untrusted<Args<C>>)) };
    } catch (error) {
      return { ok: false, error: toFailure(error) };
    }
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
