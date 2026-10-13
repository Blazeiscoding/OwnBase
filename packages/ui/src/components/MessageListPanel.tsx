import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ID, Message } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle, formatDay, formatTime, formatWhen } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { Icon, type IconName } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
import { ListStatus } from "./ListStatus.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";

interface Props {
  title: string;
  emptyHint: ReactNode;
  /** The mark above an empty list's hint. */
  emptyIcon?: IconName;
  /** One thing to do about an empty list, such as clearing its filter. */
  emptyAction?: { label: string; run: () => void };
  load: (
    cursor?: string,
    signal?: AbortSignal,
  ) => Promise<{ messages: Message[]; nextCursor?: string | null }>;
  /** Re-runs `load` whenever this changes (channel switch, save toggled). */
  reloadKey: string;
  /**
   * Asks for the page showing again, in place, whenever this changes: what is
   * listed may have changed somewhere this panel cannot see for itself.
   */
  refreshKey?: number;
  /** A control for the header, left of Refresh — a filter, usually. */
  headerExtra?: ReactNode;
  /** Extra detail beside a row's channel, such as an unread count. */
  itemBadge?: (message: Message) => ReactNode;
  /** Overrides the row's action wording when "Open message" is wrong. */
  jumpLabel?: (message: Message) => string;
  /** Wording for the row count, singular and plural. Defaults to messages. */
  countNoun?: [string, string];
  onClose: () => void;
  onJump: (channelId: ID, messageId: ID) => void;
}

/**
 * Right-hand panel listing a set of messages — pins for a channel, or the
 * user's saved items. Shares the thread panel's shape so the layout stays put.
 */
export function MessageListPanel(props: Props) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(0);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const retry = useRef<(() => void) | null>(null);
  /** The page last asked for, asked for again without moving the reader. */
  const again = useRef<(() => void) | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  async function loadPage(
    cursor: string | undefined,
    targetPage: number,
    targetCursors: (string | undefined)[],
    keepPlace = false,
  ) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    retry.current = () => void loadPage(cursor, targetPage, targetCursors);
    again.current = () => void loadPage(cursor, targetPage, targetCursors, true);
    setBusy(true);
    setError(false);
    try {
      const result = await props.load(cursor, controller.signal);
      if (controller.signal.aborted) return;
      setMessages(result.messages);
      setPage(targetPage);
      setCursors(targetCursors);
      setNextCursor(result.nextCursor ?? null);
      if (!keepPlace) scroller.current?.scrollTo({ top: 0 });
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (request.current === controller && !controller.signal.aborted) setBusy(false);
    }
  }

  useEffect(() => {
    setMessages(null);
    setNextCursor(null);
    setPage(0);
    setCursors([undefined]);
    void loadPage(undefined, 0, [undefined]);
    return () => {
      request.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, props.reloadKey]);
  const refreshed = useRef(props.refreshKey);
  useEffect(() => {
    if (refreshed.current === props.refreshKey) return;
    refreshed.current = props.refreshKey;
    again.current?.();
  }, [props.refreshKey]);
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
        <RefreshButton busy={busy} onClick={() => void loadPage(undefined, 0, [undefined])} />
        <button
          onClick={props.onClose}
          aria-label={`Close ${props.title}`}
          className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-3" aria-busy={busy}>
        <ListStatus
          loading={busy}
          placeholder={messages === null}
          loadingLabel="Loading messages…"
          error={
            error
              ? `Could not load ${props.title.toLowerCase()}.${
                  messages ? " The last loaded page is kept." : ""
                }`
              : null
          }
          onRetry={() => retry.current?.()}
          empty={messages?.length === 0 ? props.emptyHint : null}
          emptyIcon={props.emptyIcon}
          emptyAction={props.emptyAction}
        />
        <ul className="space-y-2">
          {(messages ?? [])
            .filter((message) => channels[message.channelId])
            .map((m) => {
              const channel = channels[m.channelId];
              return (
                <li key={m.id}>
                  <div className="w-full rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-ink/[0.035]">
                    <div className="mb-1.5 flex items-center gap-2 text-[12px] text-ink-faint">
                      <span className="truncate font-medium text-ink-dim">
                        {channel
                          ? channel.name
                            ? `#${channel.name}`
                            : channelTitle(channel, users, selfId)
                          : "unknown"}
                      </span>
                      {props.itemBadge?.(m)}
                      <time
                        dateTime={new Date(m.createdAt).toISOString()}
                        title={`${formatDay(m.createdAt)} · ${formatTime(m.createdAt)}`}
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
      </div>
      <footer
        // An empty list says so above; a count of nothing beneath it is noise.
        hidden={messages?.length === 0 && page === 0 && !nextCursor}
        className="border-t border-edge px-4 py-2 text-[12px] text-ink-faint"
      >
        <div role="status">
          {messages?.length ?? 0}{" "}
          {messages?.length === 1
            ? (props.countNoun?.[0] ?? "message")
            : (props.countNoun?.[1] ?? "messages")}
          {(page > 0 || nextCursor) && ` · Page ${page + 1}`}
        </div>
        {(page > 0 || nextCursor) && (
          <div className="mt-2 flex justify-between text-xs">
            <button
              disabled={busy || page === 0}
              className="font-medium text-ink-dim hover:text-ink disabled:opacity-40"
              onClick={() => void loadPage(cursors[page - 1], page - 1, cursors)}
            >
              Previous page
            </button>
            <button
              disabled={busy || !nextCursor}
              className="font-medium text-ink-dim hover:text-ink disabled:opacity-40"
              onClick={() => {
                if (nextCursor)
                  void loadPage(nextCursor, page + 1, [...cursors.slice(0, page + 1), nextCursor]);
              }}
            >
              Next page
            </button>
          </div>
        )}
      </footer>
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
      reloadKey={`${props.channelId}:${pinSignature}`}
      refreshKey={changed}
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
      reloadKey={`saved:${savedSignature}`}
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
  // Following, unfollowing and reading all change what belongs in this list.
  const followSignature = useWorkspace((s) =>
    Object.values(s.threadFollows)
      .filter((f) => f.following)
      .map((f) => `${f.rootId}:${f.lastReadSeq}`)
      .sort()
      .join(","),
  );
  return (
    <MessageListPanel
      title="Threads"
      emptyIcon="thread"
      countNoun={["thread", "threads"]}
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
        setUnread(Object.fromEntries(result.threads.map((t) => [t.root.id, t.unreadCount])));
        return { messages: result.threads.map((t) => t.root), nextCursor: result.nextCursor };
      }}
      reloadKey={`threads:${unreadOnly}:${followSignature}`}
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

/** Loads a panel's list again; it turns while it does. */
export function RefreshButton(props: { busy: boolean; onClick: () => void }) {
  return (
    <Tooltip label="Refresh">
      <button
        disabled={props.busy}
        aria-label="Refresh"
        onClick={props.onClick}
        className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-60"
      >
        <Icon name="refresh" size={15} className={props.busy ? "animate-spin" : ""} />
      </button>
    </Tooltip>
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
