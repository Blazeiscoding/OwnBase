import { useContext } from "react";
import type { Channel, FileMeta, ForwardReference, ID, User } from "@ownbase/protocol";
import { OpenMessageContext } from "../context.js";
import { channelTitle, formatFull, formatTime } from "../lib/format.js";
import { MessageAttachments } from "./Attachments.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";
import { Mrkdwn } from "./Mrkdwn.js";

/** A conversation as a forward names it: #name for a channel, the people for a DM. */
export function conversationName(
  channel: Channel,
  users: Record<ID, User>,
  selfId: ID | undefined,
): string {
  const title = channelTitle(channel, users, selfId);
  return channel.type === "public" || channel.type === "private" ? `#${title}` : title;
}

/**
 * The message a forward passes on, under its own words (E1): who wrote it,
 * when, what it said and its files, with a link to it where the reader can
 * open its conversation. A hidden one, from a private conversation, says only
 * that; a deleted one says so.
 */
export function ForwardCard(props: {
  forward: ForwardReference;
  users: Record<ID, User>;
  channels: Record<ID, Channel>;
  selfId: ID | undefined;
  onOpenImage?: (file: FileMeta) => void;
  onChannelClick?: (id: ID) => void;
  /** Offers View original; a preview, which would open it behind its dialog, does not. */
  linked?: boolean;
}) {
  const { forward, users, channels, selfId } = props;
  const openMessage = useContext(OpenMessageContext);
  // Known here only to someone who can read it there.
  const where = channels[forward.channelId];
  const author = users[forward.userId];
  const from = where ? conversationName(where, users, selfId) : null;
  return (
    <div className="mt-1.5 max-w-xl rounded-lg border border-edge border-l-2 border-l-ink-faint bg-ink/[0.025] px-3 py-2">
      <p className="flex items-center gap-1.5 text-xs text-ink-faint">
        <Icon name="forward" size={12} />
        {forward.hidden
          ? "Forwarded from a private conversation"
          : from
            ? `Forwarded from ${from}`
            : "Forwarded"}
      </p>
      {forward.deleted ? (
        <p className="mt-1 text-sm italic text-ink-dim">The original message was deleted.</p>
      ) : forward.hidden ? (
        <p className="mt-1 text-sm text-ink-dim">
          {where
            ? "Only people in that conversation see what it says."
            : "Only people in that conversation can see it."}
        </p>
      ) : (
        <>
          <div className="mt-1 flex items-center gap-2">
            <Avatar user={author} size={20} />
            <span className="text-sm font-semibold text-ink">
              {author?.displayName ?? "Someone"}
            </span>
            <time
              dateTime={new Date(forward.createdAt).toISOString()}
              title={formatFull(forward.createdAt)}
              className="text-xs text-ink-faint"
            >
              {formatTime(forward.createdAt)}
            </time>
          </div>
          {forward.text && (
            <div className="message-text mt-0.5 text-[15px] leading-[1.375] text-ink/90">
              <Mrkdwn
                text={forward.text}
                users={users}
                channels={channels}
                selfId={selfId}
                onChannelClick={props.onChannelClick}
              />
            </div>
          )}
          <MessageAttachments files={forward.files} onOpenImage={(f) => props.onOpenImage?.(f)} />
        </>
      )}
      {props.linked !== false && where && openMessage && !forward.deleted && (
        <button
          type="button"
          onClick={() => openMessage(forward.channelId, forward.id)}
          className="mt-1 text-xs font-medium text-ink-dim hover:text-ink hover:underline"
        >
          View original
        </button>
      )}
    </div>
  );
}
