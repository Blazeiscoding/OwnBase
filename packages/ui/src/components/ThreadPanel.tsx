import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileMeta, ID, ReplyReference } from "@slackoss/protocol";
import type { PollDraft } from "@slackoss/client-core";
import { useClient, useWorkspace } from "../context.js";
import { Composer } from "./Composer.js";
import { usePanelFocus } from "../lib/usePanelFocus.js";
import { useRovingMessages } from "../lib/useRovingMessages.js";
import { MessageItem } from "./MessageItem.js";
import { ReplyQuote } from "./ReplyQuote.js";
import { PendingPoll } from "./PollCard.js";
import { Lightbox, PendingAttachments } from "./Attachments.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
import { ListStatus } from "./ListStatus.js";
import type { ReadingPosition } from "../lib/route.js";
import { rememberThreadPosition, rememberedThreadPosition } from "../lib/threadPosition.js";
import { channelTitle } from "../lib/format.js";

interface Props {
  channelId: ID;
  rootId: ID;
  targetId?: ID;
  readActive?: boolean;
  onClose: () => void;
  onChannelClick: (id: ID) => void;
  onOpenProfile: (userId: ID) => void;
}

export function ThreadPanel({
  channelId,
  rootId,
  targetId,
  readActive = true,
  onClose,
  onChannelClick,
  onOpenProfile,
}: Props) {
  const client = useClient();
  // The reply box takes focus itself; the panel only hands it back on closing.
  const { panel } = usePanelFocus({ takeFocus: false });
  const page = useWorkspace((s) => s.threadPages[rootId]);
  const root = useWorkspace((s) =>
    s.threadPages[rootId]?.loaded
      ? s.threadPages[rootId]!.root
      : (s.timelines[channelId]?.items.find((m) => m.id === rootId) ?? null),
  );
  const replies = useWorkspace((s) => s.threads[rootId]);
  const follows = useWorkspace((s) => s.threadFollows[rootId]?.following ?? false);
  const muted = useWorkspace((s) => s.threadFollows[rootId]?.muted === true);
  const canMute = useWorkspace((s) => s.threadMutes);
  const pending = useWorkspace((s) => s.pending).filter((p) => p.threadRootId === rootId);
  // Where the thread is: a phone shows it over the conversation it came from.
  const where = useWorkspace((s) => {
    const channel = s.channels[channelId];
    if (!channel) return "";
    const title = channelTitle(channel, s.users, s.self?.id);
    return channel.type === "public" || channel.type === "private" ? `#${title}` : title;
  });
  const [lightboxFile, setLightboxFile] = useState<FileMeta | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // The root and its replies are one Tab stop, as the channel's messages are.
  const roving = useRovingMessages(scroller);
  const follow = useRef(!targetId);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const targetPositioned = useRef(false);
  /** Where this thread was left, waiting for its reply to render to go back there. */
  const restoring = useRef<ReadingPosition | null>(null);
  const readContext = useRef<string | null>(null);
  const contextKey = `${channelId}:${rootId}:${targetId ?? ""}`;

  function readVisibleReplies() {
    if (
      readContext.current !== contextKey ||
      !readActive ||
      !page?.loaded ||
      page.loading ||
      page.hasMoreNewer ||
      !follow.current ||
      !document.hasFocus() ||
      document.visibilityState !== "visible"
    )
      return;
    // Replies are read in their thread. The channel's own cursor stays where
    // its timeline left it, so a thread cannot acknowledge channel messages.
    client.markThreadRead(rootId);
  }

  useEffect(() => {
    readVisibleReplies();
    window.addEventListener("focus", readVisibleReplies);
    document.addEventListener("visibilitychange", readVisibleReplies);
    return () => {
      window.removeEventListener("focus", readVisibleReplies);
      document.removeEventListener("visibilitychange", readVisibleReplies);
    };
  }, [client, channelId, replies, page?.loaded, page?.loading, page?.hasMoreNewer, readActive]);

  function load(direction: "latest" | "older" | "newer") {
    const container = scroller.current;
    if (direction === "latest") {
      follow.current = true;
      anchor.current = null;
    } else if (container) {
      const visible = [...container.querySelectorAll<HTMLElement>("[data-reply]")].find(
        (el) => el.getBoundingClientRect().bottom > container.getBoundingClientRect().top,
      );
      if (visible)
        anchor.current = { id: visible.dataset.reply!, top: visible.getBoundingClientRect().top };
      follow.current = false;
    }
    void client.loadThread(rootId, channelId, direction);
  }

  /**
   * Notes where this thread is being read, so opening it again goes back
   * there (IMP-02): the reply at the top of the panel, or nothing at the
   * newest reply. Not while the panel is still finding its place.
   */
  function notePosition(container: HTMLElement) {
    if (restoring.current || !page?.loaded || page.loading) return;
    const top = container.getBoundingClientRect().top;
    const reply =
      follow.current && !page.hasMoreNewer
        ? undefined
        : [...container.querySelectorAll<HTMLElement>("[data-reply]")].find(
            (el) => el.getBoundingClientRect().bottom > top,
          );
    rememberThreadPosition(
      client.baseUrl,
      rootId,
      reply
        ? { messageId: reply.dataset.reply!, offset: reply.getBoundingClientRect().top - top }
        : null,
    );
  }

  useEffect(() => {
    // At the reply asked for; else back where it was left, its replies below
    // unread until they are scrolled to; else at its newest.
    const position = targetId ? null : rememberedThreadPosition(client.baseUrl, rootId);
    restoring.current = position;
    follow.current = !targetId && !position;
    client.focusThread(rootId);
    readContext.current = contextKey;
    targetPositioned.current = false;
    anchor.current = null;
    void client.loadThread(rootId, channelId, "latest", targetId ?? position?.messageId);
    return () => client.focusThread(null);
  }, [client, rootId, channelId, targetId]);

  useLayoutEffect(() => {
    const container = scroller.current;
    if (!container) return;
    if (targetId && !targetPositioned.current && page?.loaded && !page.loading) {
      const target = [...container.querySelectorAll<HTMLElement>("[data-reply]")].find(
        (el) => el.dataset.reply === targetId,
      );
      if (target) {
        container.scrollTop +=
          target.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          container.clientHeight / 2 +
          target.clientHeight / 2;
        targetPositioned.current = true;
        follow.current = false;
        return;
      }
    }
    if (restoring.current && page?.loaded && !page.loading) {
      const saved = restoring.current;
      restoring.current = null;
      const reply = [...container.querySelectorAll<HTMLElement>("[data-reply]")].find(
        (el) => el.dataset.reply === saved.messageId,
      );
      if (reply) {
        container.scrollTop +=
          reply.getBoundingClientRect().top - container.getBoundingClientRect().top - saved.offset;
        return;
      }
      // Deleted since: the newest replies, as the thread opens otherwise.
      follow.current = true;
    }
    if (anchor.current && !page?.loading) {
      const saved = anchor.current;
      const element = [...container.querySelectorAll<HTMLElement>("[data-reply]")].find(
        (el) => el.dataset.reply === saved.id,
      );
      if (element) container.scrollTop += element.getBoundingClientRect().top - saved.top;
      anchor.current = null;
    } else if (follow.current) container.scrollTop = container.scrollHeight;
  }, [replies, page?.loading, pending.length, targetId]);

  return (
    <aside
      ref={panel}
      aria-label="Thread"
      className="flex w-[380px] max-w-full shrink-0 flex-col border-l border-edge"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 pl-4 pr-2 shadow-[0_1px_0_var(--color-edge)]">
        <h2 className="flex min-w-0 flex-1 items-baseline gap-2 text-[15px] font-semibold">
          Thread{" "}
          {where && (
            <span className="truncate text-[13px] font-normal text-ink-faint">{where}</span>
          )}
        </h2>
        {root && (
          <Tooltip
            label={
              follows
                ? "Stop following: new replies stop appearing in Threads"
                : "Follow: new replies appear in Threads"
            }
            side="bottom"
          >
            <button
              onClick={() => client.setThreadFollow(rootId, !follows)}
              aria-pressed={follows}
              className={`mr-1 flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-colors ${
                follows
                  ? "border-transparent bg-ink/[0.07] text-ink-dim hover:text-ink"
                  : "border-edge text-ink-faint hover:bg-ink/[0.05] hover:text-ink"
              }`}
            >
              <Icon name={follows ? "bell" : "plus"} size={12} />
              {follows ? "Following" : "Follow"}
            </button>
          </Tooltip>
        )}
        {root && canMute && (
          <Tooltip
            label={
              muted
                ? "Muted: replies notify you only when they mention you"
                : "Mute: replies notify you only when they mention you, even after you reply"
            }
            side="bottom"
          >
            <button
              onClick={() => client.setThreadMute(rootId, !muted)}
              aria-label="Mute thread"
              aria-pressed={muted}
              className={`mr-1 flex size-7 items-center justify-center rounded-full transition-colors ${
                muted
                  ? "bg-ink/[0.07] text-ink"
                  : "text-ink-faint hover:bg-ink/[0.05] hover:text-ink"
              }`}
            >
              <Icon name="bellOff" size={14} />
            </button>
          </Tooltip>
        )}
        <button
          onClick={onClose}
          aria-label="Close thread"
          className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div
        ref={scroller}
        onFocus={roving.onFocus}
        onKeyDown={roving.onKeyDown}
        onScroll={() => {
          const el = scroller.current;
          if (el) {
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            notePosition(el);
          }
          readVisibleReplies();
        }}
        className="min-h-0 flex-1 overflow-y-auto py-2"
        aria-busy={page?.loading}
      >
        {root && (
          <MessageItem
            message={root}
            compact={false}
            inThread
            onChannelClick={onChannelClick}
            onOpenImage={setLightboxFile}
            onOpenProfile={onOpenProfile}
          />
        )}
        {(replies?.length ?? 0) > 0 && (
          <div className="my-2 flex items-center gap-2 px-5">
            <span className="text-[11px] font-medium text-ink-faint">
              {replies!.length}
              {root && root.replyCount > replies!.length ? ` of ${root.replyCount}` : ""}{" "}
              {root?.replyCount === 1 ? "reply" : "replies"}
            </span>
            <div className="h-px flex-1 bg-edge" />
          </div>
        )}
        <ListStatus
          className="px-5"
          loading={page?.loading}
          placeholder={!page?.loaded}
          loadingLabel="Loading replies…"
          error={page?.error}
          onRetry={() => load("latest")}
          empty={
            page?.loaded && !page.error
              ? !root
                ? "The original message was deleted."
                : !replies?.length
                  ? "No replies yet. Start the conversation."
                  : null
              : null
          }
        />
        {page?.hasMoreOlder && (
          <button
            className="mx-auto my-2 block rounded-full border border-edge px-3 py-1 text-[12px] font-medium text-ink-dim transition-colors hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50"
            disabled={page.loading}
            onClick={() => load("older")}
          >
            Load older replies
          </button>
        )}
        {(replies ?? []).map((msg, i) => {
          const prev = replies![i - 1];
          const compact =
            !!prev &&
            prev.userId === msg.userId &&
            msg.createdAt - prev.createdAt < 300_000 &&
            !msg.replyTo;
          return (
            <div key={msg.id} data-reply={msg.id}>
              <MessageItem
                message={msg}
                highlighted={msg.id === targetId}
                compact={compact}
                inThread
                onChannelClick={onChannelClick}
                onOpenImage={setLightboxFile}
                onOpenProfile={onOpenProfile}
              />
            </div>
          );
        })}
        {page?.hasMoreNewer && (
          <div className="flex justify-center gap-4 py-2 text-sm font-medium text-ink-dim">
            <button disabled={page.loading} onClick={() => load("newer")}>
              Load newer replies
            </button>
            <button disabled={page.loading} onClick={() => load("latest")}>
              Jump to latest
            </button>
          </div>
        )}
        {pending.map((p) => (
          <div key={p.nonce} className="px-5 py-1 text-[15px] opacity-60">
            {p.replyTo && <PendingQuote quote={p.replyTo} />}
            {p.poll ? <PendingThreadPoll text={p.text} poll={p.poll} /> : p.text}
            <PendingAttachments attachments={p.attachments} progress={p.uploadProgress} />
            <span className="ml-2 font-mono text-[11px] text-ink-faint">
              {p.failed ? (p.failureReason ?? "Could not send this reply.") : "sending…"}
            </span>
            {p.failed && (
              <div className="flex gap-3 text-xs font-medium text-ink-dim">
                <button onClick={() => client.retrySend(p.nonce)}>Retry</button>
                <button onClick={() => client.discardSend(p.nonce)}>Discard</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {root && (
        <Composer channelId={channelId} threadRootId={rootId} placeholder="Reply…" autoFocus />
      )}
      {lightboxFile && <Lightbox file={lightboxFile} onClose={() => setLightboxFile(null)} />}
    </aside>
  );
}

/** A poll still sending in a thread, its names from the replica. */
function PendingThreadPoll({ text, poll }: { text: string; poll: PollDraft }) {
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  return <PendingPoll text={text} poll={poll} users={users} channels={channels} />;
}

/** What a reply still sending answers, named from the replica. */
function PendingQuote({ quote }: { quote: ReplyReference }) {
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  return <ReplyQuote quote={quote} users={users} channels={channels} bare />;
}
