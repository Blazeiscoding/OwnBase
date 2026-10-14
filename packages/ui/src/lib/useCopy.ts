import { useCallback, useEffect, useRef, useState } from "react";

type CopyState = { key: string; ok: boolean } | null;

/**
 * Reports a clipboard write only once it has actually happened.
 *
 * `navigator.clipboard.writeText` is refused often enough to matter — an
 * insecure origin, a window that lost focus, a browser policy — and a button
 * that says "Copied" when nothing was copied costs the reader whatever they
 * paste next.
 */
export function useCopy(resetMs = 1500) {
  const [state, setState] = useState<CopyState>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const copy = useCallback(
    async (text: string, key = "default") => {
      if (timer.current) clearTimeout(timer.current);
      const ok = await writeClipboard(text);
      setState({ key, ok });
      timer.current = setTimeout(() => setState(null), resetMs);
      return ok;
    },
    [resetMs],
  );

  /** What the button should read right now. */
  const label = useCallback(
    (idle: string, done: string, failed: string, key = "default") =>
      state?.key !== key ? idle : state.ok ? done : failed,
    [state],
  );

  return { copy, label, copied: state };
}

/**
 * Browsers offer the Clipboard API only to pages they consider secure, and a
 * workspace on a home or office network is usually reached over plain http,
 * where they offer nothing. Copying a selection, the older way, still works
 * there, as it does when the API is present but refuses.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Try the selection instead.
    }
  }
  return copySelection(text);
}

function copySelection(text: string): boolean {
  if (typeof document.execCommand !== "function") return false;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.tabIndex = -1;
  field.setAttribute("aria-hidden", "true");
  // Rendered, because nothing hidden can be selected, but out of sight.
  field.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none";
  // An open dialog takes focus back from anything outside it, so the field
  // goes inside the dialog the copy was asked from.
  (previous?.closest("[role='dialog']") ?? document.body).append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    previous?.focus({ preventScroll: true });
  }
}
