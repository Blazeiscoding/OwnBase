/**
 * The two rules that decide when a text field may act on what it has been
 * given, both of which are easy to get wrong in ways nobody notices until
 * somebody types differently from the person who wrote the code.
 */

/** The parts of a keyboard event these rules need. */
export interface KeyLike {
  /** True while an input method is still assembling a character. */
  isComposing?: boolean;
  /**
   * 229 is what browsers report for a key that belongs to the input method
   * rather than to the page. It is deprecated and still the only signal some
   * browsers give, so both are checked.
   */
  keyCode?: number;
}

/**
 * Whether a key press belongs to an input method rather than to the page.
 *
 * Someone typing Japanese, Chinese or Korean presses Enter to choose among the
 * candidates their keystrokes produced. That Enter is not "send", not "open
 * this channel" and not "run this search" — it is part of typing a word. Acting
 * on it sends a half-finished message, and there is no way for the person to
 * tell that is what is about to happen.
 *
 * Every key handler on a text field has to ask this first, not only the one on
 * the main composer: the switcher and the search box take Enter too.
 */
export function isImeKey(event: KeyLike): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/**
 * Whether the caret is inside a ``` code block that has not been closed yet.
 * Messages split on ``` the same way (`Mrkdwn`): an odd number of fences
 * before the caret means it is in one. There, Enter starts a new line of the
 * code rather than sending or saving half of it (UX-04).
 */
export function insideCodeBlock(text: string, caret: number): boolean {
  return (text.slice(0, caret).split("```").length - 1) % 2 === 1;
}

/** A caret position waiting to be restored, and the text it was computed for. */
export interface PendingCaret {
  start: number;
  end: number;
  /** What the field held when the position was worked out. */
  text: string;
}

/**
 * Where to put the caret after a formatting shortcut or an autocomplete, or
 * null to leave it where it is.
 *
 * Inserting a mention or wrapping a selection in asterisks means rewriting the
 * whole field, which puts the caret at the end; it has to be moved back to
 * where the person was. The catch is the gap between the rewrite and the move.
 * A fast typist — and completing a mention with Tab is exactly when someone is
 * typing fast — gets another character in during that gap, and if the move
 * happens anyway it drags the caret backwards out from under them and their
 * next letters land in the middle of a word they finished.
 *
 * So the restore is abandoned when the field no longer holds the text the
 * position was worked out for. Leaving the caret where someone's own typing
 * put it is always better than moving it somewhere that was right a moment ago.
 */
export function caretToRestore(
  pending: PendingCaret | null,
  currentText: string,
): { start: number; end: number } | null {
  if (!pending) return null;
  if (pending.text !== currentText) return null;
  const limit = currentText.length;
  const start = Math.max(0, Math.min(limit, pending.start));
  const end = Math.max(start, Math.min(limit, pending.end));
  return { start, end };
}

/** A pasted web address and nothing else, as a link over selected words wants. */
const PASTED_URL = /^https?:\/\/[^\s<>|]+$/i;

/**
 * Pasting a web address over selected words makes them a link to it, as
 * Slack does, rather than replacing them: `<https://example.com|the docs>`.
 * Null when it is ordinary pasting: nothing selected, more than an address
 * on the clipboard, or words a link's label cannot hold (a mention, a new
 * line, the link's own brackets), or the selection is in code.
 */
export function linkOverSelection(
  stored: string,
  start: number,
  end: number,
  pasted: string,
): { text: string; caret: number } | null {
  const url = pasted.trim();
  const label = stored.slice(start, end);
  if (start === end || !PASTED_URL.test(url)) return null;
  if (!label.trim() || /[<>|\n]/.test(label) || label.includes("`")) return null;
  if (insideCodeBlock(stored, start)) return null;
  const link = `<${url}|${label}>`;
  return { text: stored.slice(0, start) + link + stored.slice(end), caret: start + link.length };
}
