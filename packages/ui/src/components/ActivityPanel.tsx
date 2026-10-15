import { useEffect, useRef, useState } from "react";
import { isMessageRead } from "@slackoss/client-core";
import type { ID, Message } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle, formatFull, formatWhen } from "../lib/format.js";
import { Avatar } from "./Avatar.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
import { ListStatus } from "./ListStatus.js";
import { LoadMore } from "./LoadMore.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";
import { useTabs } from "../lib/useTabs.js";
import { usePagedList } from "../lib/pagedList.js";

const MODES = ["unread", "mentions"] as const;
/**
 * How long a sign that Activity may be out of date waits for others like it,
 * so a burst of read, edit and count changes is one load (REV-05).
 */
export const ACTIVITY_REFRESH_DELAY_MS = 250;
type ActivityMode = (typeof MODES)[number];

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
  const memberships = useWorkspace((s) => s.memberships);
  const threadFollows = useWorkspace((s) => s.threadFollows);
  const repliesRead = useWorkspace((s) => s.repliesRead);
  const mentionCounts = useWorkspace((s) => s.mentionCounts);
  const removedHistory = useWorkspace((s) => s.removedHistory);
  const changedContent = useWorkspace((s) => s.changedContent);
  const [mode, setMode] = useState<ActivityMode>("unread");
  // In Unread, a new message anywhere, or a new reply in a thread, may belong here.
  const arrivals = useWorkspace((s) =>
    mode === "unread"
      ? [
          ...Object.entries(s.channelLastSeq)
            .filter(([channelId]) => channelId in s.memberships)
            .map(([channelId, seq]) => `${channelId}:${seq}`),
          ...Object.values(s.threadFollows).map((f) => `${f.rootId}:${f.lastSeq}`),
        ]
          .sort()
          .join(",")
      : "",
  );
  const { panel, heading } = usePanelFocus({ takeFocus: true });
  const scroller = useRef<HTMLDivElement>(null);
  const tabs = useTabs({
    label: "Activity filter",
    tabs: MODES,
    selected: mode,
    onSelect: setMode,
  });
  // Another filter is another list, read from the top. A sign that what is
  // shown may be out of date reads it again in place, and a burst of them is
  // one read, with what is shown kept meanwhile (REV-05).
  const paged = usePagedList<Message>(
    (cursor, signal) =>
      client.api
        .activity(mode, { cursor, signal })
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
    // Another filter is read from the top already.
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

  const messages = (result ?? []).filter(
    (message) =>
      channels[message.channelId] &&
      message.channelId in memberships &&
      (mode === "mentions" || !isMessageRead(message, { memberships, threadFollows, repliesRead })),
  );

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
        {MODES.map((value) => (
          <button
            key={value}
            {...tabs.tabProps(value)}
            className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${mode === value ? "bg-lifted text-ink shadow-[0_1px_2px_rgb(0_0_0/0.2)]" : "text-ink-faint hover:text-ink"}`}
          >
            {value === "unread" ? "Unread" : "Mentions"}
          </button>
        ))}
      </div>
      <div
        {...tabs.panelProps}
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto p-3"
        aria-busy={paged.loading || paged.refreshing}
      >
        <p className="mb-2 px-1 text-xs text-ink-faint">
          {mode === "unread"
            ? "Unread messages in conversations you joined."
            : "Direct and room-wide mentions in conversations you joined."}
        </p>
        <ListStatus
          loading={paged.loading}
          placeholder={!result}
          loadingLabel="Loading activity…"
          error={
            paged.failed ? "Could not load activity. Check your connection and try again." : null
          }
          onRetry={() => list.retry()}
          empty={
            result && !messages.length && !paged.nextCursor
              ? mode === "unread"
                ? "You're caught up."
                : "No mentions yet."
              : null
          }
          emptyIcon={mode === "unread" ? "check" : "at"}
        />
        <ul className="space-y-1">
          {messages.map((message) => {
            const unread = !isMessageRead(message, { memberships, threadFollows, repliesRead });
            const channel = channels[message.channelId]!;
            const author = users[message.userId];
            const isRoom = channel.type === "public" || channel.type === "private";
            return (
              <li
                key={message.id}
                className="group relative rounded-xl px-3 py-2.5 transition-colors hover:bg-ink/[0.035]"
              >
                {unread && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0.5 top-4 size-1.5 rounded-full bg-copper"
                  />
                )}
                <div className="flex gap-2.5">
                  <Avatar user={author} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5 text-[13px]">
                      <span className="truncate font-semibold">
                        {author?.displayName ?? "Unknown member"}
                      </span>
                      {isRoom && (
                        <span className="truncate text-ink-faint">
                          in {channelTitle(channel, users, client.state.self?.id)}
                        </span>
                      )}
                      {unread && <span className="sr-only">, unread</span>}
                      <time
                        dateTime={new Date(message.createdAt).toISOString()}
                        title={formatFull(message.createdAt)}
                        className="ml-auto shrink-0 text-[12px] text-ink-faint"
                      >
                        {formatWhen(message.createdAt)}
                      </time>
                    </div>
                    {message.threadRootId && (
                      <p className="text-[12px] text-ink-faint">Thread reply</p>
                    )}
                    <div className="mt-0.5 line-clamp-3 text-sm text-ink-dim">
                      <Mrkdwn
                        text={message.text}
                        users={users}
                        channels={channels}
                        selfId={client.state.self?.id}
                      />
                    </div>
                    {message.files.length > 0 && (
                      <p className="mt-1 text-xs text-ink-faint">
                        {message.files.length} attachment{message.files.length === 1 ? "" : "s"}
                      </p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[12px] font-medium">
                      <button
                        className="inline-flex items-center gap-1 text-ink-dim hover:text-ink"
                        onClick={() => onJump(message.channelId, message.id)}
                      >
                        Open in conversation
                        <Icon name="arrow" size={12} />
                      </button>
                      {unread && (
                        <Tooltip label="Mark this conversation read through this message">
                          <button
                            className="text-ink-faint hover:text-ink"
                            onClick={() =>
                              client.markRead(message.channelId, message.seq, { explicit: true })
                            }
                          >
                            Read through here
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        <LoadMore
          more={!!paged.nextCursor}
          loading={paged.loadingMore}
          failed={paged.moreFailed}
          count={result?.length ?? 0}
          onMore={() => list.loadMore()}
          scroller={scroller}
        />
      </div>
    </aside>
  );
}
