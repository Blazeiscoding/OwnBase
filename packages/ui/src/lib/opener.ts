/**
 * The control a dialog, panel or the phone's drawer was opened from, to give
 * focus back to when it closes.
 *
 * That is what has focus, in Chromium and Firefox. Safari, and so every
 * browser on an iPhone, does not focus a button that is clicked or tapped:
 * focus is still on the page when what it opened appears, and closing it
 * would leave focus there. The control last pressed stands in then. A key
 * pressed since forgets it, so a shortcut that opens something with focus on
 * the page is not taken for a press long before.
 */
const PRESSABLE = 'button, a[href], summary, [role="button"], [role="menuitem"], [role="tab"]';

let pressed: HTMLElement | null = null;

if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (event) => {
      pressed =
        event.target instanceof Element ? event.target.closest<HTMLElement>(PRESSABLE) : null;
    },
    true,
  );
  document.addEventListener("keydown", () => (pressed = null), true);
}

export function focusOrigin(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) return active;
  return pressed?.isConnected ? pressed : null;
}
