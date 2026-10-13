import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEventHandler,
  type PointerEventHandler,
  type ReactElement,
  type Ref,
  type RefCallback,
} from "react";
import { createPortal } from "react-dom";
import { isImeKey } from "../lib/textInput.js";

interface TriggerProps {
  ref?: Ref<HTMLElement>;
  title?: string;
  "aria-describedby"?: string;
  onPointerEnter?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
  onPointerDown?: PointerEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onBlur?: FocusEventHandler<HTMLElement>;
}

interface Props {
  /** What the control does, in the same words as its accessible name. */
  label: string;
  /** The keyboard shortcut that does the same thing, if there is one. */
  keys?: string;
  /** Where it prefers to open; it flips to the other side when that does not fit. */
  side?: "top" | "bottom" | "right";
  children: ReactElement<TriggerProps>;
}

const HOVER_DELAY = 400;
/** Once one hint is showing, the next waits only long enough to skip a pointer passing by. */
const NEXT_DELAY = 80;
/** How long after a hint goes the next one still counts as next. */
const NEXT_WINDOW = 300;
const LEAVE_GRACE = 120;
const VISUAL_GAP = 8;
const VIEWPORT_MARGIN = 8;

let activeTooltip: { owner: object; close: () => void } | null = null;
/** Where the last hint was drawn, and when it went, so the next can travel from there. */
let lastHint = { at: -Infinity, left: 0, top: 0, side: "" };

function hintIsNext(): boolean {
  return activeTooltip !== null || performance.now() - lastHint.at < NEXT_WINDOW;
}

function chain<E>(theirs: ((event: E) => void) | undefined, ours: (event: E) => void) {
  return (event: E) => {
    theirs?.(event);
    ours(event);
  };
}

/** React 19 ref callbacks may return their own cleanup. Preserve that contract. */
function mergeRef<T>(
  forwarded: Ref<T> | undefined,
  remember: (value: T | null) => void,
): RefCallback<T> {
  return (value) => {
    remember(value);
    let dispose: void | (() => void);
    if (typeof forwarded === "function") dispose = forwarded(value);
    else if (forwarded) forwarded.current = value;

    return () => {
      remember(null);
      if (typeof dispose === "function") dispose();
      else if (typeof forwarded === "function") forwarded(null);
      else if (forwarded) forwarded.current = null;
    };
  };
}

function describedBy(existing: string | undefined, id: string) {
  return [...new Set(`${existing ?? ""} ${id}`.trim().split(/\s+/))].join(" ");
}

function portalHost(trigger: HTMLElement): HTMLElement {
  const fullscreen = document.fullscreenElement;
  if (fullscreen instanceof HTMLElement && fullscreen.contains(trigger)) return fullscreen;
  return (
    trigger.closest<HTMLElement>('[role="dialog"], main, nav, aside, [data-tandem-modal]') ??
    document.body
  );
}

/**
 * A short hint for compact controls. It never moves focus or makes the page
 * inert: hover waits a beat, keyboard focus opens immediately, and Escape
 * dismisses only the hint. The floating text follows its trigger on scroll.
 */
export function Tooltip({ label, keys, side: preferredSide = "top", children }: Props) {
  const id = `tooltip-${useId().replace(/:/g, "")}`;
  const trigger = useRef<HTMLElement | null>(null);
  const bubble = useRef<HTMLSpanElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerHovered = useRef(false);
  const bubbleHovered = useRef(false);
  const focused = useRef(false);
  const pointerPressed = useRef(false);
  const owner = useRef({});
  /** The hint this one follows on from, which it slides over from rather than growing in. */
  const travel = useRef<typeof lastHint | null>(null);
  const followsOn = useRef(false);
  const [open, setOpen] = useState(false);
  const [, refreshHost] = useState(0);

  const clearOpenTimer = useCallback(() => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    openTimer.current = null;
  }, []);
  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const hide = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    if (activeTooltip?.owner === owner.current) activeTooltip = null;
    const shown = bubble.current;
    if (shown?.style.visibility === "visible")
      lastHint = {
        at: performance.now(),
        left: parseFloat(shown.style.left),
        top: parseFloat(shown.style.top),
        side: shown.dataset.side ?? "",
      };
    setOpen(false);
  }, [clearCloseTimer, clearOpenTimer]);
  const reveal = useCallback(() => {
    if (activeTooltip?.owner !== owner.current) {
      activeTooltip?.close();
      activeTooltip = { owner: owner.current, close: hide };
    }
    travel.current = performance.now() - lastHint.at < NEXT_WINDOW ? lastHint : null;
    followsOn.current = travel.current !== null;
    setOpen(true);
  }, [hide]);
  const show = useCallback(
    (delay: number) => {
      clearOpenTimer();
      clearCloseTimer();
      if (delay === 0) reveal();
      else
        openTimer.current = setTimeout(() => {
          openTimer.current = null;
          reveal();
        }, delay);
    },
    [clearCloseTimer, clearOpenTimer, reveal],
  );
  const closeIfInactive = useCallback(() => {
    clearCloseTimer();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (!triggerHovered.current && !bubbleHovered.current && !focused.current) hide();
    }, LEAVE_GRACE);
  }, [clearCloseTimer, hide]);

  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimer();
      if (pointerResetTimer.current !== null) clearTimeout(pointerResetTimer.current);
      if (activeTooltip?.owner === owner.current) activeTooltip = null;
    },
    [clearCloseTimer, clearOpenTimer],
  );

  const rememberTrigger = useCallback((value: HTMLElement | null) => {
    trigger.current = value;
  }, []);
  const mergedRef = useMemo(
    () => mergeRef(children.props.ref, rememberTrigger),
    [children.props.ref, rememberTrigger],
  );
  const host = open && trigger.current ? portalHost(trigger.current) : null;

  const place = useCallback(() => {
    const anchor = trigger.current;
    const tooltip = bubble.current;
    if (!anchor?.isConnected || !tooltip) {
      hide();
      return;
    }
    // A hover-only message toolbar may disappear in the instant between the
    // pointer leaving its button and entering this portalled hit area. Keep
    // the last useful position; the leave grace closes it unless the pointer
    // arrives and cancels that timer.
    const anchorRects = Array.from(anchor.getClientRects());
    const hasArea = anchorRects.some((rect) => rect.width > 0 && rect.height > 0);
    if (!hasArea) {
      if (closeTimer.current === null && !bubbleHovered.current) hide();
      return;
    }
    const boundingBox = anchor.getBoundingClientRect();
    const anchorBox =
      boundingBox.width > 0 && boundingBox.height > 0
        ? boundingBox
        : anchorRects.find((rect) => rect.width > 0 && rect.height > 0)!;
    if (
      anchorBox.bottom <= 0 ||
      anchorBox.top >= window.innerHeight ||
      anchorBox.right <= 0 ||
      anchorBox.left >= window.innerWidth
    ) {
      hide();
      return;
    }
    const tooltipBox = tooltip.getBoundingClientRect();
    const width = tooltipBox.width || tooltip.offsetWidth;
    const height = tooltipBox.height || tooltip.offsetHeight;
    const fitsTop = anchorBox.top - height >= VIEWPORT_MARGIN;
    const fitsBottom = anchorBox.bottom + height <= window.innerHeight - VIEWPORT_MARGIN;
    const fitsRight = anchorBox.right + width <= window.innerWidth - VIEWPORT_MARGIN;
    const side =
      preferredSide === "right" && fitsRight
        ? "right"
        : preferredSide === "top" || preferredSide === "right"
          ? !fitsTop && fitsBottom
            ? "bottom"
            : "top"
          : !fitsBottom && fitsTop
            ? "top"
            : "bottom";
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        side === "right" ? anchorBox.right : anchorBox.left + anchorBox.width / 2 - width / 2,
        maxLeft,
      ),
    );
    const wantedTop =
      side === "right"
        ? anchorBox.top + anchorBox.height / 2 - height / 2
        : side === "top"
          ? anchorBox.top - height
          : anchorBox.bottom;
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);

    const top = Math.max(VIEWPORT_MARGIN, Math.min(wantedTop, maxTop));
    const nextLeft = `${left}px`;
    const nextTop = `${top}px`;
    if (tooltip.style.left !== nextLeft) tooltip.style.left = nextLeft;
    if (tooltip.style.top !== nextTop) tooltip.style.top = nextTop;
    if (tooltip.style.visibility !== "visible") tooltip.style.visibility = "visible";
    if (tooltip.dataset.side !== side) tooltip.dataset.side = side;
  }, [hide, preferredSide]);

  useLayoutEffect(() => {
    if (!open || !host) return;
    place();
    // Following on from the last hint, it slides over from where that one was.
    const from = travel.current;
    const tooltip = bubble.current;
    travel.current = null;
    if (
      from &&
      tooltip?.dataset.side === from.side &&
      typeof tooltip.animate === "function" &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      const x = from.left - parseFloat(tooltip.style.left);
      const y = from.top - parseFloat(tooltip.style.top);
      tooltip.animate(
        { translate: [`${x}px ${y}px`, "0 0"] },
        { duration: 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
    const onFullscreenChange = () => refreshHost((version) => version + 1);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place());
    let followFrame = 0;
    const followPosition = () => {
      place();
      followFrame = window.requestAnimationFrame(followPosition);
    };
    observer?.observe(host);
    if (trigger.current) observer?.observe(trigger.current);
    if (bubble.current) observer?.observe(bubble.current);
    followFrame = window.requestAnimationFrame(followPosition);
    document.addEventListener("scroll", place, true);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("scroll", place, true);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("resize", place);
      window.cancelAnimationFrame(followFrame);
      observer?.disconnect();
    };
  }, [host, label, keys, open, place]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isImeKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      hide();
    };
    const onWindowBlur = () => hide();
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [hide, open]);

  const child = cloneElement(children, {
    ref: mergedRef,
    title: undefined,
    "aria-describedby": open
      ? describedBy(children.props["aria-describedby"], id)
      : children.props["aria-describedby"],
    onPointerEnter: chain(children.props.onPointerEnter, (event) => {
      if (event.pointerType === "touch") return;
      triggerHovered.current = true;
      show(hintIsNext() ? NEXT_DELAY : HOVER_DELAY);
    }),
    onPointerLeave: chain(children.props.onPointerLeave, (event) => {
      if (event.pointerType === "touch") return;
      triggerHovered.current = false;
      clearOpenTimer();
      closeIfInactive();
    }),
    onPointerDown: chain(children.props.onPointerDown, () => {
      pointerPressed.current = true;
      hide();
      if (pointerResetTimer.current !== null) clearTimeout(pointerResetTimer.current);
      pointerResetTimer.current = setTimeout(() => {
        pointerPressed.current = false;
        pointerResetTimer.current = null;
      }, 0);
    }),
    onFocus: chain(children.props.onFocus, () => {
      focused.current = true;
      if (!pointerPressed.current) show(0);
    }),
    onBlur: chain(children.props.onBlur, () => {
      focused.current = false;
      if (!triggerHovered.current && !bubbleHovered.current) hide();
    }),
  });

  const content = open ? (
    <span
      ref={bubble}
      id={id}
      role="tooltip"
      data-side={preferredSide}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        bubbleHovered.current = true;
        clearCloseTimer();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return;
        bubbleHovered.current = false;
        closeIfInactive();
      }}
      style={{ left: 0, top: 0, visibility: "hidden", padding: VISUAL_GAP }}
      className="pointer-events-auto fixed z-[70] text-center text-xs text-ground"
    >
      <span
        className={`flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-lg bg-ink px-2 py-1 font-medium text-ground shadow-[var(--shadow-float)] ${
          followsOn.current ? "" : "animate-tip-in"
        }`}
      >
        <span>
          {label}
          {keys && <span className="sr-only">{`. Shortcut: ${keys}`}</span>}
        </span>
        {keys && (
          <kbd
            aria-hidden="true"
            className="shrink-0 rounded bg-ground/15 px-1 text-[10px] font-medium text-ground/80"
          >
            {keys}
          </kbd>
        )}
      </span>
    </span>
  ) : null;
  return (
    <>
      {child}
      {host && content && createPortal(content, host)}
    </>
  );
}
