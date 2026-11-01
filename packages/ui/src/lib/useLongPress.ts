import { useEffect, useRef } from "react";
import type React from "react";

/** How long a finger rests before a hold counts, as a message's is (MessageItem). */
export const LONG_PRESS_MS = 450;
/** How far it may drift meanwhile, in CSS pixels, before it is a scroll. */
const DRIFT = 10;

/**
 * Holding something on a touchscreen does what a right-click does. Android's
 * Chrome says so itself with a context menu event; iOS Safari never does, so
 * the hold is timed here. The click that ends a hold is not a click.
 */
export function useLongPress(onLongPress: (() => void) | undefined) {
  const run = useRef(onLongPress);
  run.current = onLongPress;
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  const held = useRef(false);

  const cancel = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => cancel, []);

  return {
    onTouchStart(event: React.TouchEvent) {
      cancel();
      held.current = false;
      if (!run.current || event.touches.length !== 1) return;
      if (typeof matchMedia !== "function" || !matchMedia("(hover: none)").matches) return;
      const touch = event.touches[0]!;
      press.current = {
        x: touch.clientX,
        y: touch.clientY,
        timer: window.setTimeout(() => {
          press.current = null;
          held.current = true;
          navigator.vibrate?.(8);
          run.current?.();
        }, LONG_PRESS_MS),
      };
    },
    onTouchMove(event: React.TouchEvent) {
      const touch = event.touches[0];
      if (!press.current || !touch) return;
      if (Math.hypot(touch.clientX - press.current.x, touch.clientY - press.current.y) > DRIFT)
        cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    onClickCapture(event: React.MouseEvent) {
      if (!held.current) return;
      held.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
