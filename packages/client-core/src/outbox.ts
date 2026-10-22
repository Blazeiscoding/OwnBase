import {
  SEND_RETRY_WINDOW_MS,
  type ForwardReference,
  type ReplyReference,
} from "@slackoss/protocol";
import type { StoredPending } from "./workspace.js";
import type { PollDraft } from "./polls.js";

/**
 * The outbox as every window open on one account keeps it on the device.
 *
 * Each window writes its own sends and removals, never a whole list read
 * earlier, so the stored outbox is a merge of changes rather than whichever
 * window wrote last. A send taken out, because it was delivered or its author
 * discarded it, leaves a tombstone: no window can put it back, however stale
 * its copy. A tombstone is let go only once its send is too old to be sent on
 * its own (see `OUTBOX_TOMBSTONES_KEPT`), and a floor then refuses it instead.
 * Between two versions of the same send, the newer revision wins, so a
 * refusal written by one window cannot be undone by another that has not seen
 * it; only a newer change, such as its author choosing Retry, replaces it.
 *
 * Kept free of anything but plain data so the desktop app's main process can
 * run the same merge, in one step, for every window at once.
 */
export interface StoredOutboxEntry extends StoredPending {
  /** When this version of the send was written; see `outboxRevision`. */
  rev: number;
}

export interface StoredOutbox {
  outbox: 2;
  /** The sends still waiting, in the order they were first stored. */
  entries: StoredOutboxEntry[];
  /** Sends taken out, by nonce, newest first. */
  removed: { nonce: string; rev: number }[];
  /**
   * The newest revision among the tombstones let go. A send the outbox does
   * not hold, at or below it, can only be one of those, put back by a window
   * that has not caught up, and is refused. Absent until one is let go.
   */
  compactedThrough?: number;
}

export interface OutboxChanges {
  put: StoredOutboxEntry[];
  remove: { nonce: string; rev: number }[];
}

/**
 * The fewest tombstones kept. Every one written within `SEND_RETRY_WINDOW_MS`
 * is kept as well, up to `OUTBOX_TOMBSTONES_MAX`: a send that old or newer
 * could still be sent on its own by a window that has not caught up. An older
 * one is let go only past this many, and `compactedThrough` then stands in
 * for it.
 */
export const OUTBOX_TOMBSTONES_KEPT = 500;

/**
 * The most tombstones kept, however recent: about 660 KiB, and a merge of a
 * few milliseconds (330 sends a day for the whole window). Past this, the
 * oldest go even inside the window, and the floor still refuses a stale
 * window's unchanged copy of one of them.
 */
export const OUTBOX_TOMBSTONES_MAX = 10_000;

/**
 * A revision later than `previous` and, across windows, later than anything
 * written in an earlier millisecond: wall-clock time with room for a counter.
 */
export function outboxRevision(previous = 0, now = Date.now()): number {
  return Math.max(previous + 1, now * 1000);
}

export function isStoredPending(entry: unknown): entry is StoredPending {
  const e = entry as Record<string, unknown> | null;
  return (
    !!e &&
    typeof e === "object" &&
    typeof e.nonce === "string" &&
    typeof e.channelId === "string" &&
    (e.threadRootId === null || typeof e.threadRootId === "string") &&
    (e.broadcast === undefined || typeof e.broadcast === "boolean") &&
    (e.replyTo === undefined || isReplyReference(e.replyTo)) &&
    (e.forward === undefined || isForwardReference(e.forward)) &&
    (e.poll === undefined || isPollDraft(e.poll)) &&
    typeof e.text === "string" &&
    typeof e.userId === "string" &&
    Number.isFinite(e.createdAt) &&
    (e.refusal === undefined || typeof e.refusal === "string") &&
    Array.isArray(e.attachments) &&
    e.attachments.every(
      (file: { name?: unknown; size?: unknown; mime?: unknown } | null) =>
        !!file &&
        typeof file.name === "string" &&
        typeof file.size === "number" &&
        Number.isFinite(file.size) &&
        file.size >= 0 &&
        typeof file.mime === "string",
    )
  );
}

function isReplyReference(value: unknown): value is ReplyReference {
  const r = value as Record<string, unknown> | null;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.id === "string" &&
    typeof r.userId === "string" &&
    typeof r.text === "string" &&
    typeof r.fileCount === "number" &&
    typeof r.deleted === "boolean" &&
    typeof r.ping === "boolean"
  );
}

function isForwardReference(value: unknown): value is ForwardReference {
  const r = value as Record<string, unknown> | null;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.id === "string" &&
    typeof r.channelId === "string" &&
    typeof r.userId === "string" &&
    typeof r.text === "string" &&
    Array.isArray(r.files) &&
    r.files.every(
      (f: Record<string, unknown> | null) =>
        !!f && typeof f === "object" && typeof f.id === "string" && typeof f.name === "string",
    ) &&
    Number.isFinite(r.createdAt) &&
    typeof r.deleted === "boolean" &&
    typeof r.hidden === "boolean"
  );
}

function isPollDraft(value: unknown): value is PollDraft {
  const p = value as Record<string, unknown> | null;
  return (
    !!p &&
    typeof p === "object" &&
    Array.isArray(p.options) &&
    p.options.every((option) => typeof option === "string") &&
    typeof p.multiple === "boolean" &&
    typeof p.anonymous === "boolean"
  );
}

const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A send as plain data in a fixed shape, so two copies compare by their JSON. */
export function storedPending(entry: StoredPending): StoredPending {
  return {
    nonce: entry.nonce,
    channelId: entry.channelId,
    threadRootId: entry.threadRootId,
    ...(entry.broadcast === undefined ? {} : { broadcast: entry.broadcast }),
    ...(entry.replyTo === undefined
      ? {}
      : {
          replyTo: {
            id: entry.replyTo.id,
            userId: entry.replyTo.userId,
            text: entry.replyTo.text,
            fileCount: entry.replyTo.fileCount,
            deleted: entry.replyTo.deleted,
            ping: entry.replyTo.ping,
          },
        }),
    ...(entry.forward === undefined
      ? {}
      : {
          forward: {
            id: entry.forward.id,
            channelId: entry.forward.channelId,
            userId: entry.forward.userId,
            text: entry.forward.text,
            files: entry.forward.files,
            createdAt: entry.forward.createdAt,
            deleted: entry.forward.deleted,
            hidden: entry.forward.hidden,
          },
        }),
    ...(entry.poll === undefined
      ? {}
      : {
          poll: {
            options: [...entry.poll.options],
            multiple: entry.poll.multiple,
            anonymous: entry.poll.anonymous,
          },
        }),
    text: entry.text,
    userId: entry.userId,
    createdAt: entry.createdAt,
    attachments: entry.attachments.map((a) => ({ name: a.name, size: a.size, mime: a.mime })),
    ...(entry.refusal === undefined ? {} : { refusal: entry.refusal }),
  };
}

export function emptyOutbox(): StoredOutbox {
  return { outbox: 2, entries: [], removed: [] };
}

/**
 * Reads a stored outbox of either shape: this one, or the plain list earlier
 * versions wrote, whose entries count as the oldest revision there is. Null
 * when it is neither, or holds an entry that is not a send.
 */
export function readStoredOutbox(value: unknown): StoredOutbox | null {
  if (value === null || value === undefined) return emptyOutbox();
  if (Array.isArray(value)) {
    return value.every(isStoredPending)
      ? { outbox: 2, entries: value.map((entry) => ({ ...entry, rev: 0 })), removed: [] }
      : null;
  }
  const record = value as Partial<StoredOutbox>;
  if (
    typeof record !== "object" ||
    record.outbox !== 2 ||
    !Array.isArray(record.entries) ||
    !Array.isArray(record.removed) ||
    !record.entries.every((entry) => isStoredPending(entry) && isRevision(entry.rev)) ||
    !record.removed.every((r) => !!r && typeof r.nonce === "string" && isRevision(r.rev)) ||
    (record.compactedThrough !== undefined && !isRevision(record.compactedThrough))
  ) {
    return null;
  }
  return record as StoredOutbox;
}

/**
 * Applies one window's changes. A tombstone is final, and so is the floor
 * standing in for those let go. Otherwise the newest revision of a send is
 * kept, and at the same revision the one already stored.
 */
export function mergeOutbox(
  current: StoredOutbox,
  changes: OutboxChanges,
  now = Date.now(),
): StoredOutbox {
  const entries = new Map(current.entries.map((entry) => [entry.nonce, entry]));
  const removed = new Map(current.removed.map((r) => [r.nonce, r.rev]));
  const floor = current.compactedThrough ?? -1;
  for (const removal of changes.remove) {
    if (!removal || typeof removal.nonce !== "string" || !isRevision(removal.rev)) continue;
    entries.delete(removal.nonce);
    removed.set(removal.nonce, Math.max(removed.get(removal.nonce) ?? 0, removal.rev));
  }
  for (const entry of changes.put) {
    if (!isStoredPending(entry) || !isRevision(entry.rev) || removed.has(entry.nonce)) continue;
    const held = entries.get(entry.nonce);
    if (held ? held.rev >= entry.rev : entry.rev <= floor) continue;
    entries.set(entry.nonce, { ...storedPending(entry), rev: entry.rev });
  }
  const newestFirst = [...removed]
    .map(([nonce, rev]) => ({ nonce, rev }))
    .sort((a, b) => b.rev - a.rev);
  // Newest first, so what is kept is a prefix: every tombstone inside the
  // window, never fewer than the minimum and never more than the most.
  const recent = outboxRevision(0, now - SEND_RETRY_WINDOW_MS);
  const older = newestFirst.findIndex((r) => r.rev < recent);
  const kept = Math.min(
    OUTBOX_TOMBSTONES_MAX,
    Math.max(OUTBOX_TOMBSTONES_KEPT, older === -1 ? newestFirst.length : older),
  );
  const letGo = newestFirst[kept];
  const compacted = letGo ? Math.max(floor, letGo.rev) : floor;
  return {
    outbox: 2,
    entries: [...entries.values()],
    removed: newestFirst.slice(0, kept),
    ...(compacted >= 0 ? { compactedThrough: compacted } : {}),
  };
}

/**
 * The outbox inside a stored value. `enveloped` is whether the key's value is
 * wrapped as `{ version: 1, value }`, as workspace-scoped keys are. Null when
 * the value cannot be read as an outbox.
 */
export function unwrapStoredOutbox(stored: unknown, enveloped: boolean): StoredOutbox | null {
  if (!enveloped || stored === null || stored === undefined) return readStoredOutbox(stored);
  const wrapper = stored as { version?: unknown; value?: unknown };
  if (typeof wrapper !== "object" || Array.isArray(wrapper) || wrapper.version !== 1) return null;
  return readStoredOutbox(wrapper.value);
}

/**
 * The whole step one atomic storage update performs: take what is stored,
 * whatever state it is in, merge the changes, and give back what to store and
 * the outbox it holds. Anything unreadable is replaced rather than left to
 * block every later save; a send it held is not lost for that alone, since
 * each window keeps writing its own until it sees them stored.
 */
export function applyOutboxChanges(
  stored: unknown,
  changes: OutboxChanges,
  enveloped: boolean,
): { value: unknown; outbox: StoredOutbox } {
  const outbox = mergeOutbox(unwrapStoredOutbox(stored, enveloped) ?? emptyOutbox(), changes);
  return { value: enveloped ? { version: 1, value: outbox } : outbox, outbox };
}
