import { useEffect, useRef, useState } from "react";

/**
 * A side panel takes focus when it opens and hands it back when it closes, so
 * somebody on a keyboard or a screen reader lands in what they opened and
 * returns to where they were.
 *
 * `takeFocus` puts focus on the panel's heading, which a screen reader then
 * reads. A panel whose first job is typing, such as a thread, focuses its own
 * box instead and leaves this off. A toggle that opened the panel keeps focus,
 * as a disclosure button does: it stays on screen, says the panel is open, and
 * closes it again. On a phone the panel covers everything, the toggle
 * included, and the page beneath goes inert, so there the heading takes focus.
 */
export function usePanelFocus({ takeFocus }: { takeFocus: boolean }) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Read while rendering, before any box inside the panel focuses itself.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  );

  // What takes focus around it, found now: a message's toolbar is unmade once
  // focus leaves the message, and the button that opened a thread goes with it.
  const [around] = useState(
    () => opener?.parentElement?.closest<HTMLElement>("[tabindex]") ?? null,
  );

  useEffect(() => {
    // A menu's button says whether its menu is open, not the panel: a panel
    // chosen from a menu takes focus like one opened from anywhere else.
    const toggle =
      (opener?.hasAttribute("aria-pressed") || opener?.hasAttribute("aria-expanded")) &&
      !opener?.hasAttribute("aria-haspopup");
    const covered = !!opener?.closest("[inert]");
    if (takeFocus && (!toggle || covered)) heading.current?.focus({ preventScroll: true });
    const element = panel.current;
    return () => {
      // Only focus that went with the panel comes back; somebody who has
      // moved on to something else stays there.
      const now = document.activeElement;
      const lost = !now || now === document.body || (element?.contains(now) ?? false);
      if (!lost) return;
      if (opener?.isConnected) handBack(opener);
      else if (around?.isConnected) around.focus({ preventScroll: true });
    };
  }, [opener, around, takeFocus]);

  return { panel, heading };
}

/**
 * Focuses the control that opened the panel. A message's toolbar shows only
 * while the message has the pointer or focus, so its button may not take focus
 * once the thread has closed; the message it belongs to can. Something that
 * hides what it holds, such as the phone's drawer, names in
 * `data-focus-fallback` the control to use instead.
 */
function handBack(opener: HTMLElement) {
  opener.focus({ preventScroll: true });
  if (document.activeElement === opener) return;
  opener.parentElement?.closest<HTMLElement>("[tabindex]")?.focus({ preventScroll: true });
  if (document.activeElement !== document.body && document.activeElement !== null) return;
  const fallback = opener.closest<HTMLElement>("[data-focus-fallback]")?.dataset.focusFallback;
  if (fallback) document.getElementById(fallback)?.focus({ preventScroll: true });
}
