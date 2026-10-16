import { useEffect } from "react";

/**
 * How much shorter than the page the part left in sight must be before the
 * difference is taken for an on-screen keyboard, rather than the browser's own
 * bars coming and going. A phone's keyboard is at least 200 px tall.
 */
export const KEYBOARD_HEIGHT = 150;

/** Inputs no keyboard comes up for. */
const NOT_TYPED = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** A field a phone raises its keyboard for. */
function typesText(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement) return !element.readOnly;
  if (element instanceof HTMLInputElement) return !element.readOnly && !NOT_TYPED.has(element.type);
  // Strictly true: toggleAttribute toggles when handed anything undefined.
  return element instanceof HTMLElement && element.isContentEditable === true;
}

/**
 * Keeps the workspace in the part of the screen a phone's keyboard leaves.
 *
 * The page asks to be resized for the keyboard (`interactive-widget` in the
 * web client's viewport tag), and Chrome on Android does that. iOS Safari does
 * not: it keeps the page its full height and slides it up under the keyboard,
 * so the composer and the header could end up out of sight. Rather than ask
 * which browser this is, this looks at what it did: where the visible part of
 * the page (`visualViewport`) is shorter than the page and nobody has zoomed
 * in, the root takes the visible part's height and follows it as it moves,
 * through `--visual-height` and `--visual-top`, which theme.css reads under
 * `data-visual-viewport`. Anywhere else the page is left alone.
 *
 * The root is also marked `data-keyboard` while a keyboard is up: a field is
 * being typed in, and the visible part is at least {@link KEYBOARD_HEIGHT}
 * shorter than the tallest the page has been at this width. The phone's bottom
 * bar steps aside then, leaving the room to the composer. Nothing is drawn
 * again for this: the browser's own events set two attributes and two values.
 */
export function useOnScreenKeyboard(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let width = window.innerWidth;
    let tallest = 0;
    let following = false;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (window.innerWidth !== width) {
        // Turned on its side, or the window changed: the tallest starts again.
        width = window.innerWidth;
        tallest = 0;
      }
      tallest = Math.max(tallest, window.innerHeight);
      const zoomed = Math.abs(viewport.scale - 1) > 0.01;
      const follow = !zoomed && window.innerHeight - viewport.height > 1;
      if (follow) {
        root.style.setProperty("--visual-height", `${viewport.height}px`);
        root.style.setProperty("--visual-top", `${viewport.pageTop}px`);
      } else if (following) {
        root.style.removeProperty("--visual-height");
        root.style.removeProperty("--visual-top");
      }
      if (follow !== following) {
        following = follow;
        root.toggleAttribute("data-visual-viewport", follow);
      }
      root.toggleAttribute(
        "data-keyboard",
        !zoomed &&
          typesText(document.activeElement) &&
          tallest - viewport.height >= KEYBOARD_HEIGHT,
      );
    };
    // Focus moving from one field to the next passes through nothing on the
    // way, which is no reason to bring the bar back: look once it has landed.
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    document.addEventListener("focusin", soon);
    document.addEventListener("focusout", soon);
    update();
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.removeEventListener("focusin", soon);
      document.removeEventListener("focusout", soon);
      root.removeAttribute("data-visual-viewport");
      root.removeAttribute("data-keyboard");
      root.style.removeProperty("--visual-height");
      root.style.removeProperty("--visual-top");
    };
  }, []);
}
