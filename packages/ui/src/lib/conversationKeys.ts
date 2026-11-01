import type { ID } from "@ownbase/protocol";

/**
 * The conversation above or below `active` in the sidebar, as it is drawn:
 * starred, sections, channels, then direct messages, skipping folded ones.
 * With `unreadOnly`, the nearest with something unread. None past either end.
 */
export function neighbourConversation(
  active: ID | null | undefined,
  step: -1 | 1,
  unreadOnly: boolean,
  root: ParentNode = document,
): ID | null {
  const rows = [...root.querySelectorAll<HTMLElement>(".workspace-sidebar [data-conversation]")];
  const ids = rows.map((row) => row.dataset.conversation!);
  const at = active ? ids.indexOf(active) : -1;
  // Nothing open, or the open one not listed: start from the end it walks away from.
  let i = at === -1 ? (step === 1 ? -1 : ids.length) : at;
  for (i += step; i >= 0 && i < ids.length; i += step) {
    if (!unreadOnly || rows[i]!.dataset.unread !== undefined) return ids[i]!;
  }
  return null;
}
