import type { ID } from "@ownbase/protocol";

/** The draft of a conversation's composer: a channel's, or one thread's in it. */
export function draftKey(channelId: ID, threadRootId?: ID | null): string {
  return threadRootId ? `${channelId}:${threadRootId}` : channelId;
}

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

export const editDraftKey = (channelId: ID, messageId: ID) => `${channelId}:edit:${messageId}`;

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
 * Drafts as every window open on one account keeps them on the device: one
 * text per conversation, by the key `Composer` gives it.
 *
 * Each window writes only the drafts it changed, never a whole set read
 * earlier, so a draft typed in one window cannot be lost to another window's
 * write about a different conversation. Two windows changing the same
 * conversation: the later write is the draft, as the later keystroke is.
 *
 * Kept free of anything but plain data so the desktop app's main process can
 * run the same merge, in one step, for every window at once.
 */
export interface DraftChanges {
  /** Texts to store, by draft key. */
  put: Record<string, string>;
  /** Draft keys to take out: cleared or sent. */
  remove: string[];
  /**
   * Texts to store only where there is no draft: what an earlier version
   * kept, brought across without replacing anything written since.
   */
  fill?: Record<string, string>;
  /**
   * For each draft put or removed, its stored text when this window last
   * knew it (null: none). One another window has changed since is a conflict
   * (F01, GL-03): both texts are kept in it, rather than the later write
   * replacing the other, and a removal leaves text written there since.
   * Without it, the later write is the draft.
   */
  base?: Record<string, string | null>;
}

/**
 * One draft holding two windows' texts for the same conversation: the one
 * that already contains the other, or both, this window's first.
 */
export function keepBothDrafts(mine: string, theirs: string): string {
  if (mine.includes(theirs)) return mine;
  if (theirs.includes(mine)) return theirs;
  return `${mine}\n\n${theirs}`;
}

/** Drafts in the shape they are stored: text by draft key. Null when not that. */
export function readStoredDrafts(value: unknown): Record<string, string> | null {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const drafts: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== "string") return null;
    drafts[key] = text;
  }
  return drafts;
}

/** The drafts inside a stored value, wrapped as `{ version: 1, value }` when `enveloped`. */
export function unwrapStoredDrafts(
  stored: unknown,
  enveloped: boolean,
): Record<string, string> | null {
  if (!enveloped || stored === null || stored === undefined) return readStoredDrafts(stored);
  const wrapper = stored as { version?: unknown; value?: unknown };
  if (typeof wrapper !== "object" || Array.isArray(wrapper) || wrapper.version !== 1) return null;
  return readStoredDrafts(wrapper.value);
}

/** Applies one window's changes: each put or removal replaces that draft alone. */
export function mergeDrafts(
  current: Record<string, string>,
  changes: DraftChanges,
): Record<string, string> {
  const drafts = { ...current };
  const base = changes.base;
  // Changed by another window since this one last knew it.
  const elsewhere = (key: string) =>
    !!base && Object.hasOwn(base, key) && (current[key] ?? null) !== base[key];
  for (const key of changes.remove)
    if (typeof key === "string" && !(elsewhere(key) && current[key])) delete drafts[key];
  for (const [key, text] of Object.entries(changes.put)) {
    if (typeof text !== "string") continue;
    const theirs = current[key];
    drafts[key] = elsewhere(key) && theirs ? keepBothDrafts(text, theirs) : text;
  }
  for (const [key, text] of Object.entries(changes.fill ?? {})) {
    if (typeof text === "string" && !(key in drafts)) drafts[key] = text;
  }
  return drafts;
}

/** Whether `changes` has the shape a window writes. */
export function isDraftChanges(changes: unknown): changes is DraftChanges {
  const c = changes as Partial<DraftChanges> | null;
  const texts = (value: unknown) =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((text) => typeof text === "string");
  const bases = (value: unknown) =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((text) => text === null || typeof text === "string");
  return (
    !!c &&
    typeof c === "object" &&
    texts(c.put) &&
    (c.fill === undefined || texts(c.fill)) &&
    (c.base === undefined || bases(c.base)) &&
    Array.isArray(c.remove) &&
    c.remove.every((key) => typeof key === "string")
  );
}

/**
 * The whole step one atomic storage update performs: take what is stored,
 * merge the changes, and give back what to store and the drafts in it. A
 * value that cannot be read as drafts is replaced rather than left to block
 * every later save, as a whole-set write would have replaced it.
 */
export function applyDraftChanges(
  stored: unknown,
  changes: DraftChanges,
  enveloped: boolean,
): { value: unknown; drafts: Record<string, string> } {
  const drafts = mergeDrafts(unwrapStoredDrafts(stored, enveloped) ?? {}, changes);
  return { value: enveloped ? { version: 1, value: drafts } : drafts, drafts };
}
