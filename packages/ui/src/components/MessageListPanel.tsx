import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ID, Message } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle, formatFull, formatWhen } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { Icon, type IconName } from "./Icon.js";
import { ListStatus } from "./ListStatus.js";
import { LoadMore } from "./LoadMore.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";
import { usePagedList } from "../lib/pagedList.js";

interface Props {
  title: string;
  emptyHint: ReactNode;
  /** The mark above an empty list's hint. */
  emptyIcon?: IconName;
  /** One thing to do about an empty list, such as clearing its filter. */
  emptyAction?: { label: string; run: () => void };
  load: (
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ messages: Message[]; nextCursor?: string | null }>;
  /** A different list whenever this changes, such as another channel's pins: read from the top. */
  listKey: string;
  /**
   * Reads the list again, in place, whenever this changes: what is listed may
   * have changed somewhere this panel cannot see for itself (UX-08).
   */
  refreshKey?: string | number;
  /** A control for the header, left of Close — a filter, usually. */
  headerExtra?: ReactNode;
  /** Extra detail beside a row's channel, such as an unread count. */
  itemBadge?: (message: Message) => ReactNode;
  /** Overrides the row's action wording when "Open message" is wrong. */
  jumpLabel?: (message: Message) => string;
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
}

/**
 * Right-hand panel listing a set of messages — pins for a channel, or the
 * user's saved items. Shares the thread panel's shape so the layout stays put.
 */
export function MessageListPanel(props: Props) {
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);
  const changedContent = useWorkspace((s) => s.changedContent);
  const scroller = useRef<HTMLDivElement>(null);
  const paged = usePagedList<Message>(
    (cursor, signal) =>
      props.load(cursor, signal).then((page) => ({
        items: page.messages,
        nextCursor: page.nextCursor ?? null,
      })),
    props.listKey,
  );
  const { list, items: messages } = paged;

  useEffect(() => {
    // Another list starts at its top.
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [props.listKey]);

  // Told that the list may have changed: read it again in place. A new list is
  // read from the top already, so its own change of signs is not news.
  const heard = useRef({ list: props.listKey, refresh: props.refreshKey });
  useEffect(() => {
    const before = heard.current;
    heard.current = { list: props.listKey, refresh: props.refreshKey };
    if (before.list === props.listKey && before.refresh !== props.refreshKey) list.refresh();
  }, [list, props.listKey, props.refreshKey]);

  // A message shown here was edited, deleted or unpinned, or its conversation
  // lost history: this copy of it is out of date.
  const heardChanges = useRef(changedContent);
  useEffect(() => {
    const before = heardChanges.current;
    heardChanges.current = changedContent;
    if (messages?.some((m) => changedContent[m.channelId] !== before[m.channelId])) list.refresh();
  }, [list, changedContent, messages]);

  const { panel, heading } = usePanelFocus({ takeFocus: true });

  return (
    <aside
      ref={panel}
      aria-label={props.title}
      className="flex w-[380px] max-w-full shrink-0 flex-col border-l border-edge"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 pl-4 pr-2 shadow-[0_1px_0_var(--color-edge)]">
        <h2 ref={heading} tabIndex={-1} className="flex-1 text-[15px] font-semibold outline-none">
          {props.title}
        </h2>
        {props.headerExtra}
        <button
          onClick={props.onClose}
          aria-label={`Close ${props.title}`}
          className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto p-3"
        aria-busy={paged.loading || paged.refreshing}
      >
        <ListStatus
          loading={paged.loading}
          placeholder={messages === null}
          loadingLabel="Loading messages…"
          error={
            paged.failed
              ? `Could not load ${props.title.toLowerCase()}.${
                  messages ? " What was shown is kept." : ""
                }`
              : null
          }
          onRetry={() => list.retry()}
          empty={messages?.length === 0 && !paged.nextCursor ? props.emptyHint : null}
          emptyIcon={props.emptyIcon}
          emptyAction={props.emptyAction}
        />
        <ul className="space-y-2">
          {(messages ?? [])
            .filter((message) => channels[message.channelId])
            .map((m) => {
              const channel = channels[m.channelId];
              // A one-to-one conversation is named by its other person, who
              // may be the author named just below: say the name once.
              const others = (channel?.memberIds ?? []).filter((id) => id !== selfId);
              const namedBelow =
                channel?.type === "dm" && others.length === 1 && others[0] === m.userId;
              return (
                <li key={m.id}>
                  <div className="w-full rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-ink/[0.035]">
                    <div className="mb-1.5 flex items-center gap-2 text-[12px] text-ink-faint">
                      <span className="truncate font-medium text-ink-dim">
                        {namedBelow
                          ? "Direct message"
                          : channel
                            ? channel.name
                              ? `#${channel.name}`
                              : channelTitle(channel, users, selfId)
                            : "unknown"}
                      </span>
                      {props.itemBadge?.(m)}
                      <time
                        dateTime={new Date(m.createdAt).toISOString()}
                        title={formatFull(m.createdAt)}
                        className="ml-auto shrink-0"
                      >
                        {formatWhen(m.createdAt)}
                      </time>
                    </div>
                    <div className="flex gap-2.5">
                      <Avatar user={users[m.userId]} size={28} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold">
                          {users[m.userId]?.displayName ?? "unknown"}
                        </div>
                        <div className="line-clamp-4 text-sm text-ink-dim">
                          {m.text ? (
                            <Mrkdwn
                              text={m.text}
                              users={users}
                              channels={channels}
                              selfId={selfId}
                            />
                          ) : (
                            <span className="italic">
                              {m.files.length} {m.files.length === 1 ? "file" : "files"}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      className="ml-[38px] mt-1.5 inline-flex items-center gap-1 rounded-md text-[12px] font-medium text-ink-faint transition-colors hover:text-ink"
                      onClick={() => props.onJump(m.channelId, m.id)}
                    >
                      {props.jumpLabel?.(m) ?? (m.threadRootId ? "Open reply" : "Open message")}
                      <Icon name="arrow" size={12} />
                    </button>
                  </div>
                </li>
              );
            })}
        </ul>
        <LoadMore
          more={!!paged.nextCursor}
          loading={paged.loadingMore}
          failed={paged.moreFailed}
          count={messages?.length ?? 0}
          onMore={() => list.loadMore()}
          scroller={scroller}
        />
      </div>
    </aside>
  );
}

/** Pinned messages for one channel. */
export function PinsPanel(props: {
  channelId: ID;
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
}) {
  const client = useClient();
  // Re-fetch whenever the set of pinned messages in view changes.
  const pinSignature = useWorkspace((s) =>
    (s.timelines[props.channelId]?.items ?? [])
      .filter((m) => m.pinned)
      .map((m) => m.id)
      .join(","),
  );
  // A pinned message older than the history loaded here is not in that list,
  // so its deletion, its edit or its unpinning by someone else would go unseen (Q08).
  const changed = useWorkspace((s) => s.changedContent[props.channelId] ?? 0);
  return (
    <MessageListPanel
      title="Pinned"
      emptyIcon="pin"
      emptyHint="Nothing pinned here yet. Pin a message to keep it handy for everyone in the channel."
      load={(cursor, signal) => client.api.listPins(props.channelId, signal, cursor)}
      listKey={props.channelId}
      refreshKey={`${pinSignature}:${changed}`}
      onClose={props.onClose}
      onJump={props.onJump}
    />
  );
}

/** The user's saved messages, across every channel they can see. */
export function SavedPanel(props: {
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
  /** Its neighbour: messages queued to send later. */
  onScheduled?: () => void;
}) {
  const client = useClient();
  const savedSignature = useWorkspace((s) => Object.keys(s.saved).sort().join(","));
  return (
    <MessageListPanel
      title="Saved"
      emptyIcon="bookmark"
      headerExtra={
        props.onScheduled && (
          <PanelLink icon="clock" label="Scheduled" onClick={props.onScheduled} />
        )
      }
      emptyHint={
        <>
          Choose <Icon name="bookmark" size={13} className="inline align-[-2px]" /> Save for later
          in a message&rsquo;s actions and it shows up here.
        </>
      }
      load={(cursor, signal) => client.api.listSaved(cursor, signal)}
      listKey="saved"
      refreshKey={savedSignature}
      onClose={props.onClose}
      onJump={props.onJump}
    />
  );
}

/**
 * Threads this account follows, most recently active first. Unlike Saved and
 * Pinned, a row stands for a conversation rather than a single message, so it
 * carries its own unread count and opens the thread instead of the message.
 */
export function ThreadsPanel(props: {
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
}) {
  const client = useClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [unread, setUnread] = useState<Record<ID, number>>({});
  // Following, unfollowing, reading and a new reply all change what belongs in
  // this list, or where, or what it says about a thread.
  const followSignature = useWorkspace((s) =>
    Object.values(s.threadFollows)
      .filter((f) => f.following)
      .map((f) => `${f.rootId}:${f.lastReadSeq}:${f.lastSeq}`)
      .sort()
      .join(","),
  );
  return (
    <MessageListPanel
      title="Threads"
      emptyIcon="thread"
      emptyHint={
        unreadOnly
          ? "No unread replies. Threads you follow show up here when someone answers."
          : "Reply to a message, or follow a thread, and it shows up here."
      }
      emptyAction={
        unreadOnly ? { label: "Show all threads", run: () => setUnreadOnly(false) } : undefined
      }
      headerExtra={
        <button
          onClick={() => setUnreadOnly((on) => !on)}
          aria-pressed={unreadOnly}
          className={`mr-1 h-7 rounded-full border px-2.5 text-[12px] font-medium transition-colors ${
            unreadOnly
              ? "border-transparent bg-ink/[0.08] text-ink"
              : "border-edge text-ink-faint hover:bg-ink/[0.05] hover:text-ink"
          }`}
        >
          Unread only
        </button>
      }
      load={async (cursor, signal) => {
        const result = await client.api.listFollowedThreads({ cursor, unreadOnly }, signal);
        if (!signal.aborted)
          setUnread((known) => ({
            ...known,
            ...Object.fromEntries(result.threads.map((t) => [t.root.id, t.unreadCount])),
          }));
        return { messages: result.threads.map((t) => t.root), nextCursor: result.nextCursor };
      }}
      listKey={`threads:${unreadOnly}`}
      refreshKey={followSignature}
      itemBadge={(m) =>
        unread[m.id] ? (
          <span className="rounded-full bg-copper px-2 font-semibold text-ground">
            {unread[m.id]} new {unread[m.id] === 1 ? "reply" : "replies"}
          </span>
        ) : null
      }
      jumpLabel={() => "Open thread"}
      onClose={props.onClose}
      onJump={props.onJump}
    />
  );
}

/** A step to a neighbouring panel, beside a panel's name. */
/**
 * A way across to a neighbouring panel. Its arrow and name say where it goes:
 * a bare "Scheduled" pill under a "Saved" title read as this list's status.
 */
export function PanelLink(props: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      aria-label={`Open ${props.label.toLowerCase()} messages`}
      className="mr-1 flex h-7 items-center gap-1.5 rounded-full border border-edge px-2.5 text-[12px] font-medium text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink"
    >
      <Icon name={props.icon} size={12} />
      {props.label}
      <Icon name="arrow" size={12} />
    </button>
  );
}
