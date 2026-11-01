import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { isImeKey } from "../lib/textInput.js";
import { Icon } from "./Icon.js";

export interface ToastAction {
  /** Names the action, so the button never reads "OK". */
  label: string;
  run: () => void | Promise<void>;
}

export interface ToastRequest {
  /** What happened, in one line and in the words the person would use. */
  message: string;
  /** A success or a heads-up clears itself; a failure waits to be read. */
  kind?: "success" | "info" | "error";
  /** Offered only where the operation supports it: try again, or undo. */
  action?: ToastAction;
}

/** Shows a notice. Returns a function that takes it back off the screen. */
type Show = (request: ToastRequest) => () => void;

const ToastContext = createContext<Show | null>(null);

/**
 * Report something that finished away from the control that started it: a
 * reaction the server refused, a pin that came back undone. Notices never take
 * focus and never make the page inert, so whatever someone was typing survives
 * one appearing.
 */
export function useToast(): Show {
  const show = useContext(ToastContext);
  if (!show) throw new Error("ToastContext missing");
  return show;
}

/** The same, where a screen may be drawn without notices, as in a test. */
export function useOptionalToast(): Show | null {
  return useContext(ToastContext);
}

/** A success has been read by the time it goes; a failure is not guessed at. */
const SUCCESS_LIFETIME = 5000;
/**
 * One with something to do, such as Undo, stays longer: long enough to reach
 * its button from the keyboard or with a screen reader, not only the mouse.
 */
const ACTION_LIFETIME = 10_000;
/** Beyond this the oldest notice is older news than the screen has room for. */
const MAX_VISIBLE = 4;

interface Shown {
  id: number;
  message: string;
  kind: "success" | "info" | "error";
  action?: ToastAction;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown[]>([]);
  const serial = useRef(0);

  const dismiss = useCallback((id: number) => {
    setShown((list) => list.filter((notice) => notice.id !== id));
  }, []);

  const show = useCallback<Show>((request) => {
    const notice: Shown = {
      id: ++serial.current,
      message: request.message,
      kind: request.kind ?? "error",
      action: request.action,
    };
    setShown((list) => {
      // The same news twice over is one notice. The newer copy replaces the
      // older, so a screen reader hears it again and a success's countdown
      // starts again, rather than stacking identical lines.
      const rest = list.filter(
        (earlier) => earlier.message !== notice.message || earlier.kind !== notice.kind,
      );
      return [...rest, notice].slice(-MAX_VISIBLE);
    });
    return () => setShown((list) => list.filter((entry) => entry.id !== notice.id));
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {createPortal(<ToastStack shown={shown} dismiss={dismiss} />, document.body)}
    </ToastContext.Provider>
  );
}

/** A pointer over a notice, or focus inside one, holds every countdown. */
type Hold = `${"pointer" | "focus"}:${number}`;

function ToastStack({ shown, dismiss }: { shown: Shown[]; dismiss: (id: number) => void }) {
  const stack = useRef<HTMLDivElement>(null);
  // Kept per notice rather than as one flag, so a notice removed while held
  // takes its hold with it. Browsers fire neither blur nor pointerleave for
  // an element that leaves the document, and one stuck flag would stop every
  // countdown for good.
  const [holds, setHolds] = useState<ReadonlySet<Hold>>(() => new Set());
  /** Where keyboard focus was before it entered the stack. */
  const cameFrom = useRef<HTMLElement | null>(null);
  /** The position a focused notice held when it went, so focus can stay nearby. */
  const orphanedAt = useRef<number | null>(null);

  const hold = useCallback((key: Hold, on: boolean) => {
    setHolds((current) => {
      if (current.has(key) === on) return current;
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const releaseFocus = useCallback((notice: HTMLElement) => {
    const notices = Array.from(stack.current?.querySelectorAll("[data-toast]") ?? []);
    orphanedAt.current = Math.max(0, notices.indexOf(notice));
  }, []);

  useLayoutEffect(() => {
    const at = orphanedAt.current;
    if (at === null) return;
    orphanedAt.current = null;
    // Focus that has already found somewhere to be is left there.
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const notices = stack.current?.querySelectorAll<HTMLElement>("[data-toast]") ?? [];
    const neighbour = notices[Math.min(at, notices.length - 1)];
    const target = neighbour?.querySelector<HTMLElement>("button") ?? cameFrom.current;
    target?.focus({ preventScroll: true });
  }, [shown]);

  const paused = holds.size > 0;
  const item = (notice: Shown) => (
    <ToastItem
      key={notice.id}
      notice={notice}
      paused={paused}
      dismiss={dismiss}
      hold={hold}
      releaseFocus={releaseFocus}
    />
  );

  return (
    <div
      ref={stack}
      // The modal layer makes every other child of the body inert. A notice is
      // not a competing dialog, and a failure is worth reading over one.
      data-ownbase-toasts=""
      onFocusCapture={(event) => {
        const from = event.relatedTarget;
        if (from instanceof HTMLElement && !event.currentTarget.contains(from))
          cameFrom.current = from;
      }}
      // Placed in theme.css: under the header, or above an open dialog.
      className="pointer-events-none fixed z-[65] flex flex-col gap-2"
    >
      {/* Both regions outlive the notices inside them, so a screen reader is
          already watching when one arrives rather than meeting a new region.
          Failures come first, and each region adds at its end, so nothing
          arriving moves a Try again someone is reaching for. */}
      <div aria-live="assertive" className="flex flex-col gap-2">
        {shown.filter((notice) => notice.kind === "error").map(item)}
      </div>
      <div aria-live="polite" className="flex flex-col gap-2">
        {shown.filter((notice) => notice.kind !== "error").map(item)}
      </div>
    </div>
  );
}

function ToastItem({
  notice,
  paused,
  dismiss,
  hold,
  releaseFocus,
}: {
  notice: Shown;
  paused: boolean;
  dismiss: (id: number) => void;
  hold: (key: Hold, on: boolean) => void;
  releaseFocus: (notice: HTMLElement) => void;
}) {
  const { id } = notice;
  const failed = notice.kind === "error";
  const messageId = useId();
  const element = useRef<HTMLDivElement>(null);
  const remaining = useRef(notice.action ? ACTION_LIFETIME : SUCCESS_LIFETIME);
  const [leaving, setLeaving] = useState(false);
  // It fades as its row folds away, so the notices after it slide up rather
  // than jump. One closed from the keyboard goes at once, so focus moves to
  // its neighbour while that is still where it was.
  const close = () => {
    const shown = element.current;
    if (
      !shown ||
      typeof shown.getAnimations !== "function" ||
      shown.querySelector(":focus-visible") ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      dismiss(id);
    else setLeaving(true);
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!leaving) return;
    const gone = setTimeout(() => dismiss(id), 250);
    return () => clearTimeout(gone);
  }, [dismiss, id, leaving]);

  useEffect(() => {
    // A failure stays until it is dealt with: it may be the only copy of news
    // the control that caused it is no longer on screen to carry.
    if (failed || paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => closeRef.current(), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [failed, paused]);

  useLayoutEffect(() => {
    const notice = element.current;
    // A layout cleanup runs while the notice is still in the document, so it
    // can still tell whether focus is about to leave with it.
    return () => {
      if (notice?.contains(document.activeElement)) releaseFocus(notice);
      hold(`pointer:${id}`, false);
      hold(`focus:${id}`, false);
    };
  }, [hold, id, releaseFocus]);

  return (
    <div className={`toast-slot ${leaving ? "is-leaving" : ""}`}>
      <div
        ref={element}
        data-toast={id}
        onPointerEnter={() => hold(`pointer:${id}`, true)}
        onPointerLeave={() => hold(`pointer:${id}`, false)}
        onFocus={() => hold(`focus:${id}`, true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            hold(`focus:${id}`, false);
        }}
        onKeyDown={(event) => {
          // Escape belongs to the notice holding focus, not to the side panel or
          // anything else listening further up.
          if (event.key !== "Escape" || event.defaultPrevented || isImeKey(event.nativeEvent))
            return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
        className={`pointer-events-auto flex animate-toast-in items-start gap-3 rounded-xl border bg-lifted p-3 text-sm text-ink shadow-[var(--shadow-float)] ${
          failed ? "border-alert/40" : "border-edge"
        }`}
      >
        <Icon
          name={failed ? "alert" : notice.kind === "info" ? "info" : "check"}
          size={16}
          className={`mt-0.5 ${
            failed ? "text-alert" : notice.kind === "info" ? "text-ink-dim" : "text-online"
          }`}
        />
        <p id={messageId} className="min-w-0 flex-1 leading-snug">
          {notice.message}
        </p>
        {notice.action && (
          <button
            type="button"
            aria-describedby={messageId}
            onClick={() => {
              void notice.action?.run();
              close();
            }}
            className="shrink-0 rounded-lg border border-edge px-2 py-1 text-xs font-semibold text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
          >
            {notice.action.label}
          </button>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          // Several notices can be open at once; the message says which one.
          aria-describedby={messageId}
          onClick={close}
          className="shrink-0 rounded-lg p-1 text-ink-faint transition-colors hover:text-ink"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  );
}
