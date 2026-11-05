import { useEffect } from "react";
import { isMessageOnScreen, type OnScreen } from "@ownbase/client-core";
import type { ID, Message } from "@ownbase/protocol";

/**
 * Where the focused window of this browser is looking, so the others of the
 * same account stay quiet about it. Every window hears every message, and one
 * in the background used to notify about a mention the focused one was
 * reading. Only one window of a browser has focus at a time, so one record
 * does: the focused window writes it, and takes it back when it loses focus,
 * hides or closes.
 */
export interface FocusedView {
  /** Which window wrote it, so a window never reads its own or clears another's. */
  window: string;
  /** previewAccount: the server and the person signed in. */
  account: string;
  channelId: ID | null;
  threadRootId: ID | null;
  channelVisible: boolean;
  threadVisible: boolean;
  /** When it was written; the focused window writes it again while it stays focused. */
  at: number;
}

/** Kept in localStorage itself, outside the device store: it is read synchronously as a message arrives. */
export const FOCUSED_VIEW_KEY = "ownbase-focused-view";

/** How often the focused window writes its record again. */
export const FOCUSED_VIEW_REFRESH_MS = 30_000;

/** A record older than this was left by a window that went without saying (a crash). */
const STALE_MS = 2 * FOCUSED_VIEW_REFRESH_MS + 15_000;

/** This window, for the life of the page. */
export const THIS_WINDOW = Math.random().toString(36).slice(2, 12);

function read(): FocusedView | null {
  try {
    const raw = localStorage.getItem(FOCUSED_VIEW_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<FocusedView> | null;
    if (
      !value ||
      typeof value.window !== "string" ||
      typeof value.account !== "string" ||
      typeof value.at !== "number"
    )
      return null;
    return {
      window: value.window,
      account: value.account,
      channelId: typeof value.channelId === "string" ? value.channelId : null,
      threadRootId: typeof value.threadRootId === "string" ? value.threadRootId : null,
      channelVisible: value.channelVisible === true,
      threadVisible: value.threadVisible === true,
      at: value.at,
    };
  } catch {
    return null;
  }
}

/** Says where this window, now focused, is looking. */
export function writeFocusedView(
  view: Omit<FocusedView, "window" | "at">,
  window = THIS_WINDOW,
  now = Date.now(),
): void {
  try {
    localStorage.setItem(FOCUSED_VIEW_KEY, JSON.stringify({ ...view, window, at: now }));
  } catch {
    // Storage full or refused: windows notify as they did before.
  }
}

/** Takes back this window's record, leaving one another window wrote since. */
export function clearFocusedView(window = THIS_WINDOW): void {
  try {
    if (read()?.window === window) localStorage.removeItem(FOCUSED_VIEW_KEY);
  } catch {
    // As above.
  }
}

/**
 * Whether another window of this account, focused now, shows the message:
 * the same test a window applies to itself.
 */
export function onScreenElsewhere(
  message: Message,
  account: string | null,
  window = THIS_WINDOW,
  now = Date.now(),
): boolean {
  if (!account) return false;
  const view = read();
  if (!view || view.window === window || view.account !== account) return false;
  if (now - view.at > STALE_MS || view.at - now > STALE_MS) return false;
  const screen: OnScreen = {
    focused: true,
    channelId: view.channelId,
    channelVisible: view.channelVisible,
    threadRootId: view.threadRootId,
    threadVisible: view.threadVisible,
  };
  return isMessageOnScreen(message, screen);
}

/**
 * Keeps this window's record while it has focus and can be seen, and takes it
 * back when either ends. Written again on every change of what it shows, and
 * now and then while nothing changes, so a record nobody refreshes goes stale.
 */
export function useFocusedView(
  account: string | null,
  view: Pick<FocusedView, "channelId" | "threadRootId" | "channelVisible" | "threadVisible">,
): void {
  const { channelId, threadRootId, channelVisible, threadVisible } = view;
  useEffect(() => {
    if (!account) return;
    const write = () => {
      if (document.hasFocus() && document.visibilityState !== "hidden")
        writeFocusedView({ account, channelId, threadRootId, channelVisible, threadVisible });
      else clearFocusedView();
    };
    const leave = () => clearFocusedView();
    write();
    const timer = setInterval(write, FOCUSED_VIEW_REFRESH_MS);
    window.addEventListener("focus", write);
    window.addEventListener("blur", leave);
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", write);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", write);
      window.removeEventListener("blur", leave);
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", write);
      clearFocusedView();
    };
  }, [account, channelId, threadRootId, channelVisible, threadVisible]);
}
