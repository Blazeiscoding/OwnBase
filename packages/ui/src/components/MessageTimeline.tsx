import { memo, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { FileMeta, ID } from "@slackoss/protocol";
import type { EphemeralMessage, PendingMessage } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { formatDay, sameDay } from "../lib/format.js";
import { MessageItem } from "./MessageItem.js";
import { ReplyQuote } from "./ReplyQuote.js";
import { Avatar } from "./Avatar.js";
import { ListStatus } from "./ListStatus.js";
import { Lightbox, PendingAttachments } from "./Attachments.js";
import { Mrkdwn } from "./Mrkdwn.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
import { Swap } from "./Motion.js";
import { useRovingMessages } from "../lib/useRovingMessages.js";
import {
  rememberReadingPosition,
  rememberedReadingPosition,
  type ReadingPosition,
} from "../lib/route.js";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

interface Anchor {
  id: string;
  /** Distance from the top of the viewport to the top of that row. */
  offset: number;
}

/** The first row reaching into the viewport, and where it currently sits. */
function topAnchor(el: HTMLElement): Anchor | null {
  for (const row of el.querySelectorAll<HTMLElement>("[data-mid]")) {
    if (row.offsetTop + row.offsetHeight > el.scrollTop) {
      return { id: row.dataset.mid!, offset: row.offsetTop - el.scrollTop };
    }
  }
  return null;
}

/** Puts that row back where it was, whatever changed around it. */
function restoreAnchor(el: HTMLElement, anchor: Anchor | null): void {
  if (!anchor) return;
  const row = el.querySelector<HTMLElement>(`[data-mid="${CSS.escape(anchor.id)}"]`);
  if (row) el.scrollTop = row.offsetTop - anchor.offset;
}

interface Props {
  channelId: ID;
  readActive?: boolean;
  /** When set, scroll to this message and flash it. */
  highlightMessageId?: ID | null;
  onOpenThread: (rootId: ID) => void;
  onChannelClick: (id: ID) => void;
  onOpenProfile: (userId: ID) => void;
  /** First steps an empty channel offers: bringing people in, describing it. */
  onInvite?: () => void;
  onDetails?: () => void;
}

export const MessageTimeline = memo(function MessageTimeline({
  channelId,
  readActive = true,
  highlightMessageId,
  onOpenThread,
  onChannelClick,
  onOpenProfile,
  onInvite,
  onDetails,
}: Props) {
  const client = useClient();
  const timeline = useWorkspace((s) => s.timelines[channelId]);
  const pending = useWorkspace((s) => s.pending);
  const ephemerals = useWorkspace((s) => s.ephemerals[channelId]);
  const droppedEphemerals = useWorkspace((s) => s.ephemeralsDropped[channelId] ?? 0);
  const typing = useWorkspace((s) => s.typing[channelId]);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const readBoundary = useRef({ channelId, seq: client.state.memberships[channelId] ?? 0 });
  if (readBoundary.current.channelId !== channelId)
    readBoundary.current = { channelId, seq: client.state.memberships[channelId] ?? 0 };
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const historyRequest = useRef<object | null>(null);
  const historyAnchor = useRef<{ ticket: object; anchor: Anchor } | null>(null);
  const [loadingHistory, setLoadingHistory] = useState<"initial" | "older" | "newer" | null>(null);
  const [historyError, setHistoryError] = useState<"initial" | "older" | "newer" | null>(null);
  const [lightboxFile, setLightboxFile] = useState<FileMeta | null>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  /** Suppresses paging while a jump's programmatic scroll settles. */
  const settlingJump = useRef(false);
  /**
   * Where Back, Forward or a reload says this conversation was being read,
   * waiting for its message to render before the view goes back there.
   */
  const pendingPosition = useRef<ReadingPosition | null>(null);
  /**
   * Renders again, so a position just read is put back once its message is
   * on screen. Setting the ref renders nothing, and the history request's
   * own state can end where it began within one render: a conversation held
   * here answers before React renders, and that render then commits nothing.
   */
  const [, lookForPosition] = useReducer((renders: number) => renders + 1, 0);
  /** Where this conversation is being read now, noted as the reader scrolls. */
  const reading = useRef<{ channelId: ID; position: ReadingPosition | null } | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteReading = (flush: boolean) => {
    if (noteTimer.current !== null) clearTimeout(noteTimer.current);
    noteTimer.current = null;
    const write = () => {
      noteTimer.current = null;
      const now = reading.current;
      if (now) rememberReadingPosition(client.baseUrl, now.channelId, now.position);
    };
    if (flush) write();
    else noteTimer.current = setTimeout(write, 200);
  };

  useEffect(() => {
    historyRequest.current = null;
    historyAnchor.current = null;
    setHistoryError(null);
    setLoadingHistory(null);
    // A jump anchors the view. Arriving by Back, Forward or a reload returns
    // to where the conversation was being read; anything else tails the newest.
    if (!highlightMessageId) {
      const position = rememberedReadingPosition(client.baseUrl, channelId);
      pendingPosition.current = position;
      pinnedToBottom.current = position === null;
      if (position) lookForPosition();
      void requestHistory("initial");
    } else {
      pendingPosition.current = null;
    }
    return () => {
      historyRequest.current = null;
    };
  }, [client, channelId, highlightMessageId]);

  const items = timeline?.items ?? [];
  const firstUnread = items.findIndex(
    (message) => message.seq > readBoundary.current.seq && message.userId !== selfId,
  );
  const channelPending = pending.filter((p) => p.channelId === channelId && !p.threadRootId);

  async function requestHistory(kind: "initial" | "older" | "newer") {
    if (historyRequest.current) return;
    const ticket = {};
    historyRequest.current = ticket;
    setLoadingHistory(kind);
    setHistoryError(null);
    const container = scroller.current;
    const anchor = kind === "older" && container ? topAnchor(container) : null;
    historyAnchor.current = anchor ? { ticket, anchor } : null;
    try {
      if (kind === "newer") await client.loadNewer(channelId);
      else await client.loadTimeline(channelId, { older: kind === "older" });
    } catch {
      if (historyRequest.current === ticket) setHistoryError(kind);
    } finally {
      requestAnimationFrame(() => {
        if (historyRequest.current === ticket) setLoadingHistory(null);
      });
    }
  }
  // Bring the jumped-to message into view once it has rendered.
  useEffect(() => {
    if (!highlightMessageId) return;
    pinnedToBottom.current = false;
    settlingJump.current = true;
    const frame = requestAnimationFrame(() => {
      highlightRef.current?.scrollIntoView({ block: "center" });
    });
    // scrollIntoView fires scroll events of its own; ignore them.
    const settle = setTimeout(() => {
      settlingJump.current = false;
      lastScrollTop.current = scroller.current?.scrollTop ?? 0;
    }, 500);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
  }, [highlightMessageId, items.length]);
  const typers = Object.keys(typing ?? {})
    .filter((id) => id !== selfId)
    .map((id) => users[id]?.displayName ?? "someone");

  // A message that comes in while the reader is at the newest rises into
  // place, and one of yours, already shown faded as it went, brightens. Not a
  // page of history, another conversation, or a crowd caught up at once.
  const arrived = useRef(new Set<ID>());
  const tail = useRef<{ channelId: ID; newest?: ID; live: boolean } | null>(null);
  const last = tail.current;
  if (last?.channelId !== channelId) arrived.current.clear();
  else if (last.live && last.newest) {
    const fresh = items.filter((message) => message.id > last.newest!);
    if (fresh.length <= 3) for (const message of fresh) arrived.current.add(message.id);
  }
  useLayoutEffect(() => {
    tail.current = {
      channelId,
      newest: items.at(-1)?.id,
      live: !!timeline?.loaded && !timeline.hasMoreNewer,
    };
  });

  // Sending brings you down to what you sent, as Discord and Slack do: a reply
  // to something far up would otherwise land out of sight, and stay unread.
  const sends = useRef(channelPending.length);
  useLayoutEffect(() => {
    if (channelPending.length > sends.current) pinnedToBottom.current = true;
    sends.current = channelPending.length;
  }, [channelPending.length]);

  // Keep the view pinned to the newest message unless the user scrolled up.
  // An anchored view must never be yanked to the bottom: that both loses the
  // jumped-to message and reads as a scroll-to-bottom, which pages forward.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !pinnedToBottom.current) return;
    if (highlightMessageId || timeline?.hasMoreNewer) return;
    el.scrollTop = el.scrollHeight;
  }, [
    items.length,
    items.at(-1)?.id,
    channelPending.length,
    typers.length,
    channelId,
    highlightMessageId,
    timeline?.hasMoreNewer,
  ]);

  // A new message is not the only thing that moves the bottom out of view.
  // Opening a side panel or resizing the window changes the scroller's size,
  // and messages rewrapping to the new width, or a reaction added to the last
  // one, change the size of what it holds. Neither runs the effect above, so a
  // reader at the bottom would find the newest message under the composer.
  const content = useRef<HTMLDivElement>(null);
  const roving = useRovingMessages(content);
  // Another conversation fades in rather than snapping, as Discord's does;
  // not for anyone who asked for less motion.
  const shownChannel = useRef(channelId);
  useEffect(() => {
    if (shownChannel.current === channelId) return;
    shownChannel.current = channelId;
    const el = content.current;
    if (!el || typeof el.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
  }, [channelId]);
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!pinnedToBottom.current || highlightMessageId || timeline?.hasMoreNewer) return;
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [highlightMessageId, timeline?.hasMoreNewer]);

  // Live messages arriving in a long-running channel eventually trim the oldest
  // ones off the top. That removes content above the viewport, which would
  // slide everything up by exactly the height that vanished. Give it back.
  const lastFirstId = useRef<ID | null>(null);
  const lastChannel = useRef<ID | null>(null);
  const lastScrollHeight = useRef(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const firstId = items[0]?.id ?? null;
    // Message ids sort lexicographically, so a *later* first id means the top
    // was trimmed, while an earlier one means older messages were prepended.
    // Comparing across a channel switch would be meaningless.
    const trimmedTop =
      lastChannel.current === channelId &&
      lastFirstId.current !== null &&
      firstId !== null &&
      firstId > lastFirstId.current;
    if (trimmedTop && !pinnedToBottom.current && loadingHistory !== "older") {
      el.scrollTop -= lastScrollHeight.current - el.scrollHeight;
    }
    lastFirstId.current = firstId;
    lastChannel.current = channelId;
    lastScrollHeight.current = el.scrollHeight;
  });

  // Restore after React commits both the rows and the loading indicator. Doing
  // this before removing the indicator shifts the reader by its height.
  useLayoutEffect(() => {
    const saved = historyAnchor.current;
    if (saved && saved.ticket === historyRequest.current && scroller.current)
      restoreAnchor(scroller.current, saved.anchor);
    if (loadingHistory === null) {
      historyAnchor.current = null;
      historyRequest.current = null;
    }
  });

  // The scroller is reused across channels, so its position carries over.
  useEffect(() => {
    lastScrollTop.current = scroller.current?.scrollTop ?? 0;
  }, [channelId]);

  // Put the reader back where this entry says, once that message is on
  // screen. If the conversation has loaded without it, read from the newest.
  useLayoutEffect(() => {
    const position = pendingPosition.current;
    const el = scroller.current;
    if (!position || !el) return;
    if (el.querySelector(`[data-mid="${CSS.escape(position.messageId)}"]`)) {
      pendingPosition.current = null;
      restoreAnchor(el, { id: position.messageId, offset: position.offset });
      pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      lastScrollTop.current = el.scrollTop;
      return;
    }
    if (timeline?.loaded && loadingHistory === null) {
      pendingPosition.current = null;
      pinnedToBottom.current = true;
      el.scrollTop = el.scrollHeight;
    }
  });

  // What was noted last is written before leaving the conversation, or the page.
  useEffect(() => {
    const flush = () => noteReading(true);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [client, channelId]);

  function readVisibleTail() {
    if (
      !readActive ||
      !timeline?.loaded ||
      timeline.hasMoreNewer ||
      !pinnedToBottom.current ||
      !document.hasFocus() ||
      document.visibilityState !== "visible"
    )
      return;
    client.markRead(channelId, timeline.readThroughSeq ?? items.at(-1)?.seq ?? 0);
  }

  // Do not acknowledge a newer socket watermark until its history is on screen.
  useEffect(() => {
    readVisibleTail();
    window.addEventListener("focus", readVisibleTail);
    document.addEventListener("visibilitychange", readVisibleTail);
    return () => {
      window.removeEventListener("focus", readVisibleTail);
      document.removeEventListener("visibilitychange", readVisibleTail);
    };
  }, [
    client,
    channelId,
    items.length,
    items.at(-1)?.id,
    timeline?.hasMoreNewer,
    timeline?.loaded,
    timeline?.readThroughSeq,
    readActive,
  ]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    readVisibleTail();
    // Not while a position waits to be put back: that would overwrite it.
    if (!pendingPosition.current) {
      const anchor = pinnedToBottom.current ? null : topAnchor(el);
      reading.current = {
        channelId,
        position: anchor ? { messageId: anchor.id, offset: anchor.offset } : null,
      };
      noteReading(false);
    }

    // Page forward only when the user actively scrolls down to the bottom of
    // an anchored view — otherwise a window shorter than the viewport would
    // cascade through every page back to the tail on its own.
    const scrolledDown = el.scrollTop > lastScrollTop.current + 1;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    lastScrollTop.current = el.scrollTop;
    if (
      scrolledDown &&
      atBottom &&
      !settlingJump.current &&
      timeline?.hasMoreNewer &&
      !historyRequest.current &&
      !historyError
    ) {
      void requestHistory("newer");
    }

    if (el.scrollTop < 400 && timeline?.hasMore && !historyRequest.current && !historyError) {
      void requestHistory("older");
    }
  }

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      aria-label="Message history"
      className="timeline-scroll flex min-h-0 flex-1 flex-col overflow-y-auto pb-3"
      aria-busy={loadingHistory !== null}
    >
      {/* A short conversation sits on the composer, as in any chat, rather than
          at the top with an empty page between it and where you write. */}
      <div
        ref={content}
        onFocus={roving.onFocus}
        onKeyDown={roving.onKeyDown}
        className="mt-auto shrink-0"
      >
        <ListStatus
          className="px-4"
          // A cached conversation refreshing on open says nothing; paging
          // through history, or a conversation not seen yet, does.
          loading={
            (loadingHistory !== null && loadingHistory !== "initial") ||
            (!timeline?.loaded && !historyError)
          }
          placeholder={!timeline?.loaded}
          loadingLabel={
            timeline?.loaded ? `Loading ${loadingHistory} messages…` : "Loading conversation…"
          }
          error={
            historyError
              ? `Could not load ${historyError === "initial" ? "this conversation" : `${historyError} messages`}.`
              : null
          }
          onRetry={() => {
            if (historyError) void requestHistory(historyError);
          }}
        />
        {timeline?.hasMore && (
          <button
            className="mx-auto my-2 block rounded-full border border-edge px-3 py-1 text-[12px] font-medium text-ink-dim transition-colors hover:bg-ink/[0.04] hover:text-ink disabled:opacity-40"
            disabled={loadingHistory !== null}
            onClick={() => void requestHistory("older")}
          >
            Load older messages
          </button>
        )}
        {!timeline?.hasMore && timeline?.loaded && (
          <ChannelIntro
            channelId={channelId}
            empty={items.length === 0}
            onInvite={onInvite}
            onDetails={onDetails}
          />
        )}
        {items.map((msg, i) => {
          const prev = items[i - 1];
          const newDay = !prev || !sameDay(prev.createdAt, msg.createdAt);
          const compact =
            !newDay &&
            !!prev &&
            prev.userId === msg.userId &&
            msg.createdAt - prev.createdAt < GROUP_WINDOW_MS &&
            prev.replyCount === 0 &&
            // A reply shows what it answers above its author, as Discord does.
            !msg.replyTo;
          return (
            <div
              key={msg.id}
              data-mid={msg.id}
              ref={msg.id === highlightMessageId ? highlightRef : undefined}
              className={
                arrived.current.has(msg.id)
                  ? msg.userId === selfId
                    ? "animate-sent"
                    : "animate-message-in"
                  : undefined
              }
            >
              {newDay && <DayDivider ts={msg.createdAt} />}
              {i === firstUnread && (
                <div
                  role="separator"
                  aria-label="New messages"
                  className="relative my-2 flex items-center gap-1 pl-4 pr-3.5"
                >
                  {/* Discord's red rule, with its tag at the end of the line. */}
                  <span className="h-px flex-1 bg-[var(--mention-red)]" />
                  <span className="badge-mention rounded-md px-1.5 text-[10px] font-bold uppercase leading-4 tracking-wide">
                    New
                  </span>
                </div>
              )}
              <MessageItem
                message={msg}
                compact={compact}
                onOpenThread={onOpenThread}
                onChannelClick={onChannelClick}
                onOpenImage={setLightboxFile}
                onOpenProfile={onOpenProfile}
                highlighted={msg.id === highlightMessageId}
              />
            </div>
          );
        })}
        {timeline?.hasMoreNewer && (
          <button
            className="mx-auto my-2 block rounded-full border border-edge px-3 py-1 text-[12px] font-medium text-ink-dim transition-colors hover:bg-ink/[0.04] hover:text-ink disabled:opacity-40"
            disabled={loadingHistory !== null}
            onClick={() => void requestHistory("newer")}
          >
            Load newer messages
          </button>
        )}
        {channelPending.map((p) => (
          <PendingRow key={p.nonce} pending={p} />
        ))}
        {droppedEphemerals > 0 && (
          <DroppedEphemeralsNotice channelId={channelId} count={droppedEphemerals} />
        )}
        {(ephemerals ?? []).map((e) => (
          <EphemeralRow key={e.id} message={e} channelId={channelId} />
        ))}
        <div className="flex h-6 items-center px-5 pt-1 text-[12px] text-ink-faint">
          {/* Who is typing changes in place, rising out of a blur. */}
          <Swap on={typers.join()} text className="flex items-center gap-2">
            {typers.length > 0 && (
              <>
                <span aria-hidden="true" className="typing-dots inline-flex items-end">
                  <span />
                  <span />
                  <span />
                </span>
                <span>
                  <span className="font-medium text-ink-dim">{typers.slice(0, 3).join(", ")}</span>{" "}
                  {typers.length === 1 ? "is" : "are"} typing…
                </span>
              </>
            )}
          </Swap>
        </div>
      </div>
      {lightboxFile && <Lightbox file={lightboxFile} onClose={() => setLightboxFile(null)} />}
    </div>
  );
});

/**
 * A slash command's private answer. Marked plainly as unshared, because the
 * worst thing this could do is let someone think the channel saw it.
 */
function EphemeralRow({ message, channelId }: { message: EphemeralMessage; channelId: ID }) {
  const client = useClient();
  const author = useWorkspace((s) => s.users[message.userId]);
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  return (
    <div className="group flex gap-4 py-1.5 pl-4 pr-12">
      <div className="w-10 shrink-0" />
      <div className="min-w-0 flex-1 rounded-lg border border-dashed border-edge bg-raised/60 px-3 py-2">
        <div className="mb-0.5 flex items-center gap-2">
          {author && <span className="text-[13px] font-semibold">{author.displayName}</span>}
          <span className="text-[12px] text-ink-faint">Only visible to you</span>
          <Tooltip label="Dismiss">
            <button
              onClick={() => client.dismissEphemeral(channelId, message.id)}
              className="ml-auto rounded p-1 text-ink-faint opacity-0 transition-opacity hover:bg-ink/[0.05] hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
              aria-label="Dismiss"
            >
              <Icon name="close" size={14} />
            </button>
          </Tooltip>
        </div>
        <div className="text-[15px] leading-relaxed text-ink-dim">
          <Mrkdwn text={message.text} users={users} channels={channels} />
        </div>
      </div>
    </div>
  );
}

/**
 * Says that older private answers here were cleared to stay within what the
 * app keeps (REV-04). Nothing of what they said is kept to show.
 */
function DroppedEphemeralsNotice({ channelId, count }: { channelId: ID; count: number }) {
  const client = useClient();
  return (
    <div className="flex gap-4 py-1 pl-4 pr-12">
      <div className="w-10 shrink-0" />
      <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-[13px] text-ink-faint">
        <span className="font-medium">Only visible to you</span>
        <span>
          {count === 1
            ? "1 older private answer here was cleared to make room."
            : `${count} older private answers here were cleared to make room.`}
        </span>
        <button
          onClick={() => client.dismissDroppedEphemerals(channelId)}
          className="ml-auto rounded px-2 py-0.5 text-xs text-copper hover:bg-ink/[0.05]"
          aria-label="Dismiss note about cleared answers"
        >
          Dismiss
        </button>
      </p>
    </div>
  );
}

/** Shown while the view is parked mid-history after a jump. */
export function JumpToLatestBar({ channelId, onJump }: { channelId: ID; onJump?: () => void }) {
  const client = useClient();
  const anchored = useWorkspace((s) => s.timelines[channelId]?.hasMoreNewer ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef<object | null>(null);
  useEffect(() => {
    request.current = null;
    setBusy(false);
    setError(false);
    return () => {
      request.current = null;
    };
  }, [channelId]);
  async function jump() {
    if (request.current) return;
    const ticket = {};
    request.current = ticket;
    setBusy(true);
    setError(false);
    onJump?.();
    try {
      await client.jumpToLatest(channelId);
    } catch {
      if (request.current === ticket) setError(true);
    } finally {
      if (request.current === ticket) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  if (!anchored) return null;
  return (
    <div className="flex flex-col items-center gap-1 px-5 pb-1">
      {error && (
        <p role="alert" className="text-xs text-ink-dim">
          Could not load the latest messages. Your current history is kept.
        </p>
      )}
      <button
        disabled={busy}
        onClick={() => void jump()}
        className="rounded-full border border-copper/50 bg-copper/15 px-3 py-1 text-[12px] font-medium text-copper transition-colors hover:bg-copper/25"
      >
        {busy ? (
          "Loading latest messages…"
        ) : (
          <>
            {error ? "Retry jump to latest" : "You're viewing older messages · Jump to latest"}
            <Icon
              name="arrow"
              size={14}
              style={{ transform: "rotate(90deg)" }}
              className="ml-1 inline"
            />
          </>
        )}
      </button>
    </div>
  );
}

function DayDivider({ ts }: { ts: number }) {
  return (
    <div className="relative my-4 flex items-center gap-2 px-4" role="separator">
      <div className="h-px flex-1 bg-edge" />
      <span className="text-[12px] font-semibold text-ink-faint">{formatDay(ts)}</span>
      <div className="h-px flex-1 bg-edge" />
    </div>
  );
}

/**
 * How a conversation begins: what it is, and — while it has nothing in it
 * yet — the first useful things to do there, rather than an empty page.
 */
function ChannelIntro({
  channelId,
  empty,
  onInvite,
  onDetails,
}: {
  channelId: ID;
  empty: boolean;
  onInvite?: () => void;
  onDetails?: () => void;
}) {
  const channel = useWorkspace((s) => s.channels[channelId]);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  if (!channel) return null;
  const isRoom = channel.type === "public" || channel.type === "private";
  const others = (channel.memberIds ?? []).filter((id) => id !== selfId);
  const name = isRoom
    ? `#${channel.name}`
    : others.map((id) => users[id]?.displayName ?? "unknown").join(", ") || "Just you";
  const person = !isRoom && others.length === 1 ? users[others[0]!] : undefined;
  return (
    <div className="animate-message-in px-4 pb-2 pt-8">
      <div className="mb-3 flex items-center gap-3">
        {person ? (
          <Avatar user={person} size={68} />
        ) : (
          <span className="intro-tile flex size-[68px] items-center justify-center rounded-2xl">
            <Icon
              name={isRoom ? (channel.type === "private" ? "lock" : "hash") : "friends"}
              size={36}
            />
          </span>
        )}
      </div>
      <h2 className="text-3xl font-bold tracking-tight">{name}</h2>
      <p className="mt-1.5 max-w-xl text-[16px] leading-relaxed text-ink-dim">
        {/* One highlight phrase, as chaicode.com writes a paragraph. */}
        {isRoom ? (
          channel.description || (
            <>
              This is the very beginning of <span className="highlight">#{channel.name}</span>.
              {/* Asked of an empty channel only: once people have written, it is going. */}
              {empty && " Say something to get it going."}
            </>
          )
        ) : person ? (
          <>
            <span className="highlight">Your direct messages</span> start here.
          </>
        ) : (
          "This conversation is just between you. It starts here."
        )}
      </p>
      {empty && isRoom && (onInvite || onDetails) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {onInvite && (
            <button
              onClick={onInvite}
              className="flex h-8 items-center gap-2 rounded-full border border-edge px-3 text-[13px] font-medium text-ink-dim transition-colors hover:bg-ink/[0.04] hover:text-ink"
            >
              <Icon name="userPlus" size={14} />
              Invite people
            </button>
          )}
          {onDetails && !channel.description && (
            <button
              onClick={onDetails}
              className="flex h-8 items-center gap-2 rounded-full border border-edge px-3 text-[13px] font-medium text-ink-dim transition-colors hover:bg-ink/[0.04] hover:text-ink"
            >
              <Icon name="edit" size={14} />
              Add a description
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PendingRow({ pending }: { pending: PendingMessage }) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  return (
    <div className="animate-message-in py-0.5 pl-5 pr-12 opacity-60">
      {pending.replyTo && <ReplyQuote quote={pending.replyTo} users={users} channels={channels} />}
      <div className="flex gap-3.5">
        <div className="w-10 shrink-0" />
        <div className="min-w-0 flex-1 text-[15px]">
          {pending.text && <Mrkdwn text={pending.text} users={users} channels={channels} />}
          <PendingAttachments attachments={pending.attachments} progress={pending.uploadProgress} />
          {pending.failed ? (
            <span className="ml-2 text-[12px] text-alert">
              {pending.failureReason ?? "Not sent."}{" "}
              <button className="underline" onClick={() => client.retrySend(pending.nonce)}>
                Retry
              </button>{" "}
              ·{" "}
              <button className="underline" onClick={() => client.discardSend(pending.nonce)}>
                Discard
              </button>
            </span>
          ) : (
            <span className="ml-2 text-[12px] text-ink-faint">Sending…</span>
          )}
        </div>
      </div>
    </div>
  );
}
