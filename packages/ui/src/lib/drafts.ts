import type { Channel, ID } from "@ownbase/protocol";
import { draftPlace, type DraftPlace } from "@ownbase/client-core";

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
  /**
   * Written in a conversation this account can no longer open: it was
   * removed from it, or it is gone. The words can be copied, not sent.
   */
  gone?: boolean;
}

/**
 * Every draft to list, newest first, then those whose time this device never
 * learned (kept by an earlier version). Keys it does not know are left out.
 * So are drafts in conversations this client does not have, unless `settled`
 * says its conversations are the server's: then they are listed as gone,
 * since the words are still the person's.
 */
export function listDrafts(
  drafts: Record<string, string>,
  times: Record<string, number>,
  channels: Record<ID, Channel>,
  settled = false,
): DraftEntry[] {
  const entries: DraftEntry[] = [];
  for (const [key, value] of Object.entries(drafts)) {
    const place = draftPlace(key);
    if (!place) continue;
    const gone = !channels[place.channelId];
    if (gone && !settled) continue;
    const text =
      place.kind === "edit"
        ? readEditDraft(value)?.text
        : place.kind === "scheduled-edit"
          ? readScheduledEditDraft(value)
          : value;
    if (!text?.trim()) continue;
    entries.push({ key, place, text, at: times[key], ...(gone ? { gone } : {}) });
  }
  // Stable, so drafts with no time keep the order they were stored in.
  return entries.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
