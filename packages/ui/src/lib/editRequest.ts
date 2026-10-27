import { useEffect, useRef } from "react";
import type { ID } from "@ownbase/protocol";

/** How long a request waits for its message's row to appear. */
export const EDIT_REQUEST_MS = 10_000;

const rows = new Map<ID, () => void>();
let waiting: { messageId: ID; until: number } | null = null;

/**
 * Asks the row showing a message to open its editor, from elsewhere: the
 * Drafts list, for an edit not yet saved. A row on screen opens it at once;
 * otherwise the row takes it when it appears, within `EDIT_REQUEST_MS`, as
 * after a jump to the message. One never shown lets it go.
 */
export function requestEdit(messageId: ID): void {
  const open = rows.get(messageId);
  if (open) {
    waiting = null;
    open();
    return;
  }
  waiting = { messageId, until: Date.now() + EDIT_REQUEST_MS };
}

/** Opens this row's editor when `requestEdit` asks, while `enabled`. */
export function useEditRequest(messageId: ID, enabled: boolean, open: () => void): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    if (!enabled) return;
    const row = () => latest.current();
    if (waiting?.messageId === messageId) {
      const due = waiting.until > Date.now();
      waiting = null;
      if (due) row();
    }
    rows.set(messageId, row);
    return () => {
      if (rows.get(messageId) === row) rows.delete(messageId);
    };
  }, [messageId, enabled]);
}
