import { useCallback, useEffect, useRef } from "react";
import type React from "react";

const MESSAGE = '[role="article"]';
const CONTROL = "a[href], button, input, select, textarea, [tabindex]";
/** Marks a control this hook took out of the Tab order, so it can put it back. */
const TAKEN = "data-roving-out";

type Move = (messages: HTMLElement[], at: number) => HTMLElement | undefined;

/** The keys of a list of messages, as the shortcut sheet shows them, and where each moves to. */
export const MESSAGE_LIST_KEYS: readonly {
  key: string;
  label: string;
  describe: string;
  to?: Move;
}[] = [
  { key: "ArrowUp", label: "↑", describe: "Previous message", to: (all, at) => all[at - 1] },
  { key: "ArrowDown", label: "↓", describe: "Next message", to: (all, at) => all[at + 1] },
  { key: "Home", label: "Home", describe: "First message", to: (all) => all[0] },
  { key: "End", label: "End", describe: "Last message", to: (all) => all.at(-1) },
  { key: "Enter", label: "Enter", describe: "Go to the message's buttons" },
  { key: "Escape", label: "Esc", describe: "Go back to the message, or cancel an edit" },
];

/**
 * Makes a list of messages one Tab stop. Only the current message, the
 * newest until somebody moves, is in the Tab order, with its own controls; the
 * others and theirs are left out, so Tab passes the list in a few presses
 * rather than hundreds. ArrowUp and ArrowDown move between messages, Home and
 * End go to the first and last, Enter goes into a message's actions, and Escape
 * comes back out to the message.
 *
 * Controls stay where they are for a pointer and a screen reader's reading
 * cursor; only sequential Tab order changes.
 */
export function useRovingMessages(list: React.RefObject<HTMLElement | null>) {
  const current = useRef<HTMLElement | null>(null);
  /** Until somebody has been in the list, its Tab stop follows the newest message. */
  const chosen = useRef(false);

  const apply = useCallback(() => {
    const root = list.current;
    if (!root) return;
    const messages = [...root.querySelectorAll<HTMLElement>(MESSAGE)];
    if (!chosen.current || !current.current || !root.contains(current.current))
      current.current = messages.at(-1) ?? null;
    for (const message of messages) {
      const isCurrent = message === current.current;
      message.tabIndex = isCurrent ? 0 : -1;
      for (const control of message.querySelectorAll<HTMLElement>(CONTROL)) {
        if (isCurrent) {
          if (control.hasAttribute(TAKEN)) {
            control.removeAttribute(TAKEN);
            control.removeAttribute("tabindex");
          }
        } else if (!control.hasAttribute("tabindex")) {
          // A control with its own tabindex manages itself.
          control.setAttribute(TAKEN, "");
          control.tabIndex = -1;
        }
      }
    }
  }, [list]);

  // Messages arrive, leave and change without this list rendering again.
  useEffect(() => {
    const root = list.current;
    if (!root) return;
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [list, apply]);

  const onFocus = useCallback(
    (event: React.FocusEvent) => {
      const message = (event.target as HTMLElement).closest<HTMLElement>(MESSAGE);
      if (!message) return;
      chosen.current = true;
      if (message === current.current) return;
      current.current = message;
      apply();
    },
    [apply],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement;
      const message = target.closest<HTMLElement>(MESSAGE);
      const root = list.current;
      if (!message || !root) return;
      if (target !== message) {
        // Out of a message's controls, back to the message.
        if (event.key === "Escape") {
          event.preventDefault();
          message.focus();
        }
        return;
      }
      if (event.key === "Enter") {
        const action = message.querySelector<HTMLElement>(".message-toolbar button");
        if (!action) return;
        event.preventDefault();
        action.focus();
        return;
      }
      const move = MESSAGE_LIST_KEYS.find((k) => k.key === event.key)?.to;
      if (!move) return;
      event.preventDefault();
      const messages = [...root.querySelectorAll<HTMLElement>(MESSAGE)];
      const next = move(messages, messages.indexOf(message));
      if (!next) return;
      next.focus();
      next.scrollIntoView?.({ block: "nearest" });
    },
    [list],
  );

  return { onFocus, onKeyDown };
}
