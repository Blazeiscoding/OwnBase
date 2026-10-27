import type { Channel, ID } from "@ownbase/protocol";

/**
 * What one draft this device keeps is, as its key says: a conversation's
 * composer, a thread's, or an edit not yet saved to a message or to a
 * message queued to send later.
 */
export type DraftPlace =
  | { kind: "conversation"; channelId: ID }
  | { kind: "thread"; channelId: ID; rootId: ID }
  | { kind: "edit"; channelId: ID; messageId: ID }
  | { kind: "scheduled-edit"; channelId: ID; scheduledId: ID };

/** The key an unsaved edit of a message is kept under. */
export const editDraftKey = (channelId: ID, messageId: ID) => `${channelId}:edit:${messageId}`;

/** The key an unsaved edit of a scheduled message is kept under. */
export const scheduledEditDraftKey = (channelId: ID, scheduledId: ID) =>
  `${channelId}:scheduled-edit:${scheduledId}`;

/** What a draft key names, or null for one this version does not know. Ids hold no colons. */
export function draftPlace(key: string): DraftPlace | null {
  const parts = key.split(":");
  if (parts.length > 3 || parts.some((part) => !part)) return null;
  const [channelId = "", second, third] = parts;
  if (second === undefined) return { kind: "conversation", channelId };
  if (third === undefined) return { kind: "thread", channelId, rootId: second };
  if (second === "edit") return { kind: "edit", channelId, messageId: third };
  if (second === "scheduled-edit") return { kind: "scheduled-edit", channelId, scheduledId: third };
  return null;
}

/**
 * An unsaved edit, kept with the words it started from so that one picked up
 * after a restart can still tell the message has changed since. An edit kept
 * before that was stored as its text alone, and starts from the message.
 */
export interface EditDraft {
  text: string;
  base?: string;
}

export function readEditDraft(value: string | undefined): EditDraft | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      "text" in parsed &&
      "base" in parsed &&
      typeof parsed.text === "string" &&
      typeof parsed.base === "string"
    )
      return { text: parsed.text, base: parsed.base };
  } catch {
    // An edit kept as plain text.
  }
  return { text: value };
}

/** The text of an unsaved scheduled-message edit, kept as `{ text }`. */
export function readScheduledEditDraft(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && "text" in parsed && typeof parsed.text === "string")
      return parsed.text;
  } catch {
    // Ignore malformed local data rather than replacing the queued text with it.
  }
  return undefined;
}

export interface DraftEntry {
  key: string;
  place: DraftPlace;
  /** The words, as the person wrote them. */
  text: string;
  /** When they last changed, if this device knows. */
  at?: number;
}

/**
 * Every draft to list, newest first, then those whose time this device never
 * learned (kept by an earlier version). Drafts in conversations this client
 * no longer has, and keys it does not know, are left out.
 */
export function listDrafts(
  drafts: Record<string, string>,
  times: Record<string, number>,
  channels: Record<ID, Channel>,
): DraftEntry[] {
  const entries: DraftEntry[] = [];
  for (const [key, value] of Object.entries(drafts)) {
    const place = draftPlace(key);
    if (!place || !channels[place.channelId]) continue;
    const text =
      place.kind === "edit"
        ? readEditDraft(value)?.text
        : place.kind === "scheduled-edit"
          ? readScheduledEditDraft(value)
          : value;
    if (!text?.trim()) continue;
    entries.push({ key, place, text, at: times[key] });
  }
  // Stable, so drafts with no time keep the order they were stored in.
  return entries.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** Stored draft times, keeping only what reads as a time. */
export function readDraftTimes(value: unknown): Record<string, number> {
  const times: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return times;
  for (const [key, at] of Object.entries(value))
    if (typeof at === "number" && Number.isFinite(at)) times[key] = at;
  return times;
}
