import { useEffect, useId, useRef, useState } from "react";
import {
  anythingUnread,
  dueReminderCount,
  isMessageRead,
  markEverythingRead,
  notificationBody,
  PagedList,
} from "@ownbase/client-core";
import { isRoom, type ChannelRemoval, type ID, type Message } from "@ownbase/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle, formatFull } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
import { useToast } from "./Toast.js";
import { failureText } from "../lib/failure.js";
import { ListStatus } from "./ListStatus.js";
import { LoadMore } from "./LoadMore.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";
import { useFocusWhenGone } from "../lib/keys.js";
import { useTabs } from "../lib/useTabs.js";
import { useOpenList } from "../lib/pagedList.js";
import { dropRepeatClick } from "../lib/repeatClick.js";
import { RemindersList } from "./RemindersList.js";
import { When } from "./When.js";

/**
 * Activity's tabs (UX-52), and what each asks the server for. Reminders (E4)
 * is a list of its own, RemindersList.
 */
const MODES = ["all", "mentions", "threads", "reminders"] as const;
type ActivityMode = (typeof MODES)[number];
const ASKS = { all: "unread", mentions: "mentions", threads: "threads" } as const;
const nothing = async () => ({ items: [], nextCursor: null });
const NAMES: Record<ActivityMode, string> = {
  all: "All",
  mentions: "Mentions",
  threads: "Threads",
  reminders: "Reminders",
};
const ABOUT: Record<ActivityMode, string> = {
  all: "Unread messages in conversations you joined.",
  mentions: "Messages that mention you or everyone, in conversations you joined.",
  threads: "Unread replies in threads you follow.",
  reminders: "Messages you asked to be reminded about.",
};
const EMPTY: Record<Exclude<ActivityMode, "reminders">, string> = {
  all: "You're caught up.",
  mentions: "No mentions yet.",
  threads: "No unread replies in threads you follow.",
};
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

/** What All lists, newest first: groups of messages, and notes of removals between them. */
export type ActivityEntry =
  | { kind: "group"; group: ActivityGroup; at: number }
  | { kind: "removal"; removal: ChannelRemoval; at: number };

/**
 * Notes of removals placed among the groups by when each came. While older
 * messages are still to load, a note older than the oldest shown waits for
 * them, so it does not sit above messages that came before it.
 */
export function withRemovals(
  groups: ActivityGroup[],
  removals: ChannelRemoval[],
  loadedSince: number | null,
): ActivityEntry[] {
  const entries: ActivityEntry[] = groups.map((group) => ({
    kind: "group",
    group,
    at: group.messages[0]?.createdAt ?? 0,
  }));
  for (const removal of removals)
    if (loadedSince === null || removal.createdAt >= loadedSince)
      entries.push({ kind: "removal", removal, at: removal.createdAt });
  // Stable: groups keep the order they came in.
  return entries.sort((a, b) => b.at - a.at);
}

export function ActivityPanel({
  onClose,
  onJump,
  onOpenChannel,
}: {
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
  /** Opens a conversation at its newest, or a public channel's preview to one not in it. */
  onOpenChannel: (channelId: ID) => void;
}) {
  const client = useClient();
  const toast = useToast();
  const removals = useWorkspace((s) => s.channelRemovals);
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const memberships = useWorkspace((s) => s.memberships);
  const threadFollows = useWorkspace((s) => s.threadFollows);
  const repliesRead = useWorkspace((s) => s.repliesRead);
  const saved = useWorkspace((s) => s.saved);
  const dueReminders = useWorkspace(dueReminderCount);
  const modes: readonly ActivityMode[] = MODES;
  const [chosen, setMode] = useState<ActivityMode>("all");
  const mode = modes.includes(chosen) ? chosen : "all";
  const unreadAnywhere = useWorkspace(anythingUnread);
  const { panel, heading } = usePanelFocus({ takeFocus: true });
  const scroller = useRef<HTMLDivElement>(null);
  const groupId = useId();
  const tabs = useTabs({
    label: "Activity filter",
    tabs: modes,
    selected: mode,
    onSelect: setMode,
  });
  // Reminders is a list of its own, RemindersList; its tab reads nothing here.
  const [list, paged] = useOpenList(
    () =>
      mode === "reminders" ? new PagedList<Message>(nothing) : client.lists.activity(ASKS[mode]),
    mode,
  );
  const { items: result } = paged;

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [list]);

  const unread = (message: Message) =>
    !isMessageRead(message, { memberships, threadFollows, repliesRead });
  const messages = (result ?? []).filter(
    (message) =>
      channels[message.channelId] &&
      message.channelId in memberships &&
      (mode === "mentions" || unread(message)),
  );
  const groups = groupActivity(messages, mode === "threads");
  // Only All lists notes of removals, and only once its first page is in.
  const entries =
    mode === "all" && result
      ? withRemovals(
          groups,
          Object.values(removals),
          paged.nextCursor ? (result.at(-1)?.createdAt ?? null) : null,
        )
      : groups.map((group): ActivityEntry => ({ kind: "group", group, at: 0 }));

  /** Reads notes of removals, saying so if the server could not be told. */
  function readRemovals(ids: ID[]) {
    void client.readChannelRemovals(ids).then((error) => {
      if (error)
        toast({
          message: failureText("Could not mark that read.", error),
          kind: "error",
        });
    });
  }

  /**
   * Reads a note of a removal, and opens its channel where that can still be
   * done: a public channel's preview, from which one can join again, or a
   * private one they were since added back to. Otherwise says why not.
   */
  function openRemoval(removal: ChannelRemoval) {
    readRemovals([removal.id]);
    if (channels[removal.channelId]) {
      onOpenChannel(removal.channelId);
      return;
    }
    toast({
      message:
        removal.channelType === "private"
          ? `#${removal.channelName} is private. Only someone in it can add you back.`
          : `#${removal.channelName} no longer exists.`,
      kind: "info",
    });
  }

  /**
   * Reads a conversation through one message, or a thread through one reply.
   * A reply sent to the channel too is read where it was sent.
   */
  function markRead(message: Message) {
    if (message.threadRootId && !message.broadcast)
      client.markThreadRead(message.threadRootId, { explicit: true, through: message });
    else client.markRead(message.channelId, message.seq, { explicit: true });
  }

  function markAllRead() {
    void markEverythingRead(client).then((error) => {
      if (error)
        toast({ message: failureText("Could not mark everything read.", error), kind: "error" });
    });
  }

  /**
   * Where focus goes once Mark read, which held it, is gone: the row itself
   * where it stays (Mentions), else the next row, the one before, or the tab
   * when none is left.
   */
  const focusWhenGone = useFocusWhenGone();
  function keepFocusFrom(row: HTMLElement | null) {
    const rows = [
      ...(scroller.current?.querySelectorAll<HTMLElement>("[data-activity-row]") ?? []),
    ];
    const at = row ? rows.indexOf(row) : -1;
    const next = rows[at + 1] ?? rows[at - 1] ?? null;
    focusWhenGone(
      () =>
        (row?.isConnected ? row : next?.isConnected ? next : null) ??
        document.getElementById(tabs.tabProps(mode).id),
    );
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
              empty={result && !entries.length && !paged.nextCursor ? EMPTY[mode] : null}
              emptyIcon={mode === "mentions" ? "at" : mode === "threads" ? "thread" : "check"}
            />
            <div className="space-y-2.5">
              {entries.map((entry) => {
                if (entry.kind === "removal") {
                  const { removal } = entry;
                  return (
                    <ul key={removal.id}>
                      <RemovalRow
                        removal={removal}
                        remover={users[removal.removedBy]}
                        reachable={!!channels[removal.channelId]}
                        onOpen={() => openRemoval(removal)}
                        onRead={(row) => {
                          keepFocusFrom(row);
                          readRemovals([removal.id]);
                        }}
                      />
                    </ul>
                  );
                }
                const { group } = entry;
                const channel = channels[group.channelId]!;
                const where = isRoom(channel.type)
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
          className="fc-fill absolute left-0.5 top-4 size-1.5 rounded-full bg-copper"
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
              <When at={message.createdAt} />
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

/**
 * A note that someone removed you from a channel, as one row among the
 * messages: who, which channel as it was named then, when, and what pressing
 * it can still do. Unread until pressed or marked read, which clears it.
 */
function RemovalRow(props: {
  removal: ChannelRemoval;
  remover: Parameters<typeof Avatar>[0]["user"];
  /** The channel is still there for this account to open or preview. */
  reachable: boolean;
  onOpen: () => void;
  onRead: (row: HTMLElement | null) => void;
}) {
  const open = useRef<HTMLButtonElement>(null);
  const { removal } = props;
  const who = props.remover?.displayName ?? "Someone";
  const hint = props.reachable
    ? removal.channelType === "public"
      ? "Open it to read or join again"
      : "Open it"
    : removal.channelType === "private"
      ? "Private: only someone in it can add you back"
      : "It no longer exists";
  return (
    <li className="group/row relative" onClickCapture={dropRepeatClick}>
      <span
        aria-hidden="true"
        className="fc-fill absolute left-0.5 top-4 size-1.5 rounded-full bg-copper"
      />
      <button
        ref={open}
        type="button"
        data-activity-row=""
        onClick={props.onOpen}
        className="flex w-full items-start gap-2.5 rounded-lg py-1.5 pl-3 pr-2 text-left transition-colors hover:bg-ink/[0.035] focus-visible:bg-ink/[0.035] [@media(hover:none)]:pr-[2.75rem]"
      >
        <Avatar user={props.remover} size={24} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 text-[13px]">
            {/* Wraps rather than cut the channel's name, the point of the note. */}
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className="font-semibold">{who}</span> removed you from{" "}
              <span className="font-semibold">#{removal.channelName}</span>
            </span>
            <span className="sr-only">, unread</span>
            <time
              dateTime={new Date(removal.createdAt).toISOString()}
              title={formatFull(removal.createdAt)}
              className="ml-auto shrink-0 text-[12px] text-ink-faint"
            >
              <When at={removal.createdAt} />
            </time>
          </span>
          <span className="block truncate text-[13px] text-ink-dim">{hint}</span>
        </span>
      </button>
      <span className="absolute right-1.5 top-1 flex gap-0.5 rounded-lg bg-raised p-0.5 opacity-0 shadow-[0_1px_3px_rgb(0_0_0/0.18)] transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:top-2 [@media(hover:none)]:opacity-100">
        <Tooltip label="Clear this from Activity">
          <button
            type="button"
            aria-label="Mark read"
            className="flex size-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
            onClick={() => props.onRead(open.current)}
          >
            <Icon name="check" size={14} />
          </button>
        </Tooltip>
      </span>
    </li>
  );
}
