/**
 * Escapes text that must appear literally in a message rather than be read as
 * mrkdwn. Clients treat a backslash as "the next character is not a
 * delimiter", so anything that would otherwise open bold, italic, strike or
 * code has to be prefixed — the backslash itself included.
 *
 * The case that forced this into existence is /shrug: ¯\_(ツ)_/¯ contains a
 * backslash and two underscores, and unescaped it renders as an italic ¯(ツ)/¯
 * with the arms missing.
 */
export function escapeMrkdwn(text: string): string {
  return text.replaceAll(/[\\*_~`]/g, (c) => `\\${c}`);
}

/**
 * The mentions that address a room rather than a person. Slack encodes these
 * as `<!channel>` and `<!here>`, and existing integrations send them that way,
 * so the wire shape is theirs even though the meaning is ours to enforce.
 *
 * `everyone` is Slack's #general-only variant; it is accepted on the way in
 * and treated as `channel`, because a second word for the same reach is not
 * worth the confusion of having it mean something subtly different.
 */
export type Broadcast = "channel" | "here";

const BROADCAST_RE = /<!(channel|here|everyone)>/g;

/** Which room-wide mentions a message contains, if any. */
export function broadcastsIn(text: string): Set<Broadcast> {
  const found = new Set<Broadcast>();
  for (const m of text.matchAll(BROADCAST_RE)) {
    found.add(m[1] === "here" ? "here" : "channel");
  }
  return found;
}

/** How a broadcast token reads to a person: `<!here>` becomes `@here`. */
export function broadcastLabel(token: string): string {
  return `@${token === "everyone" ? "channel" : token}`;
}

/** The most of an original's words a reply carries to show above itself. */
export const REPLY_EXCERPT_LENGTH = 200;

/**
 * How much of a message a reply quotes: enough for one line, cut before any
 * mention or link the limit would split, so a cut never shows half an id.
 */
export function replyExcerpt(text: string): string {
  if (text.length <= REPLY_EXCERPT_LENGTH) return text;
  const cut = text.slice(0, REPLY_EXCERPT_LENGTH);
  const open = cut.lastIndexOf("<");
  return open > cut.lastIndexOf(">") ? cut.slice(0, open) : cut;
}
