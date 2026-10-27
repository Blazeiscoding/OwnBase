import { useEffect, useRef, useState } from "react";
import type { Message } from "@ownbase/protocol";
import { ApiError } from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import {
  FormattingToolbar,
  formatList,
  formatText,
  formattingShortcut,
  listShortcut,
  type ListKind,
  MESSAGE_LIMIT,
} from "./FormattingToolbar.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { MentionTags } from "./MentionTags.js";
import { insideCodeBlock, isImeKey } from "../lib/textInput.js";
import { useMentionField } from "../lib/useMentionField.js";
import { editDraftKey, readEditDraft, type EditDraft } from "../lib/drafts.js";

export function MessageEditor({ message, onClose }: { message: Message; onClose: () => void }) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const draftKey = editDraftKey(message.channelId, message.id);
  const savedDraft = useWorkspace((s) => s.drafts[draftKey]);
  const [kept] = useState(() => readEditDraft(client.state.drafts[draftKey]));
  const [draft, setDraft] = useState(kept?.text ?? message.text);
  /** The words this edit started from. */
  const [base, setBase] = useState(kept?.base ?? message.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const saving = useRef(false);
  const touched = useRef(false);
  // Changed to what this edit would save, as when a save whose answer was lost
  // went through, is no conflict.
  const changedElsewhere = message.text !== base && message.text !== draft.trim();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const other = readEditDraft(savedDraft);
    if (touched.current || !other) return;
    setDraft(other.text);
    if (other.base !== undefined) setBase(other.base);
  }, [savedDraft]);

  function keep(text: string, from: string) {
    // An emptied box keeps nothing, so the edit starts from the message again.
    client.setDraft(
      draftKey,
      text.trim() ? JSON.stringify({ text, base: from } satisfies EditDraft) : "",
    );
  }

  function change(text: string, from = base) {
    touched.current = true;
    setDraft(text);
    keep(text, from);
  }

  // The box shows mentions as names; `draft` keeps them as ids, as saved.
  const field = useMentionField(draft, box, (text) => change(text), users, channels);

  function format(marker: string, placeholder: string, block = false) {
    if (!box.current || saving.current) return;
    const { start, end } = field.selection();
    const next = formatText(draft, start, end, marker, placeholder, block);
    field.edit(next.text, next.selectionStart, next.selectionEnd);
  }

  function list(kind: ListKind) {
    if (!box.current || saving.current) return;
    const { start, end } = field.selection();
    const next = formatList(draft, start, end, kind);
    field.edit(next.text, next.selectionStart, next.selectionEnd);
  }

  function cancel() {
    if (saving.current) return;
    client.setDraft(draftKey, "");
    onClose();
  }

  async function save() {
    if (saving.current || !draft.trim() || draft.length > MESSAGE_LIMIT) return;
    if (draft.trim() === message.text) {
      cancel();
      return;
    }
    saving.current = true;
    setBusy(true);
    setError(null);
    keep(draft, base);
    try {
      // What this window has of the message: the words the edit started from,
      // or, once the author has seen they changed and chosen to save anyway,
      // the words they chose to replace. Anything newer is refused.
      await client.api.editMessage(message.id, draft.trim(), message.text);
      if (!alive.current) return;
      client.setDraft(draftKey, "");
      onClose();
    } catch (failure) {
      if (alive.current)
        setError(
          failure instanceof ApiError && failure.status === 404
            ? "This message is no longer available. Your unsaved edit is kept."
            : failure instanceof ApiError && failure.code === "message_changed"
              ? "This message changed before your edit was saved. Your text is kept; nothing was overwritten."
              : "Could not save this edit. Your text is kept; try again when connected.",
        );
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <div className="mt-1">
      {changedElsewhere && (
        <div role="status" className="mb-2 text-xs text-ink-dim">
          This message changed while you were editing.{" "}
          <button
            disabled={busy}
            className="font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
            onClick={() => {
              setBase(message.text);
              change(message.text, message.text);
              setError(null);
            }}
          >
            Use the current message
          </button>
          , or save your version below.
          <blockquote
            aria-label="Current message"
            className="mt-1 line-clamp-3 border-l-2 border-edge pl-2 whitespace-pre-wrap text-ink"
          >
            <Mrkdwn
              text={message.text}
              users={users}
              channels={channels}
              selfId={client.state.self?.id}
            />
          </blockquote>
        </div>
      )}
      <fieldset
        disabled={busy}
        className="min-w-0 overflow-hidden rounded-lg border border-copper/60 bg-ground"
      >
        <FormattingToolbar
          onFormat={format}
          onList={list}
          onInsert={(emoji) => {
            const next = field.replaceSelection(emoji);
            field.edit(next.stored, next.caret);
          }}
          preview={preview}
          onTogglePreview={() => setPreview((v) => !v)}
        />
        {preview && (
          <div
            aria-label="Edit preview"
            className="max-h-36 overflow-y-auto border-b border-edge px-3 py-2 text-sm"
          >
            <Mrkdwn text={draft} users={users} channels={channels} selfId={client.state.self?.id} />
          </div>
        )}
        <div className="relative">
          <MentionTags doc={field.doc} box={box} />
          <textarea
            ref={box}
            value={field.doc.shown}
            autoFocus
            aria-label="Edit message"
            onChange={(e) => change(field.fromInput(e).stored)}
            onKeyDown={(e) => {
              // Enter confirms an IME candidate rather than saving the edit.
              if (isImeKey(e.nativeEvent)) return;
              field.onKeyDown(e);
              if ((e.ctrlKey || e.metaKey) && !e.altKey) {
                const marker = formattingShortcut(e.key);
                if (marker) {
                  e.preventDefault();
                  format(marker, "text");
                  return;
                }
                const listed = listShortcut(e);
                if (listed) {
                  e.preventDefault();
                  list(listed);
                  return;
                }
                // Saves from anywhere, a code block included, as it sends in the composer.
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (!changedElsewhere) void save();
                  return;
                }
              }
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                // A new line of the code, not half a code block saved.
                !insideCodeBlock(e.currentTarget.value, e.currentTarget.selectionStart)
              ) {
                e.preventDefault();
                if (!changedElsewhere) void save();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancel();
              }
            }}
            rows={Math.min(8, Math.max(2, draft.split("\n").length))}
            className="relative block max-h-64 w-full resize-y bg-transparent px-3 py-2 text-[15px] outline-none"
          />
        </div>
        <div className="flex items-center justify-between gap-2 px-3 pb-2 text-xs">
          <span className={draft.length > MESSAGE_LIMIT ? "text-alert" : "text-ink-faint"}>
            {draft.length.toLocaleString()} / {MESSAGE_LIMIT.toLocaleString()}
          </span>
          <div className="flex gap-3">
            <button type="button" className="text-ink-dim" onClick={cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-shape bg-copper px-3 py-1 font-medium text-ground disabled:opacity-40"
              disabled={!draft.trim() || draft.length > MESSAGE_LIMIT}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : changedElsewhere ? "Save my version" : "Save"}
            </button>
          </div>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="mt-1 text-xs text-alert">
          {error}
        </p>
      )}
      <p className="mt-1 text-xs text-ink-faint">
        Enter to save · Shift+Enter for a new line · Esc to cancel
      </p>
    </div>
  );
}
