import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEventHandler,
  type PointerEventHandler,
  type ReactElement,
  type Ref,
  type RefCallback,
} from "react";

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

type Bubble = (typeof import("./TooltipBubble.js"))["TooltipBubble"];
/**
 * The floating text is out of the first download. It is fetched as the
 * workspace opens, or when a hint is first wanted, and drawn directly from
 * then on; a hover waits longer than it takes to arrive.
 */
let LoadedBubble: Bubble | null = null;
let loadingBubble: Promise<Bubble> | null = null;
export function loadTooltipBubble(): Promise<Bubble> {
  loadingBubble ??= import("./TooltipBubble.js").then(
    (module) => (LoadedBubble = module.TooltipBubble),
    (error: unknown) => {
      // Asked again later, it tries again.
      loadingBubble = null;
      throw error;
    },
  );
  return loadingBubble;
}

/**
 * A short hint for compact controls. It never moves focus or makes the page
 * inert: hover waits a beat, keyboard focus opens immediately, and Escape
 * dismisses it. On the focused control Escape dismisses only the hint; a hint
 * the pointer opened elsewhere lets the key go on to where focus is. The
 * floating text follows its trigger on scroll.
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
  const [, bubbleArrived] = useState(0);

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
      if (!LoadedBubble) loadTooltipBubble().catch(() => undefined);
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
  const waiting = useCallback(() => closeTimer.current !== null || bubbleHovered.current, []);

  // Open before its text has arrived: draw it once it has.
  useEffect(() => {
    if (!open || LoadedBubble) return;
    let alive = true;
    loadTooltipBubble().then(
      () => alive && bubbleArrived((version) => version + 1),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [open]);

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

  return (
    <>
      {child}
      {open && LoadedBubble && (
        <LoadedBubble
          id={id}
          label={label}
          keys={keys}
          side={preferredSide}
          trigger={trigger}
          bubble={bubble}
          travel={travel}
          followsOn={followsOn.current}
          hide={hide}
          waiting={waiting}
          onPointerEnter={() => {
            bubbleHovered.current = true;
            clearCloseTimer();
          }}
          onPointerLeave={() => {
            bubbleHovered.current = false;
            closeIfInactive();
          }}
        />
      )}
    </>
  );
}
