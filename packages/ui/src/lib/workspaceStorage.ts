import {
  applyDraftChanges,
  applyOutboxChanges,
  readStoredDrafts,
  readStoredOutbox,
  unwrapStoredDrafts,
  unwrapStoredOutbox,
  type DraftChanges,
  type OutboxChanges,
  type StoredOutbox,
} from "@ownbase/client-core";
import type { Platform } from "../platform.js";
import { checkWorkspaceAddress } from "./workspaceAddressTrust.js";

export interface WorkspaceStorageKey {
  key: string;
  /** The account-scoped address key used before workspace IDs reached the client. */
  legacyKey?: string;
  legacyScope?: {
    baseUrl: string;
    workspaceId: string;
    selfId: string;
    kind: string;
    suffix?: string;
  };
}

/** Call only with identity from the authenticated ready snapshot. */
export function workspaceStorageKey(
  baseUrl: string,
  workspaceId: string | null | undefined,
  selfId: string | null | undefined,
  kind: string,
  suffix?: string,
): WorkspaceStorageKey | null {
  if (!selfId) return null;
  const legacyKey = `${kind}:${baseUrl}:${selfId}${suffix === undefined ? "" : `:${suffix}`}`;
  if (!workspaceId) return { key: legacyKey };
  const parts = [workspaceId, selfId, kind, ...(suffix === undefined ? [] : [suffix])];
  return {
    key: `local:v1:${parts.map(encodeURIComponent).join(":")}`,
    legacyKey,
    legacyScope: { baseUrl, workspaceId, selfId, kind, suffix },
  };
}

const queues = new WeakMap<Platform, Map<string, Promise<void>>>();

function serialized<T>(platform: Platform, key: string, operation: () => Promise<T>): Promise<T> {
  const queue = queues.get(platform) ?? new Map<string, Promise<void>>();
  queues.set(platform, queue);
  const previous = queue.get(key);
  let result: Promise<T>;
  try {
    // An uncontended write is still asked for immediately: pagehide cannot
    // rely on another turn to save the final keystroke.
    result = previous ? previous.then(operation) : operation();
  } catch (error) {
    result = Promise.reject(error);
  }
  // A rejected operation reaches its caller without blocking later retries.
  const settled = result.then(
    () => {},
    () => {},
  );
  queue.set(key, settled);
  void settled.then(() => {
    if (queue.get(key) === settled) queue.delete(key);
  });
  return result;
}

function envelope(value: unknown) {
  if (value === undefined) throw new Error("Cannot save an undefined workspace value.");
  return { version: 1, value };
}

function unwrap<T>(stored: unknown): T | null {
  if (
    !stored ||
    typeof stored !== "object" ||
    Array.isArray(stored) ||
    !("version" in stored) ||
    stored.version !== 1 ||
    !("value" in stored)
  ) {
    throw new Error("Could not read the saved workspace data.");
  }
  return stored.value as T | null;
}

/**
 * The address-scoped keys a value may still sit under from before workspace
 * IDs, in the order to try them. Only addresses this device has linked to the
 * workspace, so a server that copies a workspace's ID cannot read its work.
 */
async function legacyKeysOf(platform: Platform, key: WorkspaceStorageKey): Promise<string[]> {
  if (!key.legacyKey) return [];
  const legacyKeys = [key.legacyKey];
  if (key.legacyScope) {
    const scope = key.legacyScope;
    const access = await checkWorkspaceAddress(
      platform,
      scope.workspaceId,
      scope.selfId,
      scope.baseUrl,
    );
    if (!access.allowed)
      throw new Error("Approve this workspace address before restoring local work.");
    // A thread composer/search dialog may never have opened at the old
    // address after upgrade. Its legacy slot is still recoverable once both
    // addresses have been explicitly linked on this device.
    for (const address of access.addresses) {
      const candidate = `${scope.kind}:${address}:${scope.selfId}${scope.suffix === undefined ? "" : `:${scope.suffix}`}`;
      if (!legacyKeys.includes(candidate)) legacyKeys.push(candidate);
    }
  }
  return legacyKeys;
}

/**
 * Stores `value` only where nothing is stored yet, and gives back what is
 * stored now (GL-01): where the platform can, in one step across windows, so
 * a window that read nothing a moment ago cannot replace what another window
 * has stored since. Elsewhere, a read and a write in this window's turn.
 */
async function initialize(platform: Platform, key: string, value: unknown): Promise<unknown> {
  if (platform.storage.initialize) return platform.storage.initialize(key, value);
  const stored = await platform.storage.get<unknown>(key, { strict: true });
  if (stored !== null) return stored;
  await platform.storage.set(key, value);
  return value;
}

export function readWorkspaceStorage<T>(
  platform: Platform,
  key: WorkspaceStorageKey,
): Promise<T | null> {
  return serialized(platform, key.key, async () => {
    const stored = await platform.storage.get<unknown>(key.key, { strict: true });
    if (!key.legacyKey) return stored as T | null;
    if (stored !== null) return unwrap<T>(stored);
    for (const legacyKey of await legacyKeysOf(platform, key)) {
      const value = await serialized(platform, legacyKey, async () => {
        const legacy = await platform.storage.get<T>(legacyKey, { strict: true });
        if (legacy === null) return null;
        const brought = envelope(legacy);
        const now = await initialize(platform, key.key, brought);
        // Another window stored this key first: its value stands, and the old
        // key stays where it is rather than being retired for a copy not made.
        if (JSON.stringify(now) !== JSON.stringify(brought)) return { stored: unwrap<T>(now) };
        try {
          await platform.storage.set(legacyKey, null);
        } catch {
          // The durable new value remains authoritative if retirement fails.
        }
        return { stored: legacy };
      });
      if (value !== null) return value.stored;
    }
    // Record absence as well: dismissed recovery and cleared data must not be
    // resurrected by a stale address key on a later read. Only where nothing
    // is stored yet: another window may have saved work here meanwhile.
    return unwrap<T>(await initialize(platform, key.key, envelope(null)));
  });
}

export function writeWorkspaceStorage(
  platform: Platform,
  key: WorkspaceStorageKey,
  value: unknown,
): Promise<void> {
  return serialized(platform, key.key, () =>
    platform.storage.set(key.key, key.legacyKey ? envelope(value) : value),
  );
}

/**
 * Reads a value and writes what `update` makes of it in one turn of its key's
 * queue, so two writers here cannot lose each other's change in between. Call
 * only after the value has been read once, which retires its legacy key. A
 * value that cannot be read is replaced rather than blocking every later save.
 */
export function updateWorkspaceStorage(
  platform: Platform,
  key: WorkspaceStorageKey,
  update: (current: unknown) => unknown,
): Promise<void> {
  return serialized(platform, key.key, async () => {
    let current: unknown = null;
    try {
      const stored = await platform.storage.get<unknown>(key.key, { strict: true });
      current = key.legacyKey && stored !== null ? unwrap(stored) : stored;
    } catch {
      // Nothing unreadable can be kept; the writer's own value takes its place.
    }
    const value = update(current);
    await platform.storage.set(key.key, key.legacyKey ? envelope(value) : value);
  });
}

/**
 * One merge of outbox changes, in whatever turn of this window's queue the
 * caller holds. Where the platform can, the read, merge and write are one step
 * across every window; otherwise they are one step within this window.
 */
async function mergeOutboxNow(
  platform: Platform,
  key: WorkspaceStorageKey,
  changes: OutboxChanges,
): Promise<StoredOutbox> {
  const enveloped = !!key.legacyKey;
  if (platform.storage.mergeOutbox)
    return platform.storage.mergeOutbox(key.key, changes, enveloped);
  let stored: unknown = null;
  try {
    stored = await platform.storage.get<unknown>(key.key, { strict: true });
  } catch {
    // Nothing unreadable can be kept; the merge takes its place.
  }
  const { value, outbox } = applyOutboxChanges(stored, changes, enveloped);
  await platform.storage.set(key.key, value);
  return outbox;
}

/**
 * Merges one window's outbox changes into what is stored and gives back the
 * outbox now stored. Where the platform can, this is one step across every
 * window, asked for at once: the platform makes merges in the order they are
 * asked for, and a page that is closing may not live to ask later (F01).
 * Otherwise it is one turn of this window's queue for the key. Call only
 * after `readWorkspaceOutbox`.
 */
export function mergeWorkspaceOutbox(
  platform: Platform,
  key: WorkspaceStorageKey,
  changes: OutboxChanges,
): Promise<StoredOutbox> {
  if (platform.storage.mergeOutbox) return mergeOutboxNow(platform, key, changes);
  return serialized(platform, key.key, () => mergeOutboxNow(platform, key, changes));
}

/**
 * Reads the outbox. The first read of a key also records that it exists and
 * brings across what an address-scoped key from before workspace IDs held,
 * as `readWorkspaceStorage` does for other work, but by merging, never by
 * writing a whole value: another window may be setting up the same key, or
 * have stored a send in it, between this read and that write, and a send it
 * stored must not be replaced. Rejects a stored value that is not an outbox,
 * leaving it where it is.
 */
export function readWorkspaceOutbox(
  platform: Platform,
  key: WorkspaceStorageKey,
): Promise<StoredOutbox> {
  return serialized(platform, key.key, async () => {
    const stored = await platform.storage.get<unknown>(key.key, { strict: true });
    if (stored !== null) {
      const outbox = unwrapStoredOutbox(stored, !!key.legacyKey);
      if (!outbox) throw new Error("Could not read the saved outbox.");
      return outbox;
    }
    for (const legacyKey of await legacyKeysOf(platform, key)) {
      const legacy = await serialized(platform, legacyKey, () =>
        platform.storage.get<unknown>(legacyKey, { strict: true }),
      );
      if (legacy === null) continue;
      const earlier = readStoredOutbox(legacy);
      if (!earlier) throw new Error("Could not read the saved outbox.");
      const outbox = await mergeOutboxNow(platform, key, {
        put: earlier.entries,
        remove: earlier.removed,
      });
      try {
        await serialized(platform, legacyKey, () => platform.storage.set(legacyKey, null));
      } catch {
        // What was merged is authoritative even if the old key stays.
      }
      return outbox;
    }
    // Nothing anywhere: record that, by merging nothing, so a stale address
    // key cannot bring back cleared work on a later read.
    return mergeOutboxNow(platform, key, { put: [], remove: [] });
  });
}

/**
 * Calls back with the stored outbox, or null when it cannot be read, each
 * time another window changes it. Does nothing where the platform cannot tell.
 */
export function watchWorkspaceOutbox(
  platform: Platform,
  key: WorkspaceStorageKey,
  cb: (outbox: StoredOutbox | null) => void,
): () => void {
  const watch = platform.storage.watchOutbox;
  if (!watch) return () => {};
  return watch(key.key, (stored) => cb(unwrapStoredOutbox(stored, !!key.legacyKey)));
}

/** As `mergeOutboxNow`, for drafts. */
async function mergeDraftsNow(
  platform: Platform,
  key: WorkspaceStorageKey,
  changes: DraftChanges,
): Promise<Record<string, string>> {
  const enveloped = !!key.legacyKey;
  if (platform.storage.mergeDrafts)
    return platform.storage.mergeDrafts(key.key, changes, enveloped);
  let stored: unknown = null;
  try {
    stored = await platform.storage.get<unknown>(key.key, { strict: true });
  } catch {
    // Nothing unreadable can be kept; the merge takes its place.
  }
  const { value, drafts } = applyDraftChanges(stored, changes, enveloped);
  await platform.storage.set(key.key, value);
  return drafts;
}

/**
 * Merges one window's draft changes into what is stored and gives back the
 * drafts now stored, as `mergeWorkspaceOutbox` does for the outbox. The
 * changes are worked out in this window's turn for the key, once every
 * earlier merge from here has come back, so none is made from a view of the
 * drafts older than the last one this window stored. Null, and nothing
 * written, when there are none. Call only after `readWorkspaceDrafts`.
 */
export function mergeWorkspaceDrafts(
  platform: Platform,
  key: WorkspaceStorageKey,
  changes: () => DraftChanges,
): Promise<{ changes: DraftChanges; drafts: Record<string, string> } | null> {
  return serialized(platform, key.key, async () => {
    const now = changes();
    if (Object.keys(now.put).length === 0 && now.remove.length === 0) return null;
    return { changes: now, drafts: await mergeDraftsNow(platform, key, now) };
  });
}

/**
 * Merges draft changes at once rather than in this window's turn for the key,
 * for a page that may be closing and not live to take that turn (F01). Where
 * the platform merges in one step it makes merges in the order they are asked
 * for, so these come after every merge already asked for and before any still
 * waiting its turn here: make them from what the ones asked for will have
 * stored. Elsewhere they take their turn like any other.
 */
export function mergeWorkspaceDraftsAtOnce(
  platform: Platform,
  key: WorkspaceStorageKey,
  changes: DraftChanges,
): Promise<Record<string, string>> {
  if (platform.storage.mergeDrafts) return mergeDraftsNow(platform, key, changes);
  return serialized(platform, key.key, () => mergeDraftsNow(platform, key, changes));
}

/**
 * Reads the drafts, as `readWorkspaceOutbox` reads the outbox: the first read
 * of a key records it and brings across an address-scoped key's drafts by
 * merging, filling only conversations without a draft, so nothing another
 * window stored meanwhile is replaced. Rejects a stored value that is not
 * drafts, leaving it where it is.
 */
export function readWorkspaceDrafts(
  platform: Platform,
  key: WorkspaceStorageKey,
): Promise<Record<string, string>> {
  return serialized(platform, key.key, async () => {
    const stored = await platform.storage.get<unknown>(key.key, { strict: true });
    if (stored !== null) {
      const drafts = unwrapStoredDrafts(stored, !!key.legacyKey);
      if (!drafts) throw new Error("Could not read the saved drafts.");
      return drafts;
    }
    for (const legacyKey of await legacyKeysOf(platform, key)) {
      const legacy = await serialized(platform, legacyKey, () =>
        platform.storage.get<unknown>(legacyKey, { strict: true }),
      );
      if (legacy === null) continue;
      const earlier = readStoredDrafts(legacy);
      if (!earlier) throw new Error("Could not read the saved drafts.");
      const drafts = await mergeDraftsNow(platform, key, { put: {}, remove: [], fill: earlier });
      try {
        await serialized(platform, legacyKey, () => platform.storage.set(legacyKey, null));
      } catch {
        // What was merged is authoritative even if the old key stays.
      }
      return drafts;
    }
    return mergeDraftsNow(platform, key, { put: {}, remove: [] });
  });
}

/** As `watchWorkspaceOutbox`, for drafts. */
export function watchWorkspaceDrafts(
  platform: Platform,
  key: WorkspaceStorageKey,
  cb: (drafts: Record<string, string> | null) => void,
): () => void {
  const watch = platform.storage.watchDrafts;
  if (!watch) return () => {};
  return watch(key.key, (stored) => cb(unwrapStoredDrafts(stored, !!key.legacyKey)));
}
