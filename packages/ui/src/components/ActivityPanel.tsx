import { useEffect, useId, useRef, useState } from "react";
import { dueReminderCount, isMessageRead, notificationBody } from "@ownbase/client-core";
import type { ID, Message } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle, formatFull, formatWhen } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
import { ListStatus } from "./ListStatus.js";
import { LoadMore } from "./LoadMore.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";
import { useTabs } from "../lib/useTabs.js";
import { usePagedList } from "../lib/pagedList.js";
import { dropRepeatClick } from "../lib/repeatClick.js";
import { RemindersList } from "./RemindersList.js";

/**
 * Activity's tabs (UX-52), and what each asks the server for. Reminders (E4)
 * is a list of its own, RemindersList.
 */
const MODES = ["all", "mentions", "threads", "reminders"] as const;
type ActivityMode = (typeof MODES)[number];
const ASKS = { all: "unread", mentions: "mentions", threads: "threads" } as const;
const NAMES: Record<ActivityMode, string> = {
  all: "All",
  mentions: "Mentions",
  threads: "Threads",
  reminders: "Reminders",
};
const ABOUT: Record<ActivityMode, string> = {
  all: "Unread messages in conversations you joined.",
  mentions: "Direct and room-wide mentions in conversations you joined.",
  threads: "Unread replies in threads you follow.",
  reminders: "Messages you asked to be reminded about.",
};
const EMPTY: Record<Exclude<ActivityMode, "reminders">, string> = {
  all: "You're caught up.",
  mentions: "No mentions yet.",
  threads: "No unread replies in threads you follow.",
};
/**
 * How long a sign that Activity may be out of date waits for others like it,
 * so a burst of read, edit and count changes is one load (REV-05).
 */
export const ACTIVITY_REFRESH_DELAY_MS = 250;

/** The messages of one conversation, or of one thread in Threads, newest first. */
export interface ActivityGroup {
  key: string;
  channelId: ID;
  threadRootId: ID | null;
  messages: Message[];
}

/**
 * A newest-first list in groups by where each message was written, in the
 * order each group's newest message came, so the busiest place reads as one
 * heading ("5 new in #design") rather than five rows apart.
 */
export function groupActivity(messages: Message[], byThread: boolean): ActivityGroup[] {
  const groups = new Map<string, ActivityGroup>();
  for (const message of messages) {
    const threadRootId = byThread ? message.threadRootId : null;
    const key = threadRootId ?? message.channelId;
    let group = groups.get(key);
    if (!group) {
      group = { key, channelId: message.channelId, threadRootId, messages: [] };
      groups.set(key, group);
    }
    group.messages.push(message);
  }
  return [...groups.values()];
}

export function ActivityPanel({
  onClose,
  onJump,
}: {
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
}) {
  const client = useClient();
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const memberships = useWorkspace((s) => s.memberships);
  const threadFollows = useWorkspace((s) => s.threadFollows);
  const repliesRead = useWorkspace((s) => s.repliesRead);
  const mentionCounts = useWorkspace((s) => s.mentionCounts);
  const removedHistory = useWorkspace((s) => s.removedHistory);
  const changedContent = useWorkspace((s) => s.changedContent);
  const saved = useWorkspace((s) => s.saved);
  // An older server has no list of thread replies of its own to give.
  const threadsAnswered = useWorkspace((s) => s.activityThreads);
  // Nor reminders, which it does not keep.
  const remindersKept = useWorkspace((s) => s.reminders !== null);
  const dueReminders = useWorkspace(dueReminderCount);
  const modes: readonly ActivityMode[] = MODES.filter(
    (value) => (value !== "threads" || threadsAnswered) && (value !== "reminders" || remindersKept),
  );
  const [chosen, setMode] = useState<ActivityMode>("all");
  const mode = modes.includes(chosen) ? chosen : "all";
  // In All, a new message anywhere, or a new reply in a thread, may belong
  // here; in Threads, only a new reply.
  const arrivals = useWorkspace((s) =>
    mode === "mentions"
      ? ""
      : [
          ...(mode === "all"
            ? Object.entries(s.channelLastSeq)
                .filter(([channelId]) => channelId in s.memberships)
                .map(([channelId, seq]) => `${channelId}:${seq}`)
            : []),
          ...Object.values(s.threadFollows).map((f) => `${f.rootId}:${f.lastSeq}`),
        ]
          .sort()
          .join(","),
  );
  /** Whether anything is unread anywhere, which Mark all read reads. */
  const unreadAnywhere = useWorkspace(
    (s) =>
      Object.entries(s.memberships).some(([id, read]) => (s.channelLastSeq[id] ?? 0) > read) ||
      Object.values(s.threadFollows).some((f) => f.following && f.lastSeq > f.lastReadSeq),
  );
  const { panel, heading } = usePanelFocus({ takeFocus: true });
  const scroller = useRef<HTMLDivElement>(null);
  const groupId = useId();
  const tabs = useTabs({
    label: "Activity filter",
    tabs: modes,
    selected: mode,
    onSelect: setMode,
  });
  // Another tab is another list, read from the top. A sign that what is
  // shown may be out of date reads it again in place, and a burst of them is
  // one read, with what is shown kept meanwhile (REV-05).
  const paged = usePagedList<Message>(
    (cursor, signal) =>
      mode === "reminders"
        ? Promise.resolve({ items: [], nextCursor: null })
        : client.api
            .activity(ASKS[mode], { cursor, signal })
            .then((page) => ({ items: page.messages, nextCursor: page.nextCursor })),
    mode,
    ACTIVITY_REFRESH_DELAY_MS,
  );
  const { list, items: result } = paged;

  useEffect(() => {
    // Another list starts at its top.
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [mode]);

  // Each of these says the list may be out of date. The server refreshes the
  // mention counts for mention edits even when a count stays the same, so every
  // change of them is a reason to look again.
  const heard = useRef({ mode, mentionCounts, arrivals, changedContent, removedHistory });
  useEffect(() => {
    const before = heard.current;
    heard.current = { mode, mentionCounts, arrivals, changedContent, removedHistory };
    // Another tab is read from the top already.
    if (before.mode !== mode) return;
    const shown = (seqs: Record<ID, number>, was: Record<ID, number>) =>
      result?.some((m) => seqs[m.channelId] !== was[m.channelId]) ?? false;
    if (
      before.mentionCounts !== mentionCounts ||
      before.arrivals !== arrivals ||
      // Edited or deleted, or retention took threads from a conversation shown here.
      shown(changedContent, before.changedContent) ||
      shown(removedHistory, before.removedHistory)
    )
      list.refresh();
  }, [list, mode, mentionCounts, arrivals, changedContent, removedHistory, result]);

  const unread = (message: Message) =>
    !isMessageRead(message, { memberships, threadFollows, repliesRead });
  const messages = (result ?? []).filter(
    (message) =>
      channels[message.channelId] &&
      message.channelId in memberships &&
      (mode === "mentions" || unread(message)),
  );
  const groups = groupActivity(messages, mode === "threads");

  /**
   * Reads a conversation through one message, or a thread through one reply.
   * A reply sent to the channel too is read where it was sent.
   */
  function markRead(message: Message) {
    if (message.threadRootId && !message.broadcast)
      client.markThreadRead(message.threadRootId, { explicit: true, through: message });
    else client.markRead(message.channelId, message.seq, { explicit: true });
  }

  /** Every conversation and followed thread read to its newest, and every reply listed. */
  function markAllRead() {
    const state = client.state;
    for (const [channelId, read] of Object.entries(state.memberships)) {
      const newest = state.channelLastSeq[channelId] ?? 0;
      if (newest > read) client.markRead(channelId, newest, { explicit: true });
    }
    for (const follow of Object.values(state.threadFollows))
      if (follow.following && follow.lastSeq > follow.lastReadSeq)
        client.markThreadRead(follow.rootId, {
          explicit: true,
          through: { channelId: follow.channelId, seq: follow.lastSeq },
        });
    // A mention in a thread nobody follows is read through its thread too.
    const newestReply = new Map<ID, Message>();
    for (const message of messages)
      if (message.threadRootId && !message.broadcast && unread(message)) {
        const seen = newestReply.get(message.threadRootId);
        if (!seen || message.seq > seen.seq) newestReply.set(message.threadRootId, message);
      }
    for (const [rootId, message] of newestReply)
      client.markThreadRead(rootId, { explicit: true, through: message });
  }

  /**
   * Where focus goes once Mark read, which held it, is gone: the row itself
   * where it stays (Mentions), else the next row, the one before, or the tab
   * when none is left.
   */
  function keepFocusFrom(row: HTMLElement | null) {
    const rows = [
      ...(scroller.current?.querySelectorAll<HTMLElement>("[data-activity-row]") ?? []),
    ];
    const at = row ? rows.indexOf(row) : -1;
    const next = rows[at + 1] ?? rows[at - 1] ?? null;
    setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const target = row?.isConnected ? row : next?.isConnected ? next : null;
      (target ?? document.getElementById(tabs.tabProps(mode).id))?.focus();
    });
  }

  return (
    <aside
      ref={panel}
      aria-label="Activity"
      className="flex w-[420px] max-w-full shrink-0 flex-col border-l border-edge"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 pl-4 pr-2 shadow-[0_1px_0_var(--color-edge)]">
        <h2 ref={heading} tabIndex={-1} className="flex-1 text-[15px] font-semibold outline-none">
          Activity
        </h2>
        {unreadAnywhere && (
          <button
            type="button"
            onClick={markAllRead}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-ink-dim transition-colors hover:bg-ink/[0.06] hover:text-ink"
          >
            <Icon name="check" size={14} />
            Mark all read
          </button>
        )}
        <button
          aria-label="Close activity"
          className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div
        {...tabs.listProps}
        className="m-3 mb-1 flex gap-1 rounded-xl border border-edge bg-deep/40 p-1"
      >
        {modes.map((value) => (
          <button
            key={value}
            {...tabs.tabProps(value)}
            aria-label={
              value === "reminders" && dueReminders > 0
                ? `Reminders, ${dueReminders} due`
                : undefined
            }
            className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${mode === value ? "bg-lifted text-ink shadow-[0_1px_2px_rgb(0_0_0/0.2)]" : "text-ink-faint hover:text-ink"}`}
          >
            {NAMES[value]}
            {value === "reminders" && dueReminders > 0 && (
              <span className="ml-1 text-copper">{dueReminders}</span>
            )}
          </button>
        ))}
      </div>
      <div
        {...tabs.panelProps}
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2"
        aria-busy={paged.loading || paged.refreshing}
      >
        <p className="mb-2 px-2 text-xs text-ink-faint">{ABOUT[mode]}</p>
        {mode === "all" && dueReminders > 0 && (
          <button
            type="button"
            onClick={() => setMode("reminders")}
            className="mb-2 flex w-full items-center gap-2 rounded-lg border border-edge px-3 py-2 text-left text-[13px] font-medium text-ink transition-colors hover:bg-ink/[0.035]"
          >
            <Icon name="clock" size={14} className="text-copper" />
            {dueReminders === 1 ? "1 reminder is due" : `${dueReminders} reminders are due`}
            <Icon name="arrow" size={12} className="ml-auto text-ink-faint" />
          </button>
        )}
        {mode === "reminders" ? (
          <RemindersList onJump={onJump} />
        ) : (
          <>
            <ListStatus
              loading={paged.loading}
              placeholder={!result}
              loadingLabel="Loading activity…"
              error={
                paged.failed
                  ? "Could not load activity. Check your connection and try again."
                  : null
              }
              onRetry={() => list.retry()}
              empty={result && !messages.length && !paged.nextCursor ? EMPTY[mode] : null}
              emptyIcon={mode === "mentions" ? "at" : mode === "threads" ? "thread" : "check"}
            />
            <div className="space-y-2.5">
              {groups.map((group) => {
                const channel = channels[group.channelId]!;
                const where =
                  channel.type === "public" || channel.type === "private"
                    ? `#${channel.name}`
                    : // Each row names its author, the other person in a direct message.
                      channel.type === "dm"
                      ? "Direct message"
                      : channelTitle(channel, users, selfId);
                const fresh = group.messages.filter(unread).length;
                const title = group.threadRootId ? `Thread in ${where}` : where;
                return (
                  <section key={group.key} aria-labelledby={`${groupId}-${group.key}`}>
                    {/* Named outright: engines space the parts of a flex heading differently. */}
                    <h3
                      id={`${groupId}-${group.key}`}
                      aria-label={fresh > 0 ? `${title}, ${fresh} new` : title}
                      className="flex items-baseline gap-2 px-2 pb-0.5 text-[12px] font-semibold text-ink-dim"
                    >
                      <span className="truncate">{title}</span>
                      {fresh > 0 && (
                        <span className="ml-auto shrink-0 font-medium text-ink-faint">
                          {fresh} new
                        </span>
                      )}
                    </h3>
                    <ul>
                      {group.messages.map((message) => (
                        <ActivityRow
                          key={message.id}
                          message={message}
                          author={users[message.userId]?.displayName}
                          avatarUser={users[message.userId]}
                          preview={notificationBody(client.state, message)}
                          // Threads groups by thread already.
                          inThread={!!message.threadRootId && mode !== "threads"}
                          unread={unread(message)}
                          saved={!!saved[message.id]}
                          onOpen={() => onJump(message.channelId, message.id)}
                          onRead={(row) => {
                            keepFocusFrom(row);
                            markRead(message);
                          }}
                          onSave={() => void client.toggleSaved(message.id)}
                        />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
            <LoadMore
              more={!!paged.nextCursor}
              loading={paged.loadingMore}
              failed={paged.moreFailed}
              count={result?.length ?? 0}
              onMore={() => list.loadMore()}
              scroller={scroller}
            />
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * One message on one line: who, where in a thread, when, and the start of
 * what they said. The whole row opens it; Mark read and Save show on hover or
 * focus, and stay in sight where there is no hover.
 */
function ActivityRow(props: {
  message: Message;
  author: string | undefined;
  avatarUser: Parameters<typeof Avatar>[0]["user"];
  preview: string;
  inThread: boolean;
  unread: boolean;
  saved: boolean;
  onOpen: () => void;
  onRead: (row: HTMLElement | null) => void;
  onSave: () => void;
}) {
  const open = useRef<HTMLButtonElement>(null);
  const { message } = props;
  const action =
    "flex size-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink";
  return (
    // Mark read can take this row and the ones below it away, or itself
    // vanish, leaving the row's own button under the pointer.
    <li className="group/row relative" onClickCapture={dropRepeatClick}>
      {props.unread && (
        <span
          aria-hidden="true"
          className="absolute left-0.5 top-4 size-1.5 rounded-full bg-copper"
        />
      )}
      <button
        ref={open}
        type="button"
        data-activity-row=""
        onClick={props.onOpen}
        className="flex w-full items-start gap-2.5 rounded-lg py-1.5 pl-3 pr-2 text-left transition-colors hover:bg-ink/[0.035] focus-visible:bg-ink/[0.035] [@media(hover:none)]:pr-[4.5rem]"
      >
        <Avatar user={props.avatarUser} size={24} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 text-[13px]">
            <span className="truncate font-semibold">{props.author ?? "Unknown member"}</span>
            {props.inThread && (
              <span className="shrink-0 text-[12px] text-ink-faint">in a thread</span>
            )}
            {props.unread && <span className="sr-only">, unread</span>}
            <time
              dateTime={new Date(message.createdAt).toISOString()}
              title={formatFull(message.createdAt)}
              className="ml-auto shrink-0 text-[12px] text-ink-faint"
            >
              {formatWhen(message.createdAt)}
            </time>
          </span>
          <span className="block truncate text-[13px] text-ink-dim">{props.preview}</span>
        </span>
      </button>
      <span className="absolute right-1.5 top-1 flex gap-0.5 rounded-lg bg-raised p-0.5 opacity-0 shadow-[0_1px_3px_rgb(0_0_0/0.18)] transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:top-2 [@media(hover:none)]:opacity-100">
        {props.unread && (
          <Tooltip
            label={
              message.threadRootId && !message.broadcast
                ? "Mark the thread read up to here"
                : "Mark the conversation read up to here"
            }
          >
            <button
              type="button"
              aria-label="Mark read"
              className={action}
              onClick={() => props.onRead(open.current)}
            >
              <Icon name="check" size={14} />
            </button>
          </Tooltip>
        )}
        <Tooltip label={props.saved ? "Remove from saved" : "Save for later"}>
          <button
            type="button"
            aria-label="Save"
            aria-pressed={props.saved}
            className={`${action} ${props.saved ? "text-copper" : ""}`}
            onClick={props.onSave}
          >
            <Icon name="bookmark" size={14} />
          </button>
        </Tooltip>
      </span>
    </li>
  );
}
