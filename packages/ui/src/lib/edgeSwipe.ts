import { useEffect, useRef } from "react";

/**
 * How far in from the left edge a swipe that opens the drawer may start.
 * Wider than the strip Android keeps for its own Back gesture, so a swipe
 * that starts just inside it still reaches the page.
 */
export const EDGE_ZONE = 40;
/** How far a finger goes sideways before that is a swipe. */
export const SWIPE_DISTANCE = 56;
/** How far it may go up or down first before it is a scroll instead. */
const SLOP = 12;

/** Somewhere a sideways drag already means something else. */
const OWN_DRAG = "input, textarea, [contenteditable='true']";

/**
 * Opens the phone's drawer with a swipe in from the left edge, and closes it
 * with a swipe back, as Android's navigation drawer does. It only watches:
 * the listeners are passive and never cancel anything, so a vertical scroll
 * scrolls, and a browser or system Back gesture from the very edge stays the
 * browser's. A drag that turns out to be mostly up or down is let go. The
 * drawer's own transition does the moving, and theme.css stills it under
 * reduced motion.
 */
export function useEdgeSwipe(props: {
  open: boolean;
  /** Read at the start of each touch: whether the drawer is in use at all. */
  enabled: () => boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    let start: { x: number; y: number; id: number; opening: boolean } | null = null;
    const begin = (event: TouchEvent) => {
      start = null;
      const { open, enabled } = latest.current;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || !enabled()) return;
      if (!open && touch.clientX > EDGE_ZONE) return;
      if (event.target instanceof Element && event.target.closest(OWN_DRAG)) return;
      start = { x: touch.clientX, y: touch.clientY, id: touch.identifier, opening: !open };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      const id = start.id;
      const touch = Array.from(event.touches).find((t) => t.identifier === id);
      if (!touch) return;
      const across = (touch.clientX - start.x) * (start.opening ? 1 : -1);
      const down = Math.abs(touch.clientY - start.y);
      if (down > SLOP && down > Math.abs(across)) {
        start = null;
        return;
      }
      if (across < SWIPE_DISTANCE || across < down * 2) return;
      const opening = start.opening;
      start = null;
      if (opening) latest.current.onOpen();
      else latest.current.onClose();
    };
    const end = () => {
      start = null;
    };
    const passive = { passive: true } as const;
    document.addEventListener("touchstart", begin, passive);
    document.addEventListener("touchmove", move, passive);
    document.addEventListener("touchend", end, passive);
    document.addEventListener("touchcancel", end, passive);
    return () => {
      document.removeEventListener("touchstart", begin);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", end);
    };
  }, []);
}
