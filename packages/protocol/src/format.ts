import type { ID } from "./entities.js";

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

/** `<!here>`, `<!channel>` or `<!everyone>`. Global: use with matchAll or replaceAll. */
export const BROADCAST_MENTION = /<!(channel|here|everyone)>/g;

export function broadcastsIn(text: string): Set<Broadcast> {
  const found = new Set<Broadcast>();
  for (const m of text.matchAll(BROADCAST_MENTION)) {
    found.add(m[1] === "here" ? "here" : "channel");
  }
  return found;
}

/** `<@id>`, the wire form of naming a person. Global: use with matchAll or replaceAll. */
export const USER_MENTION = /<@([A-Za-z0-9_-]+)>/g;

export function userMentionsIn(text: string): Set<ID> {
  return new Set([...text.matchAll(USER_MENTION)].map((m) => m[1]!));
}

/** How a broadcast token reads to a person: `<!here>` becomes `@here`. */
export function broadcastLabel(token: string): string {
  return `@${token === "everyone" ? "channel" : token}`;
}

/** `<#id>`, the wire form of naming a channel. Global: use with matchAll or replaceAll. */
export const CHANNEL_MENTION = /<#([A-Za-z0-9_-]+)>/g;

/**
 * `<!subteam^id|@handle>`, the wire form of naming a user group (J13). It is
 * Slack's, label and all, so an app reading Slack's form reads ours. The
 * label is what the group was called when the message was sent: a group that
 * is gone reads as it. One without a label is accepted on the way in.
 * Global: use with matchAll or replaceAll.
 */
export const GROUP_MENTION = /<!subteam\^([A-Za-z0-9_-]+)(?:\|([^<>\n]*))?>/g;

export function groupMentionsIn(text: string): Set<ID> {
  return new Set([...text.matchAll(GROUP_MENTION)].map((m) => m[1]!));
}

/** The token that mentions a group, as the composer writes it. */
export function groupMentionToken(group: { id: ID; handle: string }): string {
  return `<!subteam^${group.id}|@${group.handle}>`;
}

/**
 * How a group mention reads: a group there now by its handle now, and one
 * that is gone by the label it was sent with.
 */
export function groupMentionLabel(
  group: { handle: string } | undefined,
  label: string | null | undefined,
): string {
  if (group) return `@${group.handle}`;
  return label?.trim() || "@group";
}

/**
 * A custom emoji's name (J12): 1 to 32 lowercase letters, digits, `_` and
 * `-`. Text writes it between colons, `:name:`, as Slack does.
 */
export const CUSTOM_EMOJI_NAME = /^[a-z0-9_-]{1,32}$/;

const emojiName = CUSTOM_EMOJI_NAME.source.slice(1, -1);

/**
 * A custom emoji's `:name:` in words, read as the app draws one: not against
 * a letter, digit or colon, so 10:30:45 stays a time. Global: use with
 * matchAll or replaceAll.
 */
export const CUSTOM_EMOJI_TOKEN = new RegExp(
  `(?<![A-Za-z0-9:]):(${emojiName}):(?![A-Za-z0-9])`,
  "g",
);

/**
 * Every mention token, in the order a client reads them: a person's id, a
 * channel's id, a broadcast's word, and a group's id and label are groups 1
 * to 5. Global: use with matchAll or replaceAll.
 */
export const MENTION_TOKEN = new RegExp(
  [USER_MENTION, CHANNEL_MENTION, BROADCAST_MENTION, GROUP_MENTION].map((r) => r.source).join("|"),
  "g",
);

/** The name a `:name:` token stands for, or null for any other text. */
export function customEmojiName(token: string): string | null {
  if (token.length < 3 || !token.startsWith(":") || !token.endsWith(":")) return null;
  const name = token.slice(1, -1);
  return CUSTOM_EMOJI_NAME.test(name) ? name : null;
}

/** `<https://…>` or `<https://…|label>`, Slack's link markup. */
const LINK = /<(https?:\/\/[^\s|<>]+)(?:\|([^<>\n]+))?>/g;

/** How the people and channels a message names read where it is shown as plain words. */
export interface MentionLabels {
  user: (id: ID) => string;
  channel: (id: ID) => string;
  /** `label` is the one written in the text, or null where it has none. */
  group: (id: ID, label: string | null) => string;
}

/**
 * A message's words with its markup read out: names for mentions, `@here`
 * for broadcasts, and a link's label, or its address when it has none.
 * Formatting marks are left for the caller, which knows how much it shows.
 */
export function plainText(text: string, labels: MentionLabels): string {
  return text
    .replaceAll(USER_MENTION, (_all, id: ID) => labels.user(id))
    .replaceAll(CHANNEL_MENTION, (_all, id: ID) => labels.channel(id))
    .replaceAll(GROUP_MENTION, (_all, id: ID, label?: string) => labels.group(id, label ?? null))
    .replaceAll(BROADCAST_MENTION, (_all, who: string) => broadcastLabel(who))
    .replaceAll(LINK, (_all, url: string, label?: string) => label?.trim() || url);
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
