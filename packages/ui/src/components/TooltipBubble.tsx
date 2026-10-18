import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { isImeKey } from "../lib/textInput.js";

const VISUAL_GAP = 8;
const VIEWPORT_MARGIN = 8;

/** Where a hint was drawn, so the one after it can slide over from there. */
export interface HintPlace {
  left: number;
  top: number;
  side: string;
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
 * An open tooltip's floating text: placed beside its trigger, kept there as
 * the page scrolls or resizes, and closed by Escape or the window losing
 * focus. Escape is its own only while its trigger has focus. It is out of
 * the first download; `Tooltip` keeps the timers and the trigger's handlers,
 * and draws this once it has arrived.
 */
export function TooltipBubble(props: {
  id: string;
  label: string;
  keys?: string;
  side: "top" | "bottom" | "right";
  trigger: RefObject<HTMLElement | null>;
  bubble: RefObject<HTMLSpanElement | null>;
  /** The hint this one follows on from; read once, as it is first placed. */
  travel: { current: HintPlace | null };
  followsOn: boolean;
  hide: () => void;
  /** The pointer may be on its way from the trigger to this text. */
  waiting: () => boolean;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const { id, label, keys, side: preferredSide, trigger, bubble, travel, hide, waiting } = props;
  const [, refreshHost] = useState(0);
  const host = trigger.current ? portalHost(trigger.current) : null;

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
      if (!waiting()) hide();
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
  }, [bubble, hide, preferredSide, trigger, waiting]);

  useLayoutEffect(() => {
    if (!host) return;
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
  }, [bubble, host, label, keys, place, travel, trigger]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isImeKey(event)) return;
      hide();
      // Escape goes where the keyboard is. On the control this hint is for,
      // the first one only puts the hint away, as a dialog's or a panel's
      // would. A hint the pointer opened on something else goes too, but the
      // key carries on: the phone drawer's rail sits under the pointer that
      // opened it, and its hint kept the drawer open while focus was on
      // "Jump to…".
      const focused = document.activeElement;
      if (!focused || !trigger.current?.contains(focused)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onWindowBlur = () => hide();
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [hide, trigger]);

  if (!host) return null;
  return createPortal(
    <span
      ref={bubble}
      id={id}
      role="tooltip"
      data-side={preferredSide}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") props.onPointerEnter();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") props.onPointerLeave();
      }}
      style={{ left: 0, top: 0, visibility: "hidden", padding: VISUAL_GAP }}
      className="pointer-events-auto fixed z-[70] text-center text-xs text-ground"
    >
      <span
        className={`flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-lg bg-ink px-2 py-1 font-medium text-ground shadow-[var(--shadow-float)] ${
          props.followsOn ? "" : "animate-tip-in"
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
    </span>,
    host,
  );
}
