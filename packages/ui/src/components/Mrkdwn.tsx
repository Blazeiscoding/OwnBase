import { Fragment, useContext, useMemo, type ReactNode } from "react";
import { broadcastLabel, type ID, type User } from "@ownbase/protocol";
import type { Channel, CustomEmoji, UserGroup } from "@ownbase/protocol";
import { OpenMessageContext } from "../context.js";
import { CustomEmojiImage, customEmojiFor, useCustomEmoji } from "./CustomEmoji.js";
import { GroupMention } from "./GroupMention.js";
import { codeLanguage, useHighlighter } from "../lib/codeColours.js";
import { parseDeepLink } from "../lib/deeplink.js";
import { channelMentionLabel, userMentionLabel } from "../lib/mentionDocument.js";
import { useOwnAddress } from "./ShareableServer.js";
import { useUserGroups } from "../lib/userGroups.js";

interface Props {
  text: string;
  users: Record<ID, User>;
  channels: Record<ID, Channel>;
  selfId?: ID;
  onChannelClick?: (id: ID) => void;
  highlightTerms?: readonly string[];
  /**
   * Colour code blocks that name their language: the timeline and the thread
   * panel ask. Lists of matches, saved and pinned messages stay plain.
   */
  codeColours?: boolean;
}

/**
 * Renders Slack-mrkdwn-compatible message text:
 * ```blocks```, `code`, *bold*, _italic_, ~strike~, <@USER>, <#CHANNEL>, URLs,
 * <https://url|labelled links>, > quoted lines, and lists: lines starting
 * "- ", "* " or "• ", or "1. " or "1) ", as Discord reads them. `:name:`
 * draws the workspace's custom emoji of that name and stays text otherwise.
 * `<!subteam^ID|@handle>` draws a user group (J13).
 */
export function Mrkdwn({
  text,
  users,
  channels,
  selfId,
  onChannelClick,
  highlightTerms = [],
  codeColours,
}: Props) {
  const openMessage = useContext(OpenMessageContext);
  const ours = useOwnAddress();
  const customEmoji = useCustomEmoji();
  const groups = useUserGroups();
  const blocks = text.split(/```/);
  const terms = [...new Set(highlightTerms.filter((term) => term.trim().length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  const pattern = terms.length
    ? new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu")
    : null;
  const highlight = (value: string): ReactNode => {
    if (!pattern) return value;
    const parts: ReactNode[] = [];
    let previous = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index > previous) parts.push(value.slice(previous, match.index));
      parts.push(
        <mark key={match.index} className="rounded bg-copper/25 text-ink">
          {match[0]}
        </mark>,
      );
      previous = match.index + match[0].length;
    }
    if (previous < value.length) parts.push(value.slice(previous));
    return parts;
  };
  return (
    <span className="whitespace-pre-wrap break-words leading-[1.45]">
      {blocks.map((block, i) =>
        i % 2 === 1 ? (
          <CodeBlock
            key={i}
            block={block}
            colours={codeColours && !pattern}
            highlight={highlight}
          />
        ) : (
          <Fragment key={i}>
            {lineRuns(trimAtFences(block, i > 0, i < blocks.length - 1)).map((run, j) => {
              const inline = (value: string) =>
                renderInline(value, {
                  users,
                  channels,
                  selfId,
                  onChannelClick,
                  openMessage,
                  ours,
                  highlight,
                  customEmoji,
                  groups,
                });
              switch (run.kind) {
                case "quote":
                  return (
                    <blockquote
                      key={j}
                      dir="auto"
                      className="my-0.5 block border-s-2 border-edge ps-2 text-ink-dim"
                    >
                      {inline(run.text)}
                    </blockquote>
                  );
                case "bullets":
                  return (
                    <ul
                      key={j}
                      dir="auto"
                      className="my-0.5 block list-disc ps-5 marker:text-ink-dim"
                    >
                      {run.items.map((item, k) => (
                        <li key={k}>{inline(item)}</li>
                      ))}
                    </ul>
                  );
                case "numbers":
                  return (
                    <ol
                      key={j}
                      start={run.start === 1 ? undefined : run.start}
                      dir="auto"
                      className="my-0.5 block list-decimal ps-6 marker:text-ink-dim"
                    >
                      {run.items.map((item, k) => (
                        <li key={k}>{inline(item)}</li>
                      ))}
                    </ol>
                  );
                default:
                  return <Fragment key={j}>{inline(run.text)}</Fragment>;
              }
            })}
          </Fragment>
        ),
      )}
    </span>
  );
}

/**
 * A fenced block. A language word alone on the fence line, as Markdown writes
 * one, names its language and is not drawn. Where colours are asked for, the
 * block draws plain at once and takes them when the highlighter arrives; only
 * the colours change, so the timeline does not move.
 */
function CodeBlock({
  block,
  colours,
  highlight,
}: {
  block: string;
  colours?: boolean;
  highlight: (value: string) => ReactNode;
}) {
  const parsed = codeLanguage(block);
  const code = trimAtFences(parsed?.code ?? block, !parsed, true);
  const language = colours && parsed?.language;
  const highlighter = useHighlighter(!!language);
  const runs = useMemo(
    () => language && highlighter?.(code, language),
    [highlighter, code, language],
  );
  return (
    <code
      dir="ltr"
      className="my-1 block overflow-x-auto rounded-lg border border-edge bg-ground px-3 py-2 font-mono text-[13px]"
    >
      {runs
        ? runs.map(([text, className], i) =>
            className ? (
              <span key={i} className={className}>
                {text}
              </span>
            ) : (
              text
            ),
          )
        : highlight(code)}
    </code>
  );
}

/**
 * A code block is a block of its own, so the line break people type against a
 * fence, just inside or just outside it, would otherwise draw a blank line.
 */
function trimAtFences(text: string, afterFence: boolean, beforeFence: boolean): string {
  let trimmed = text;
  if (afterFence && trimmed.startsWith("\n")) trimmed = trimmed.slice(1);
  if (beforeFence && trimmed.endsWith("\n")) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

type LineRun =
  | { kind: "text" | "quote"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "numbers"; start: number; items: string[] };

/** A bulleted item: "- ", "* " or "• ", then something. "-5 degrees" and "*bold*" are not. */
const BULLET = /^[-*\u2022][ \t]+(?=\S)/;
/** A numbered item: up to three digits, then ". " or ") ". More would be a year: "2024. What a year". */
const NUMBERED = /^(\d{1,3})[.)][ \t]+(?=\S)/;

/**
 * Splits text into runs of quoted lines (`> said this`, as Slack writes them),
 * of list items, and of the lines between. Quotes and lists are blocks of
 * their own, so the line breaks at their edges are dropped with the markers
 * rather than drawn as blank lines. A numbered list counts on from its first
 * number, whatever the later ones say, as Discord's does.
 */
function lineRuns(text: string): LineRun[] {
  const runs: LineRun[] = [];
  for (const line of text.split("\n")) {
    const last = runs.at(-1);
    const quoted = /^>\s?/.exec(line);
    const bullet = quoted ? null : BULLET.exec(line);
    const numbered = quoted || bullet ? null : NUMBERED.exec(line);
    if (bullet) {
      const item = line.slice(bullet[0].length);
      if (last?.kind === "bullets") last.items.push(item);
      else runs.push({ kind: "bullets", items: [item] });
    } else if (numbered) {
      const item = line.slice(numbered[0].length);
      if (last?.kind === "numbers") last.items.push(item);
      else runs.push({ kind: "numbers", start: Number(numbered[1]), items: [item] });
    } else {
      const kind = quoted ? "quote" : "text";
      const content = quoted ? line.slice(quoted[0].length) : line;
      if (last?.kind === kind) last.text += `\n${content}`;
      else runs.push({ kind, text: content });
    }
  }
  return runs;
}

/**
 * The host a link really goes to, when its label names a different one. A
 * label is the sender's to choose, and one reading like an address must not
 * stand in for where the link goes.
 */
function disguisedHost(url: string, label: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const named = /(?:[a-z0-9-]+\.)+[a-z]{2,}/i.exec(label)?.[0]?.toLowerCase();
  if (!named || named === host || host.endsWith(`.${named}`)) return null;
  return host;
}

// The escape alternative has to come first: it consumes "\_" before the italic
// rule can pair that underscore with a later one. Without it ¯\_(ツ)_/¯ arrives
// italicised and missing both underscores.
// A link in angle brackets, labelled or not, is Slack's own form, and the one
// apps send; only web addresses are made links. A custom emoji's `:name:` is
// not read against a letter, digit or colon, so 10:30:45 stays a time. A user
// group is Slack's `<!subteam^ID|@handle>`, its label optional (J13).
const INLINE_RE =
  /(\\[*_~`\\])|(`[^`\n]+`)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~[^~\n]+~)|(<@[A-Za-z0-9_-]+>)|(<#[A-Za-z0-9_-]+>)|(<!(?:channel|here|everyone)>)|(https?:\/\/[^\s<>]+)|<(https?:\/\/[^\s|<>]+)(?:\|([^<>\n]+))?>|(?<![A-Za-z0-9:])(:[a-z0-9_-]{1,32}:)(?![A-Za-z0-9])|(<!subteam\^([A-Za-z0-9_-]+)(?:\|([^<>\n]*))?>)/g;

function renderInline(
  text: string,
  ctx: Pick<Props, "users" | "channels" | "selfId" | "onChannelClick"> & {
    openMessage?: ((channelId: ID, messageId: ID) => void) | null;
    /** Whether an address is this workspace's; only its links open here. */
    ours?: (serverUrl: string) => boolean;
    highlight: (value: string) => ReactNode;
    customEmoji: Record<string, CustomEmoji>;
    groups: Record<ID, UserGroup>;
  },
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(ctx.highlight(text.slice(last, m.index)));
    const tok = m[0];
    if (m[1]) {
      out.push(ctx.highlight(tok.slice(1)));
    } else if (m[2]) {
      out.push(
        <code
          key={key++}
          className="rounded border border-edge bg-ink/[0.05] px-1 py-px font-mono text-[13px] text-ink"
        >
          {ctx.highlight(tok.slice(1, -1))}
        </code>,
      );
    } else if (m[3]) {
      out.push(<strong key={key++}>{renderInline(tok.slice(1, -1), ctx)}</strong>);
    } else if (m[4]) {
      out.push(<em key={key++}>{renderInline(tok.slice(1, -1), ctx)}</em>);
    } else if (m[5]) {
      out.push(<s key={key++}>{renderInline(tok.slice(1, -1), ctx)}</s>);
    } else if (m[6]) {
      const id = tok.slice(2, -1);
      const user = ctx.users[id];
      const isMe = id === ctx.selfId;
      out.push(
        <span
          key={key++}
          // Addressed to you: a stronger fill, so the text turns to ink. The
          // accent on the accent at 30% is under 4.5:1.
          className={`rounded px-1 font-medium ${isMe ? "bg-copper/25 text-ink" : "bg-ink/[0.07] text-ink"}`}
        >
          {userMentionLabel(user)}
        </span>,
      );
    } else if (m[7]) {
      const id = tok.slice(2, -1);
      const ch = ctx.channels[id];
      out.push(
        <button
          key={key++}
          type="button"
          onClick={() => ctx.onChannelClick?.(id)}
          className="rounded bg-ink/[0.07] px-1 font-medium text-ink hover:underline"
        >
          {channelMentionLabel(ch)}
        </button>,
      );
    } else if (m[8]) {
      // A room-wide mention. Always styled as addressing you, because it is.
      out.push(
        <span
          key={key++}
          className="rounded bg-copper/25 px-1 font-medium text-ink"
          title={
            tok === "<!here>"
              ? "Everyone in this channel who is around now"
              : "Everyone in this channel"
          }
        >
          {broadcastLabel(tok.slice(2, -1))}
        </span>,
      );
    } else if (m[9] || m[10]) {
      const url = m[9] ?? m[10]!;
      const label = m[11]?.trim();
      out.push(renderLink(url, label && label !== url ? label : null, key++, ctx));
    } else if (m[12]) {
      const emoji = customEmojiFor(ctx.customEmoji, tok);
      out.push(emoji ? <CustomEmojiImage key={key++} emoji={emoji} /> : ctx.highlight(tok));
    } else if (m[13]) {
      const id = m[14]!;
      out.push(
        <GroupMention
          key={key++}
          group={Object.hasOwn(ctx.groups, id) ? ctx.groups[id] : undefined}
          label={m[15] ?? null}
          selfId={ctx.selfId}
        />,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(ctx.highlight(text.slice(last)));
  return out;
}

/**
 * A web link. One to a message in this workspace opens it here, instead of in
 * a new window of the app; a click asking for a new tab or window still gets
 * one. That includes a conversation this account cannot see, where opening it
 * here says why, rather than a new window (the desktop app's is a browser that
 * is not signed in) saying the same after it loads. Only a link to an address
 * this workspace is known by: another server can hold the same ids, as a
 * restored copy of this workspace does, and its link goes where it says. A
 * label shows in place of the address, which the link's title always names,
 * and a label that reads as another site's address has the real one beside it.
 */
function renderLink(
  url: string,
  label: string | null,
  key: number,
  ctx: Parameters<typeof renderInline>[1],
): ReactNode {
  const link = parseDeepLink(url);
  const { openMessage } = ctx;
  const openHere =
    openMessage && link?.kind === "message" && !!ctx.ours?.(link.serverUrl)
      ? (event: React.MouseEvent) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          openMessage(link.channelId, link.messageId);
        }
      : undefined;
  const realHost = label ? disguisedHost(url, label) : null;
  return (
    <Fragment key={key}>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={label ? url : undefined}
        onClick={openHere}
        className="text-copper underline decoration-copper/40 hover:decoration-copper"
      >
        {ctx.highlight(label ?? url)}
      </a>
      {realHost && <span className="text-ink-faint"> ({realHost})</span>}
    </Fragment>
  );
}
