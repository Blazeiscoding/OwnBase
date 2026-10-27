import { broadcastLabel, type Channel, type ID, type User } from "@ownbase/protocol";

/**
 * What a message box shows in place of the mention syntax it stores.
 *
 * A message keeps its mentions as Slack writes them, `<@USER_ID>`, `<#CHANNEL_ID>`
 * and `<!here>`, because the server's mention index and notifications go by those
 * ids. Nobody should have to read or type that, so a box shows `@Sam Rivera`,
 * `#general` and `@here` instead. The stored text stays the one source of truth:
 * what the box shows is worked out from it, and every edit made to what is shown
 * is worked back into it.
 *
 * Editing a mention's label turns what is left of it into ordinary text. It never
 * becomes a mention of somebody else, and an ordinary name typed or pasted never
 * becomes a mention of whoever has it.
 */

/** Who and what a mention can name, by id. */
export interface MentionNames {
  users: Record<ID, User>;
  channels: Record<ID, Channel>;
}

/** The mention tokens messages render as mentions (`Mrkdwn`). */
const TOKEN_RE = /<@([A-Za-z0-9_-]+)>|<#([A-Za-z0-9_-]+)>|<!(channel|here|everyone)>/g;

/** How a person mentioned by id reads; one no longer known keeps the id. */
export const userMentionLabel = (user: User | undefined) => `@${user?.displayName ?? "unknown"}`;
/** How a channel mentioned by id reads; one not visible here says nothing more. */
export const channelMentionLabel = (channel: Channel | undefined) =>
  `#${channel?.name ?? "unknown"}`;

/** A run of the shown text: ordinary text, or a mention standing for its token. */
export interface MentionSegment {
  /** What the box shows. */
  shown: string;
  /** What is stored: the same text, or the mention's token. */
  stored: string;
  mention: boolean;
  /** Where it starts in the shown and the stored text. */
  shownStart: number;
  storedStart: number;
}

export interface MentionDocument {
  /** The stored text, with its tokens. */
  stored: string;
  /** What the box shows. */
  shown: string;
  segments: MentionSegment[];
}

/** Works out what a box shows for stored text. */
export function projectMentions(stored: string, names: MentionNames): MentionDocument {
  const segments: MentionSegment[] = [];
  let shown = "";
  let last = 0;
  const push = (text: string, token: string, mention: boolean, storedStart: number) => {
    if (!token) return;
    segments.push({ shown: text, stored: token, mention, shownStart: shown.length, storedStart });
    shown += text;
  };
  for (const m of stored.matchAll(TOKEN_RE)) {
    const plain = stored.slice(last, m.index);
    push(plain, plain, false, last);
    const label = m[1]
      ? userMentionLabel(names.users[m[1]])
      : m[2]
        ? channelMentionLabel(names.channels[m[2]])
        : broadcastLabel(m[3]!);
    push(label, m[0], true, m.index);
    last = m.index + m[0].length;
  }
  push(stored.slice(last), stored.slice(last), false, last);
  return { stored, shown, segments };
}

/** The mention the shown position `start..end` falls on, if it is one. */
export function mentionAt(doc: MentionDocument, start: number, end = start) {
  return doc.segments.find(
    (s) => s.mention && start >= s.shownStart && end <= s.shownStart + s.shown.length,
  );
}

/**
 * Where a shown position is in the stored text. One inside a mention goes to
 * its start or its end, as `bias` says, so a selection over part of a mention
 * takes in all of it.
 */
export function storedPosition(
  doc: MentionDocument,
  shown: number,
  bias: "start" | "end" = "end",
): number {
  for (const s of doc.segments) {
    const end = s.shownStart + s.shown.length;
    if (shown > end) continue;
    if (!s.mention) return s.storedStart + (shown - s.shownStart);
    if (shown === s.shownStart) return s.storedStart;
    if (shown === end || bias === "end") return s.storedStart + s.stored.length;
    return s.storedStart;
  }
  return doc.stored.length;
}

/** Where a stored position shows. One inside a token goes to its start or end. */
export function shownPosition(
  doc: MentionDocument,
  stored: number,
  bias: "start" | "end" = "end",
): number {
  for (const s of doc.segments) {
    const end = s.storedStart + s.stored.length;
    if (stored > end) continue;
    if (!s.mention) return s.shownStart + (stored - s.storedStart);
    if (stored === s.storedStart) return s.shownStart;
    if (stored === end || bias === "end") return s.shownStart + s.shown.length;
    return s.shownStart;
  }
  return doc.shown.length;
}

/**
 * The stored text after the shown `start..end` is replaced by `insert`, which
 * is stored text (a completed mention is inserted as its token). A mention the
 * edit reaches into becomes the ordinary text of its label, less whatever the
 * edit removed. `caret` is where the insert ends, in the stored text.
 */
export function replaceShown(
  doc: MentionDocument,
  start: number,
  end: number,
  insert: string,
): { stored: string; caret: number } {
  let head = "";
  let tail = "";
  for (const s of doc.segments) {
    const shownEnd = s.shownStart + s.shown.length;
    if (shownEnd <= start) head += s.stored;
    else if (s.shownStart >= end) tail += s.stored;
    else {
      // Reached into: what is left of it is ordinary text.
      head += s.shown.slice(0, Math.max(0, start - s.shownStart));
      tail += s.shown.slice(Math.max(0, end - s.shownStart));
    }
  }
  return { stored: head + insert + tail, caret: head.length + insert.length };
}

/**
 * The one edit that turned `before` into `after`: shown `start..end` replaced
 * by `inserted`. A text box says only what it holds now, so the edit is the
 * part that differs. Where that is ambiguous, as typing a letter beside the same
 * letter is, the caret (where the box puts it after the edit) settles it.
 */
export function shownEdit(
  before: string,
  after: string,
  caret?: number,
): { start: number; end: number; inserted: string } {
  const room = Math.min(before.length, after.length);
  let suffix = 0;
  const maxSuffix = caret === undefined ? room : Math.min(room, Math.max(0, after.length - caret));
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  let prefix = 0;
  while (prefix < room - suffix && before[prefix] === after[prefix]) prefix++;
  return {
    start: prefix,
    end: before.length - suffix,
    inserted: after.slice(prefix, after.length - suffix),
  };
}
