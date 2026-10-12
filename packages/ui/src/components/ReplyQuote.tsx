import {
  broadcastLabel,
  type Channel,
  type ID,
  type ReplyReference,
  type User,
} from "@slackoss/protocol";
import { channelMentionLabel, userMentionLabel } from "../lib/mentionDocument.js";
import { Avatar } from "./Avatar.js";
import { Icon } from "./Icon.js";

/**
 * A quoted message's words on one line: names for mentions, labels for links,
 * and none of the formatting marks, which one short line cannot show.
 */
export function quoteLine(
  text: string,
  users: Record<ID, User>,
  channels: Record<ID, Channel>,
): string {
  return text
    .replaceAll(/<@([A-Za-z0-9_-]+)>/g, (_all, id: ID) => userMentionLabel(users[id]))
    .replaceAll(/<#([A-Za-z0-9_-]+)>/g, (_all, id: ID) => channelMentionLabel(channels[id]))
    .replaceAll(/<!(channel|here|everyone)>/g, (_all, who: string) => broadcastLabel(who))
    .replaceAll(
      /<(https?:\/\/[^\s|<>]+)(?:\|([^<>\n]+))?>/g,
      (_all, url: string, label?: string) => label?.trim() || url,
    )
    .replaceAll("```", " ")
    .replaceAll(/(^|[\s(])([*_~`])(?=\S)(.+?)(?<=\S)\2(?=$|[\s.,:;!?)])/g, "$1$3")
    .replaceAll(/\s+/g, " ")
    .trim();
}

interface Props {
  quote: ReplyReference;
  users: Record<ID, User>;
  channels: Record<ID, Channel>;
  /** Shows the original; without it the quote is only read, as on a send still going. */
  onOpen?: (byKeyboard: boolean) => void;
  /** For a row with no avatar beside it: an arrow in place of the line from one. */
  bare?: boolean;
}

/**
 * What a reply answers, above it, as Discord draws it: a line curling up from
 * the avatar to the original's author and how it began.
 */
export function ReplyQuote({ quote, users, channels, onOpen, bare }: Props) {
  const author = users[quote.userId];
  const name = author?.displayName ?? "unknown";
  const words = quote.deleted ? "" : quoteLine(quote.text, users, channels);
  const files = quote.fileCount === 1 ? "Sent a file" : `Sent ${quote.fileCount} files`;
  const content = quote.deleted ? (
    <span className="italic text-ink-faint">The original message was deleted</span>
  ) : (
    <>
      <Avatar user={author} size={16} />
      <span className="shrink-0 font-medium text-ink-dim">
        <span className="sr-only">Replying to </span>@{name}
      </span>
      {words ? (
        <span className="min-w-0 truncate text-ink-faint">{words}</span>
      ) : quote.fileCount > 0 ? (
        <span className="flex min-w-0 items-center gap-1 italic text-ink-faint">
          {files}
          <Icon name="attach" size={12} />
        </span>
      ) : null}
    </>
  );
  return (
    <div
      className={`reply-quote relative flex h-5 min-w-0 items-center gap-1 text-[13px] leading-5 ${bare ? "" : "pl-14"}`}
    >
      {bare ? (
        <Icon name="reply" size={13} className="shrink-0 text-ink-faint" />
      ) : (
        <span
          aria-hidden="true"
          className="absolute bottom-[-4px] left-[19px] top-2.5 w-[31px] rounded-tl-md border-l-2 border-t-2 border-ink-faint/35"
        />
      )}
      {onOpen && !quote.deleted ? (
        <button
          type="button"
          onClick={(event) => onOpen(event.detail === 0)}
          className="flex min-w-0 items-center gap-1 text-left hover:[&>span]:text-ink"
        >
          {content}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-1">{content}</span>
      )}
    </div>
  );
}
