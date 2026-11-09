import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ID, Message } from "@ownbase/protocol";
import type { PagedList, PagedListState } from "@ownbase/client-core";
import { failureText } from "../lib/failure.js";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle, formatFull } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { Icon, type IconName } from "./Icon.js";
import { ListStatus } from "./ListStatus.js";
import { LoadMore } from "./LoadMore.js";
import { useOptionalToast } from "./Toast.js";
import { Tooltip } from "./Tooltip.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";
import { useOpenList } from "../lib/pagedList.js";
import { dropRepeatClick } from "../lib/repeatClick.js";
import { When } from "./When.js";

interface Props {
  title: string;
  emptyHint: ReactNode;
  /** The mark above an empty list's hint. */
  emptyIcon?: IconName;
  /** One thing to do about an empty list, such as clearing its filter. */
  emptyAction?: { label: string; run: () => void };
  /** One of `client.lists`, open while shown; another list starts at its top. */
  list: PagedList<Message>;
  state: PagedListState<Message>;
  /** A control for the header, left of Close — a filter, usually. */
  headerExtra?: ReactNode;
  /** Extra detail beside a row's channel, such as an unread count. */
  itemBadge?: (message: Message) => ReactNode;
  /** More about a row under its message, such as a thread's newest reply. */
  itemFooter?: (message: Message) => ReactNode;
  /** Overrides the row's action wording when "Open message" is wrong. */
  jumpLabel?: (message: Message) => string;
  /**
   * Whether a row read from the server still belongs here as far as this
   * device knows: one taken out goes at once, not when the list is next read.
   */
  keep?: (message: Message) => boolean;
  /** Takes a row out of the list, such as unsaving it. Shows on hover or focus. */
  remove?: { label: string; icon: IconName; run: (message: Message) => void };
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
  const scroller = useRef<HTMLDivElement>(null);
  const { list, state: paged } = props;
  const messages = paged.items;

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [list]);

  const { panel, heading } = usePanelFocus({ takeFocus: true });
  const shown = (messages ?? []).filter((m) => channels[m.channelId] && (props.keep?.(m) ?? true));

  /** Takes the row out and keeps keyboard focus nearby rather than on the page. */
  function remove(message: Message, from: HTMLElement) {
    const rows = [...(scroller.current?.querySelectorAll<HTMLElement>("[data-list-row]") ?? [])];
    const at = rows.indexOf(from.closest<HTMLElement>("[data-list-row]")!);
    const next = rows[at + 1] ?? rows[at - 1] ?? null;
    props.remove!.run(message);
    setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const open = next?.isConnected ? next.querySelector<HTMLElement>("[data-list-open]") : null;
      (open ?? heading.current)?.focus();
    });
  }

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
          empty={messages && shown.length === 0 && !paged.nextCursor ? props.emptyHint : null}
          emptyIcon={props.emptyIcon}
          emptyAction={props.emptyAction}
        />
        <ul className="space-y-2">
          {shown.map((m) => {
            const channel = channels[m.channelId];
            // A one-to-one conversation is named by its other person, who
            // may be the author named just below: say the name once.
            const others = (channel?.memberIds ?? []).filter((id) => id !== selfId);
            const namedBelow =
              channel?.type === "dm" && others.length === 1 && others[0] === m.userId;
            return (
              <li
                key={m.id}
                data-list-row=""
                className="group/row relative"
                onClickCapture={props.remove ? dropRepeatClick : undefined}
              >
                <div className="w-full rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-ink/[0.035]">
                  <div
                    className={`mb-1.5 flex items-center gap-2 text-[12px] text-ink-faint ${
                      // Where there is no hover the action stays over this line's end.
                      props.remove ? "[@media(hover:none)]:pr-9" : ""
                    }`}
                  >
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
                      <When at={m.createdAt} />
                    </time>
                  </div>
                  <div className="flex gap-2.5">
                    <Avatar user={users[m.userId]} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold">
                        {users[m.userId]?.displayName ?? "unknown"}
                      </div>
                      <div className="bidi-text line-clamp-4 text-sm text-ink-dim">
                        {m.text ? (
                          <Mrkdwn text={m.text} users={users} channels={channels} selfId={selfId} />
                        ) : (
                          <span className="italic">
                            {m.files.length} {m.files.length === 1 ? "file" : "files"}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {props.itemFooter?.(m)}
                  <button
                    data-list-open=""
                    className="ml-[38px] mt-1.5 inline-flex items-center gap-1 rounded-md text-[12px] font-medium text-ink-faint transition-colors hover:text-ink"
                    onClick={() => props.onJump(m.channelId, m.id)}
                  >
                    {props.jumpLabel?.(m) ?? (m.threadRootId ? "Open reply" : "Open message")}
                    <Icon name="arrow" size={12} />
                  </button>
                </div>
                {props.remove && (
                  <span className="absolute right-1.5 top-1 flex rounded-lg bg-raised p-0.5 opacity-0 shadow-[0_1px_3px_rgb(0_0_0/0.18)] transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:top-2 [@media(hover:none)]:opacity-100">
                    <Tooltip label={props.remove.label}>
                      <button
                        type="button"
                        aria-label={props.remove.label}
                        // Copper, as a saved message's own bookmark is.
                        className="flex size-7 items-center justify-center rounded-md text-copper transition-colors hover:bg-ink/[0.06]"
                        onClick={(event) => remove(m, event.currentTarget)}
                      >
                        <Icon name={props.remove.icon} size={14} />
                      </button>
                    </Tooltip>
                  </span>
                )}
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
  const toast = useOptionalToast();
  // Pinning changes the channel for everyone, which a guest may not.
  const guest = useWorkspace((s) => s.self?.role === "guest");
  /** Unpinned from here, so gone at once rather than when the list is next read. */
  const [unpinned, setUnpinned] = useState<ReadonlySet<ID>>(() => new Set());

  /** As Saved's own Remove: the row goes at once, with Undo, and comes back if refused. */
  function setPinned(message: Message, pin: boolean) {
    const mark = (gone: boolean) =>
      setUnpinned((before) => {
        const next = new Set(before);
        if (gone) next.add(message.id);
        else next.delete(message.id);
        return next;
      });
    mark(!pin);
    const hideUndo = pin
      ? undefined
      : toast?.({
          message: "Unpinned.",
          kind: "success",
          action: { label: "Undo", run: () => setPinned(message, true) },
        });
    void client.togglePin({ ...message, pinned: !pin }).then((error) => {
      if (!error) return;
      hideUndo?.();
      mark(pin);
      toast?.({
        message: failureText(
          pin ? "Could not pin that message again." : "Could not unpin that message.",
          error,
        ),
        kind: "error",
        action: { label: "Try again", run: () => setPinned(message, pin) },
      });
    });
  }
  const [list, state] = useOpenList(() => client.lists.pins(props.channelId), props.channelId);
  return (
    <MessageListPanel
      title="Pinned"
      emptyIcon="pin"
      emptyHint="Nothing pinned here yet. Pin a message to keep it handy for everyone in the channel."
      list={list}
      state={state}
      keep={(m) => !unpinned.has(m.id)}
      remove={
        guest
          ? undefined
          : { label: "Unpin from channel", icon: "pin", run: (m) => setPinned(m, false) }
      }
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
  const toast = useOptionalToast();
  const saved = useWorkspace((s) => s.saved);
  const [list, state] = useOpenList(() => client.lists.saved(), "saved");

  /**
   * Optimistic, like the message's own bookmark: the row goes at once and
   * comes back if the server refuses, with the news and a second try.
   */
  function setSaved(message: Message, save: boolean) {
    const hideUndo = save
      ? undefined
      : toast?.({
          message: "Removed from Saved.",
          kind: "success",
          action: { label: "Undo", run: () => setSaved(message, true) },
        });
    void client.toggleSaved(message.id, save).then((error) => {
      if (!error) return;
      hideUndo?.();
      toast?.({
        message: failureText(
          save ? "Could not put that back in Saved." : "Could not remove that from Saved.",
          error,
        ),
        action: { label: "Try again", run: () => setSaved(message, save) },
      });
    });
  }

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
      list={list}
      state={state}
      keep={(m) => !!saved[m.id]}
      remove={{
        label: "Remove from Saved",
        icon: "bookmark",
        run: (m) => setSaved(m, false),
      }}
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
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);
  const [list, state] = useOpenList(
    () => client.lists.followedThreads(unreadOnly),
    `threads:${unreadOnly}`,
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
      list={list}
      state={state}
      itemBadge={(m) => {
        const unread = list.detail(m.id)?.unreadCount;
        return unread ? (
          <span className="rounded-full bg-copper px-2 font-semibold text-ground">
            {unread} new {unread === 1 ? "reply" : "replies"}
          </span>
        ) : null;
      }}
      // As the conversation says it under the thread's first message.
      // Where the thread has got to: its newest reply, who wrote it and when.
      itemFooter={(m) => {
        const reply = list.detail(m.id)?.latestReply;
        if (!reply) return null;
        return (
          <div className="ml-[38px] mt-2 flex gap-2 border-l-2 border-edge pl-2.5 text-[13px]">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-[12px]">
                <span className="truncate font-semibold text-ink-dim">
                  {reply.userId === selfId
                    ? "You"
                    : (users[reply.userId]?.displayName ?? "unknown")}
                </span>
                <time
                  dateTime={new Date(reply.createdAt).toISOString()}
                  title={formatFull(reply.createdAt)}
                  className="shrink-0 text-ink-faint"
                >
                  <When at={reply.createdAt} />
                </time>
              </div>
              <div className="bidi-text line-clamp-2 text-ink-dim">
                {reply.text ? (
                  <Mrkdwn text={reply.text} users={users} channels={channels} selfId={selfId} />
                ) : (
                  <span className="italic">
                    {reply.files.length} {reply.files.length === 1 ? "file" : "files"}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      }}
      jumpLabel={(m) =>
        m.replyCount > 0
          ? `${m.replyCount} ${m.replyCount === 1 ? "reply" : "replies"}`
          : "Open thread"
      }
      onClose={props.onClose}
      onJump={props.onJump}
    />
  );
}

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
