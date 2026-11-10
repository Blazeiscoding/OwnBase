import { useEffect, useLayoutEffect, useRef } from "react";
import { hasOpenModal } from "../components/Modal.js";
import { isImeKey, type KeyLike } from "./textInput.js";

/**
 * Whether a key press is the page's to act on: not already used, not part of
 * a word an input method is assembling, and not taken by a dialog in front,
 * which owns its keys. A shortcut must not replace a busy dialog, or let its
 * Escape dismiss what is behind it as well.
 */
export function pageKey(event: KeyLike & { defaultPrevented: boolean }): boolean {
  return !event.defaultPrevented && !hasOpenModal() && !isImeKey(event);
}

/**
 * Listens for keys anywhere in the window while mounted. The handler may
 * change every render; the listener stays the same one.
 */
export function useWindowKeys(handler: (event: KeyboardEvent) => void, enabled = true): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => latest.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/**
 * Moves focus once the change that asked for it has been drawn: the element
 * to focus may only exist, or only be focusable, after that render. Returns
 * the function that asks; the last ask before a render wins.
 */
export function useFocusAfterRender(): (target: () => HTMLElement | null | undefined) => void {
  const pending = useRef<(() => HTMLElement | null | undefined) | null>(null);
  useLayoutEffect(() => {
    const target = pending.current;
    if (!target) return;
    pending.current = null;
    target()?.focus();
  });
  return (target) => {
    pending.current = target;
  };
}

/**
 * Keeps keyboard focus near a control that is about to go, such as a row's
 * Mark read: once a render has taken away the element that held focus, focus
 * moves to what `fallback` names. It waits as many renders as the removal
 * takes, which may be a server's answer, and gives up once focus has moved
 * anywhere else.
 */
export function useFocusWhenGone(): (fallback: () => HTMLElement | null | undefined) => void {
  const pending = useRef<{
    from: Element | null;
    fallback: () => HTMLElement | null | undefined;
  } | null>(null);
  useLayoutEffect(() => {
    const ask = pending.current;
    if (!ask) return;
    const active = document.activeElement;
    if (active && active !== document.body) {
      if (active !== ask.from) pending.current = null;
      return;
    }
    pending.current = null;
    ask.fallback()?.focus();
  });
  return (fallback) => {
    pending.current = { from: document.activeElement, fallback };
  };
}
