import { useEffect, useRef, useState } from "react";
import type { ID, Message } from "@ownbase/protocol";
import { editDraftKey, readableText } from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import { readEditDraft } from "../lib/drafts.js";
import { writeClipboard } from "../lib/useCopy.js";
import { useToast } from "./Toast.js";

/** A message deleted by someone else while it had an unsaved edit here. */
export interface DeletedEdit {
  id: ID;
  createdAt: number;
}

/**
 * Messages in this list deleted while they had an unsaved edit. The row and its
 * editor go with the message, so the edit is kept here, to show where the
 * message was until it is copied or discarded.
 */
export function useDeletedEdits(channelId: ID, rows: readonly Message[]): DeletedEdit[] {
  const client = useClient();
  const latest = useRef(rows);
  latest.current = rows;
  const [gone, setGone] = useState<DeletedEdit[]>([]);
  useEffect(
    () =>
      client.on("messageDeleted", (id) => {
        const row = latest.current.find((message) => message.id === id);
        if (!row) return;
        const edit = readEditDraft(client.state.drafts[editDraftKey(channelId, id)]);
        if (!edit?.text.trim()) return;
        setGone((list) =>
          list.some((entry) => entry.id === id)
            ? list
            : [...list, { id, createdAt: row.createdAt }],
        );
      }),
    [client, channelId],
  );
  return gone;
}

/**
 * The deleted edits that go just before each row, by when their message was
 * sent; the last slot holds those after every row.
 */
export function placeDeletedEdits(
  gone: readonly DeletedEdit[],
  rows: readonly Message[],
): DeletedEdit[][] {
  const slots: DeletedEdit[][] = rows.map(() => []);
  slots.push([]);
  for (const entry of gone) {
    const at = rows.findIndex((row) => row.createdAt > entry.createdAt);
    slots[at === -1 ? rows.length : at]!.push(entry);
  }
  return slots;
}

/** Where a message being edited here was, once someone else deleted it. */
export function DeletedEditNote({ channelId, messageId }: { channelId: ID; messageId: ID }) {
  const client = useClient();
  const toast = useToast();
  const key = editDraftKey(channelId, messageId);
  const edit = readEditDraft(useWorkspace((s) => s.drafts[key]));
  if (!edit?.text.trim()) return null;
  const text = readableText(client.state, edit.text);
  return (
    <div
      role="group"
      aria-label="Your unsaved edit"
      className="mx-4 my-1 rounded-lg border border-edge px-4 py-2"
    >
      <p className="text-[13px] text-ink-faint">
        This message was deleted. Your edit was not saved.
      </p>
      <p className="bidi-text mt-1 max-h-40 overflow-y-auto whitespace-pre-line break-words text-[15px] text-ink-dim">
        {text}
      </p>
      <div className="mt-2 flex gap-1">
        <button
          type="button"
          onClick={() =>
            void writeClipboard(text).then((ok) =>
              toast(
                ok
                  ? { message: "Edit copied.", kind: "success" }
                  : { message: "Could not copy the edit.", kind: "error" },
              ),
            )
          }
          className="rounded-md px-2 py-1 text-[13px] font-medium text-ink-dim transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          Copy text
        </button>
        <button
          type="button"
          onClick={() => client.setDraft(key, "")}
          className="rounded-md px-2 py-1 text-[13px] font-medium text-ink-dim transition-colors hover:bg-ink/[0.06] hover:text-alert"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
