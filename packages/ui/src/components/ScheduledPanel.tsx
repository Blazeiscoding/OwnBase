import { useEffect, useRef, useState } from "react";
import { MESSAGE_TEXT_MAX, type ID, type ScheduledMessage } from "@ownbase/protocol";
import { ApiError } from "@ownbase/client-core";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle } from "../lib/format.js";
import { formatScheduleTime, localDateTime } from "../lib/schedule.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { Icon } from "./Icon.js";
import { ListStatus } from "./ListStatus.js";
import { PanelLink } from "./MessageListPanel.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";
import { useOpenList } from "../lib/pagedList.js";
import { readScheduledEditDraft as draftText, scheduledEditDraftKey } from "../lib/drafts.js";

/** Messages queued to go out later, with the option to call them back. */
export function ScheduledPanel(props: {
  onClose: () => void;
  onJump: (channelId: ID) => void;
  /** Its neighbour: messages saved for later. */
  onSaved?: () => void;
  /** A queued message whose unsaved edit to open once the list has it, from Drafts. */
  initialEdit?: ID;
}) {
  const client = useClient();
  const { panel, heading } = usePanelFocus({ takeFocus: true });
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);
  const [list, { items, loading, failed }] = useOpenList(
    () => client.lists.scheduled(),
    "scheduled",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ID | null>(null);
  const [confirmation, setConfirmation] = useState<{ id: ID; kind: "cancel" | "send" } | null>(
    null,
  );
  const [changing, setChanging] = useState<ID | null>(null);
  const [when, setWhen] = useState("");
  const [editing, setEditing] = useState<ScheduledMessage | null>(null);
  const [editText, setEditText] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const edited = useRef(false);
  const editKey = editing ? scheduledEditDraftKey(editing.channelId, editing.id) : null;
  const savedEdit = useWorkspace((s) => draftText(editKey ? s.drafts[editKey] : undefined));
  const currentEdit = items?.find((item) => item.id === editing?.id);
  useEffect(() => {
    if (!edited.current && savedEdit !== undefined) setEditText(savedEdit);
  }, [savedEdit]);
  const alive = useRef(true);
  const mutating = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // A read that starts again hides what the last change said went wrong.
  useEffect(() => {
    if (loading) setError(null);
  }, [loading]);

  async function saveText() {
    if (!editing || !editKey || mutating.current) return;
    mutating.current = true;
    setBusy(editing.id);
    setEditError(null);
    let failed = false;
    try {
      await list.edit(editing.id, { text: editText, expectedText: editing.text });
      if (draftText(client.state.drafts[editKey]) === editText) client.setDraft(editKey, "");
      if (alive.current) setEditing(null);
    } catch (err) {
      failed = true;
      if (alive.current)
        setEditError(
          err instanceof ApiError && err.code === "scheduled_changed"
            ? "The text changed on another device, so this edit was not saved. Your edit is still here."
            : "Could not tell if your edit was saved. Your edit is still here. Check the list to see if the message has already sent or changed.",
        );
    } finally {
      mutating.current = false;
      if (alive.current) setBusy(null);
    }
    // What the queue holds now: the current text to compare, or the message gone.
    if (failed && alive.current) void list.reload();
  }

  function startEditing(s: ScheduledMessage) {
    setEditing(s);
    edited.current = false;
    setEditText(draftText(client.state.drafts[scheduledEditDraftKey(s.channelId, s.id)]) ?? s.text);
    setEditError(null);
    setConfirmation(null);
    setChanging(null);
  }

  // Opened from Drafts on one queued message's unsaved edit: open it once
  // the list has it, and only once.
  const editAsked = useRef(props.initialEdit);
  useEffect(() => {
    const wanted = items?.find((item) => item.id === editAsked.current);
    if (!wanted) return;
    editAsked.current = undefined;
    startEditing(wanted);
  });

  async function change(id: ID, sendAt?: number) {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(id);
    setError(null);
    try {
      if (sendAt === undefined) await list.cancel(id);
      else await list.reschedule(id, sendAt);
      if (alive.current) {
        setConfirmation(null);
        setChanging(null);
      }
    } catch {
      if (alive.current)
        setError(
          "Could not tell if this change went through. The message may already have sent, or changed on another device. Refresh the list before you try again.",
        );
    } finally {
      mutating.current = false;
      if (alive.current) setBusy(null);
    }
  }

  return (
    <aside
      ref={panel}
      aria-label="Scheduled messages"
      className="flex w-[380px] max-w-full shrink-0 flex-col border-l border-edge"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 pl-4 pr-2 shadow-[0_1px_0_var(--color-edge)]">
        <h2 ref={heading} tabIndex={-1} className="flex-1 text-[15px] font-semibold outline-none">
          Scheduled
        </h2>
        {props.onSaved && <PanelLink icon="bookmark" label="Saved" onClick={props.onSaved} />}
        <button
          onClick={props.onClose}
          aria-label="Close scheduled messages"
          className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3" aria-busy={loading}>
        <ListStatus
          // The list keeps itself current; only the first load, with nothing
          // to show yet, is worth saying.
          loading={loading && items === null}
          placeholder
          loadingLabel="Loading scheduled messages…"
          error={
            error ??
            (failed
              ? "Could not refresh scheduled messages. The list below may be out of date."
              : null)
          }
          retryLabel="Refresh"
          onRetry={() => void list.reload()}
          empty={
            items?.length === 0 ? (
              <>
                Nothing scheduled. Write a message, then choose{" "}
                <Icon name="clock" size={13} className="inline align-[-2px]" /> Send later beside
                the send button.
              </>
            ) : null
          }
          emptyIcon="clock"
        />
        {editing && (
          <form
            className="mb-3 space-y-2 rounded-xl border border-copper/40 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void saveText();
            }}
          >
            <label className="block text-sm font-medium">
              Edit scheduled text
              <textarea
                dir="auto"
                autoFocus
                value={editText}
                disabled={busy !== null}
                onChange={(event) => {
                  edited.current = true;
                  setEditText(event.target.value);
                  // A serialized value preserves an intentionally empty edit;
                  // ordinary empty composer drafts are removed by setDraft.
                  if (editKey)
                    client.setDraft(editKey, JSON.stringify({ text: event.target.value }));
                }}
                className="mt-2 min-h-28 w-full rounded-lg border border-edge bg-ground p-2 font-normal"
              />
            </label>
            <p
              className={`text-xs ${editText.length > MESSAGE_TEXT_MAX ? "text-alert" : "text-ink-faint"}`}
            >
              {editText.length.toLocaleString()} / {MESSAGE_TEXT_MAX.toLocaleString()} characters
              {editing.fileIds.length === 1
                ? " · 1 file stays attached"
                : editing.fileIds.length > 1
                  ? ` · ${editing.fileIds.length} files stay attached`
                  : ""}
            </p>
            <p className="text-xs text-ink-faint">
              It still sends at the same time, even while you edit it.
            </p>
            {editError && (
              <p role="alert" className="text-sm text-alert">
                {editError}
              </p>
            )}
            {!currentEdit && (
              <p role="status" className="text-sm text-ink-dim">
                This message is no longer scheduled. Copy your text first if you want to keep it.
              </p>
            )}
            {currentEdit && currentEdit.text !== editing.text && (
              <div className="text-sm text-ink-dim">
                The scheduled text changed somewhere else. Your edit is still here.
                <button
                  type="button"
                  disabled={busy !== null}
                  className="ml-1 font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
                  onClick={() => {
                    setEditing(currentEdit);
                    setEditText(currentEdit.text);
                    edited.current = true;
                    if (editKey)
                      client.setDraft(editKey, JSON.stringify({ text: currentEdit.text }));
                    setEditError(null);
                  }}
                >
                  Use the newer text instead
                </button>
              </div>
            )}
            <details className="bidi-text group text-sm text-ink-dim">
              <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 hover:text-ink">
                <Icon
                  name="chevronDown"
                  size={14}
                  className="-rotate-90 transition-transform group-open:rotate-0"
                />
                Preview
              </summary>
              <Mrkdwn text={editText} users={users} channels={channels} selfId={selfId} />
            </details>
            <div className="flex gap-3 text-sm">
              <button
                type="submit"
                className="text-copper"
                disabled={
                  busy !== null ||
                  !currentEdit ||
                  editText.length > MESSAGE_TEXT_MAX ||
                  (!editText.trim() && editing.fileIds.length === 0)
                }
              >
                {busy === editing.id ? "Saving…" : "Save text"}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  if (editKey) client.setDraft(editKey, "");
                  setEditing(null);
                  setEditError(null);
                }}
              >
                Discard edit
              </button>
            </div>
          </form>
        )}
        <ul className="space-y-2">
          {(items ?? []).map((s) => {
            const channel = channels[s.channelId];
            return (
              <li key={s.id} className="rounded-xl border border-edge bg-raised p-3">
                <div className="mb-1.5 flex items-center gap-2 text-[11px]">
                  <button
                    onClick={() => props.onJump(s.channelId)}
                    disabled={!channel}
                    className="font-medium text-ink hover:underline"
                  >
                    {channel
                      ? channel.name
                        ? `#${channel.name}`
                        : channelTitle(channel, users, selfId)
                      : "Unavailable conversation"}
                  </button>
                  {s.threadRootId && (
                    <span className="text-ink-faint">
                      {s.broadcast ? "Reply, also sent to the channel" : "Reply in thread"}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-ink-faint">
                    {formatScheduleTime(s.sendAt)}
                  </span>
                </div>
                {s.status !== "queued" && (
                  <p
                    className={`mb-1.5 text-[11px] ${s.status === "failed" ? "text-alert" : "text-ink-faint"}`}
                  >
                    <span className="font-medium">
                      {s.status === "failed" ? "Not sent" : "Waiting"}
                    </span>
                    {s.failureReason ? `. ${s.failureReason}` : ""}
                  </p>
                )}
                <div className="bidi-text text-sm text-ink-dim">
                  {s.text ? (
                    <Mrkdwn text={s.text} users={users} channels={channels} selfId={selfId} />
                  ) : (
                    <span className="italic">
                      {s.fileIds.length} {s.fileIds.length === 1 ? "file" : "files"}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    disabled={busy !== null || editing !== null}
                    className="rounded-lg border border-edge px-2.5 py-1 text-xs text-ink-dim hover:border-ink-faint/50"
                    onClick={() => startEditing(s)}
                  >
                    Edit text
                  </button>
                  <button
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmation({ id: s.id, kind: "cancel" });
                      setChanging(null);
                    }}
                    className="rounded-lg border border-edge px-2.5 py-1 text-[12px] text-ink-faint transition-colors hover:border-alert hover:text-alert"
                  >
                    {s.status === "queued" ? "Remove" : "Discard"}
                  </button>
                  <button
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmation({ id: s.id, kind: "send" });
                      setChanging(null);
                    }}
                    className="rounded-lg border border-edge px-2.5 py-1 text-[12px] text-ink-dim transition-colors hover:border-ink-faint/50 hover:text-ink"
                  >
                    {s.status === "queued" ? "Send now" : "Retry now"}
                  </button>
                  <button
                    disabled={busy !== null}
                    className="rounded-lg border border-edge px-2.5 py-1 text-xs text-ink-dim hover:border-ink-faint/50"
                    onClick={() => {
                      setChanging(s.id);
                      setWhen(localDateTime(new Date(Math.max(s.sendAt, Date.now() + 3600_000))));
                      setConfirmation(null);
                    }}
                  >
                    Change time
                  </button>
                </div>
                {confirmation?.id === s.id && (
                  <div className="mt-3 rounded-lg border border-edge p-2 text-sm">
                    <p>
                      {confirmation.kind === "cancel"
                        ? "Remove this scheduled message?"
                        : "Send this message now?"}
                    </p>
                    <div className="mt-2 flex gap-3">
                      <button
                        disabled={busy !== null}
                        className="text-copper"
                        onClick={() =>
                          void change(s.id, confirmation.kind === "send" ? Date.now() : undefined)
                        }
                      >
                        {busy === s.id
                          ? "Working…"
                          : confirmation.kind === "cancel"
                            ? "Remove message"
                            : "Send now"}
                      </button>
                      <button disabled={busy !== null} onClick={() => setConfirmation(null)}>
                        Keep as is
                      </button>
                    </div>
                  </div>
                )}
                {changing === s.id && (
                  <form
                    className="mt-3 space-y-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const time = new Date(when).getTime();
                      if (!Number.isFinite(time) || time <= Date.now()) {
                        setError("Choose a time in the future.");
                        return;
                      }
                      void change(s.id, time);
                    }}
                  >
                    <label className="block text-xs text-ink-faint">
                      New date and time
                      <input
                        type="datetime-local"
                        required
                        disabled={busy !== null}
                        value={when}
                        min={localDateTime(new Date())}
                        onChange={(e) => setWhen(e.target.value)}
                        className="mt-1 w-full min-w-0 rounded border border-edge bg-ground px-2 py-1 text-sm text-ink"
                      />
                    </label>
                    <p className="text-[11px] text-ink-faint">Uses your device's time zone.</p>
                    <div className="flex gap-3 text-xs">
                      <button disabled={busy !== null} className="text-copper" type="submit">
                        {busy === s.id ? "Saving…" : "Save time"}
                      </button>
                      <button
                        disabled={busy !== null}
                        type="button"
                        onClick={() => setChanging(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
