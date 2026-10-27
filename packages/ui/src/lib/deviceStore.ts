import {
  addTrustedAddress,
  applyDraftChanges,
  applyOutboxChanges,
  applyRecordChanges,
  isDraftChanges,
  isRecordChanges,
  readStoredOutbox,
  readTrustedAddresses,
  unwrapStoredDrafts,
  unwrapStoredOutbox,
  type DraftChanges,
  type OutboxChanges,
  type RecordChanges,
} from "@ownbase/client-core";
import {
  changeSavedServers,
  isSignInChange,
  readSavedServers,
  type SignInChange,
} from "./savedServers.js";

/**
 * Where the web client keeps unsent work and choices on this device (F01).
 *
 * In IndexedDB where the browser has it: every change to a key is one
 * readwrite transaction, read, merge and write together, and the browser
 * runs those one at a time for every tab and process of this site. Tabs in
 * different processes each keep their own copy of localStorage and hear of
 * each other's writes a moment later, so with localStorage alone two tabs
 * could each merge into a copy without the other's change and one would be
 * lost. A change is acknowledged when its transaction completes.
 *
 * A transaction a closing page started may never complete, which
 * localStorage's immediate writes never risked. So each change is first
 * written down, as data, in a small localStorage journal, synchronously,
 * and made the next time the client starts if it was not finished. Which
 * tab made each change, and how many it had made, is kept beside every
 * value in the same transaction, so a change found written down is made
 * once: never again after it was made, even when it was another open tab's
 * change still being finished and that tab has made newer ones since. Other
 * tabs are told of each change over a BroadcastChannel.
 *
 * IndexedDB ownership does not depend on BroadcastChannel. Opening failure
 * is unreadability, never an empty alternative store; later calls may retry.
 * Browsers without IndexedDB can use localStorage only until this profile
 * has used IndexedDB. Old fallback drafts/outbox are reconciled rather than
 * discarded. Other conflicting legacy copies remain until an explicit set.
 */

/** One change to one key, as data, so it can be written down and made again. */
export type StoreOp =
  | { kind: "set"; value: unknown }
  | { kind: "initialize"; value: unknown }
  | { kind: "outbox"; changes: OutboxChanges; enveloped: boolean }
  | { kind: "drafts"; changes: DraftChanges; enveloped: boolean }
  | { kind: "record"; changes: RecordChanges }
  | { kind: "trust"; address: string }
  | { kind: "signIns"; change: SignInChange };

/** What an op gives back when it was made already: what is stored now, read as it would read it. */
function resultNow(stored: unknown, op: StoreOp): unknown {
  switch (op.kind) {
    case "set":
      return undefined;
    case "initialize":
      return stored ?? null;
    case "outbox":
      return applyOutboxChanges(stored, { put: [], remove: [] }, op.enveloped).outbox;
    case "drafts":
      return applyDraftChanges(stored, { put: {}, remove: [] }, op.enveloped).drafts;
    case "record":
      return applyRecordChanges(stored, {});
    case "trust":
      return readTrustedAddresses(stored);
    case "signIns":
      return readSavedServers(stored);
  }
}

/** What an op makes of the stored value, and what its caller is given back. */
export function applyOp(stored: unknown, op: StoreOp): { value: unknown; result: unknown } {
  switch (op.kind) {
    case "set":
      return { value: op.value ?? null, result: undefined };
    case "initialize": {
      const now = stored ?? op.value ?? null;
      return { value: now, result: now };
    }
    case "outbox": {
      const { value, outbox } = applyOutboxChanges(stored, op.changes, op.enveloped);
      return { value, result: outbox };
    }
    case "drafts": {
      const { value, drafts } = applyDraftChanges(stored, op.changes, op.enveloped);
      return { value, result: drafts };
    }
    case "record": {
      const value = applyRecordChanges(stored, op.changes);
      return { value, result: value };
    }
    case "trust": {
      // Never throws: a change that did would stay written down and stop
      // every later start from making the ones after it.
      const { value, addresses } = addTrustedAddress(stored, op.address);
      return { value, result: addresses };
    }
    case "signIns": {
      // Never throws either. Sign-ins it cannot read stay as they are, and
      // the answer is null: a change to one must not wipe out the others.
      const servers = readSavedServers(stored);
      if (!servers) return { value: stored, result: null };
      const next = changeSavedServers(servers, op.change);
      return { value: next, result: next };
    }
  }
}

/**
 * Saved sign-ins whose text cannot be read stay as they are, and a change to
 * them is answered null, rather than read as none and written over. Every
 * other op's merge replaces text it cannot read.
 */
function keepsText(raw: string | null, op: StoreOp): boolean {
  if (op.kind !== "signIns" || raw === null) return false;
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

/** What an op makes of the text stored now: the text to store then, and its answer. */
function applyToText(raw: string | null, op: StoreOp): { next: string; result: unknown } {
  if (raw !== null && keepsText(raw, op)) return { next: raw, result: null };
  const { value, result } = applyOp(parsed(raw), op);
  return { next: JSON.stringify(value), result };
}

/** Where each value lived before IndexedDB, and still does without it. */
export const LEGACY_PREFIX = "ownbase:";
/** Changes written down before they are made. */
export const JOURNAL_PREFIX = "ownbase-journal:";
/** Backend ownership survives reloads and capability changes. */
export const OWNER_KEY = "ownbase-device-owner";
/** Invalidation only, without putting stored content in another transport. */
export const CHANGE_KEY = "ownbase-device-changed";
/** The IndexedDB database holding what this device saved. */
const DATABASE = "ownbase-device";
const VALUES = "values";
/** For each key, the last change each tab made to it: `{ [tab]: [seq, at] }`. */
const MADE = "made";
/** How long a tab's last change to a key is remembered once it has made no other. */
const MADE_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
const CHANNEL = "ownbase-device";

/** A stored value from its text; unreadable text is no value, which a merge replaces. */
function parsed(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** What a watcher is told: the value, or the text itself when it cannot be read. */
function told(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Which tab asked for a change, and the how-manyth of its changes it is. */
interface Origin {
  tab: string;
  seq: number;
}

interface Backend {
  kind: "indexeddb" | "localstorage";
  /** The stored text, or null when nothing is stored. */
  read(key: string): Promise<string | null>;
  /**
   * Makes one change in one step, unless `origin` says it was made already,
   * and gives back the text now stored, the op's result, and whether it made it.
   */
  apply(
    key: string,
    op: StoreOp,
    origin: Origin,
  ): Promise<{ raw: string; result: unknown; made: boolean }>;
}

function localBackend(): Backend {
  const checkOwner = () => {
    if (localStorage.getItem(OWNER_KEY) !== "localstorage")
      throw new Error("The saved device storage is unavailable. Please try again.");
  };
  return {
    kind: "localstorage",
    read: async (key) => {
      checkOwner();
      return localStorage.getItem(LEGACY_PREFIX + key);
    },
    // Read, merged and written with nothing awaited between, so nothing in
    // this tab comes between; and at once, so a closing page still writes it.
    apply: async (key, op) => {
      checkOwner();
      const name = LEGACY_PREFIX + key;
      const raw = localStorage.getItem(name);
      const { next, result } = applyToText(raw, op);
      if (next !== raw) localStorage.setItem(name, next);
      return { raw: next, result, made: true };
    },
  };
}

/** How long opening may take before reporting unreadability. */
const OPEN_TIMEOUT_MS = 5_000;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let late = false;
    // Some browsers have been known never to answer; a client that waits for
    // its storage forever never starts.
    const timer = setTimeout(() => {
      late = true;
      reject(new Error("The device storage did not open."));
    }, OPEN_TIMEOUT_MS);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE, 2);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      for (const name of [VALUES, MADE])
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      if (late || !db.objectStoreNames.contains(VALUES) || !db.objectStoreNames.contains(MADE)) {
        db.close();
        return reject(new Error("The device storage cannot be used."));
      }
      // A newer client upgrading the database in another tab goes first.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
    request.onblocked = () => {
      late = true;
      clearTimeout(timer);
      reject(new Error("The device storage is in use by an older tab."));
    };
  });
}

function forgetLegacy(key: string, raw: string) {
  try {
    // A still-open older client may have written again during this transaction.
    if (localStorage.getItem(LEGACY_PREFIX + key) === raw)
      localStorage.removeItem(LEGACY_PREFIX + key);
  } catch {
    // Nothing to forget.
  }
}

/** Recover old fallback work without overwriting the database's newer work. */
function reconcileLegacy(key: string, raw: string, legacy: string): string | null {
  try {
    const stored: unknown = JSON.parse(raw);
    const earlier: unknown = JSON.parse(legacy);
    const enveloped = key.startsWith("local:v1:");
    const kind = enveloped ? key.split(":")[4] : key.split(":")[0];
    if (kind === "drafts") {
      const current = unwrapStoredDrafts(stored, enveloped);
      const drafts = unwrapStoredDrafts(earlier, enveloped);
      if (!current || !drafts) return null;
      return JSON.stringify(
        applyDraftChanges(
          stored,
          {
            put: drafts,
            remove: [],
            base: Object.fromEntries(Object.keys(drafts).map((k) => [k, null])),
          },
          enveloped,
        ).value,
      );
    }
    if (kind === "outbox") {
      const current = unwrapStoredOutbox(stored, enveloped);
      const recovered = unwrapStoredOutbox(earlier, enveloped);
      if (!current || !recovered) return null;
      const baseline = {
        ...current,
        compactedThrough: Math.max(current.compactedThrough ?? 0, recovered.compactedThrough ?? 0),
      };
      return JSON.stringify(
        applyOutboxChanges(
          enveloped ? { version: 1, value: baseline } : baseline,
          { put: recovered.entries, remove: recovered.removed },
          enveloped,
        ).value,
      );
    }
    if (
      key === "notification-previews" &&
      stored &&
      earlier &&
      typeof stored === "object" &&
      typeof earlier === "object" &&
      !Array.isArray(stored) &&
      !Array.isArray(earlier)
    ) {
      const ranks: Record<string, number> = { none: 0, sender: 1, full: 2 };
      const next = { ...stored } as Record<string, unknown>;
      for (const [account, choice] of Object.entries(earlier)) {
        const mine = next[account];
        if (mine === undefined || (ranks[String(choice)] ?? 0) < (ranks[String(mine)] ?? 0))
          next[account] = choice;
      }
      return JSON.stringify(next);
    }
  } catch {
    // Unrecognized copies remain recoverable; they cannot replace known data.
  }
  return null;
}

function indexedBackend(db: IDBDatabase): Backend {
  /**
   * One readwrite transaction; settles when it has committed, or failed.
   * `moved` names keys whose localStorage value it brought across, forgotten
   * there once it has.
   */
  const transaction = <T>(
    work: (
      values: IDBObjectStore,
      done: (result: T) => void,
      moved: Map<string, string>,
      made: IDBObjectStore,
    ) => void,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      let result: { value: T } | null = null;
      const moved = new Map<string, string>();
      const tx = db.transaction([VALUES, MADE], "readwrite");
      tx.oncomplete = () => {
        for (const [key, raw] of moved) forgetLegacy(key, raw);
        if (result) resolve(result.value);
        else reject(new Error("The device storage did not answer."));
      };
      tx.onerror = () => reject(tx.error ?? new Error("The device storage refused the change."));
      tx.onabort = () => reject(tx.error ?? new Error("The device storage refused the change."));
      try {
        work(tx.objectStore(VALUES), (value) => (result = { value }), moved, tx.objectStore(MADE));
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  /**
   * The stored text, bringing across what localStorage held for the key the
   * first time it is met, inside the same transaction.
   */
  const current = (
    values: IDBObjectStore,
    key: string,
    moved: Map<string, string>,
    then: (raw: string | null) => void,
  ) => {
    const request = values.get(key);
    request.onsuccess = () => {
      let legacy: string | null = null;
      try {
        legacy = localStorage.getItem(LEGACY_PREFIX + key);
      } catch {
        // Nothing to bring across.
      }
      if (typeof request.result === "string") {
        if (legacy !== null) {
          const recovered =
            legacy === request.result ? legacy : reconcileLegacy(key, request.result, legacy);
          if (recovered !== null) {
            if (recovered !== request.result) values.put(recovered, key);
            moved.set(key, legacy);
            return then(recovered);
          }
        }
        return then(request.result);
      }
      if (legacy !== null) {
        values.put(legacy, key);
        moved.set(key, legacy);
      }
      then(legacy);
    };
  };
  return {
    kind: "indexeddb",
    read: (key) =>
      transaction<string | null>((values, done, moved) => current(values, key, moved, done)),
    apply: (key, op, origin) =>
      transaction((values, done, moved, made) =>
        current(values, key, moved, (raw) => {
          const request = made.get(key);
          request.onsuccess = () => {
            const now = Date.now();
            const record: Record<string, [seq: number, at: number]> =
              request.result && typeof request.result === "object" ? request.result : {};
            const last = record[origin.tab];
            if (Array.isArray(last) && last[0] >= origin.seq) {
              // Made already: by this tab, or by one that took it up from the journal.
              return done({
                raw: raw ?? "null",
                result: keepsText(raw, op) ? null : resultNow(parsed(raw), op),
                made: false,
              });
            }
            const { next, result } = applyToText(raw, op);
            if (op.kind === "set") {
              // Explicit replacement/forgetting also retires a conflicting copy.
              try {
                const legacy = localStorage.getItem(LEGACY_PREFIX + key);
                if (legacy !== null) moved.set(key, legacy);
              } catch {
                /* No accessible legacy copy. */
              }
            }
            // Written even when empty, so an emptied key is never filled again
            // from what localStorage held before.
            if (next !== raw) values.put(next, key);
            record[origin.tab] = [origin.seq, now];
            // An acknowledged operation may still be journaled if retiring
            // its localStorage entry failed. Its deduplication must outlive
            // that copy, or replay could restore a forgotten sign-in.
            let unfinished: Set<string> | null = null;
            try {
              unfinished = new Set(
                Object.keys(localStorage)
                  .filter((name) => name.startsWith(JOURNAL_PREFIX))
                  .map((name) => name.slice(JOURNAL_PREFIX.length).split(":")[0]!),
              );
            } catch {
              /* Keep origins if the journal cannot be inspected. */
            }
            for (const [tab, [, at]] of Object.entries(record))
              if (now - at > MADE_KEPT_MS && unfinished && !unfinished.has(tab)) delete record[tab];
            made.put(record, key);
            done({ raw: next, result, made: true });
          };
        }),
      ),
  };
}

interface JournalEntry {
  key: string;
  op: StoreOp;
  at: number;
  seq: number;
  /** The tab that asked for it. */
  tab: string;
}

function validOp(op: unknown): op is StoreOp {
  if (!op || typeof op !== "object" || !("kind" in op)) return false;
  switch (op.kind) {
    case "set":
    case "initialize":
      return "value" in op;
    case "drafts":
      return (
        "changes" in op &&
        isDraftChanges(op.changes) &&
        "enveloped" in op &&
        typeof op.enveloped === "boolean"
      );
    case "outbox": {
      const changes = "changes" in op ? (op.changes as Partial<OutboxChanges> | null) : null;
      return (
        !!changes &&
        typeof changes === "object" &&
        readStoredOutbox({ outbox: 2, entries: changes.put, removed: changes.remove }) !== null &&
        "enveloped" in op &&
        typeof op.enveloped === "boolean"
      );
    }
    case "record":
      return "changes" in op && isRecordChanges(op.changes);
    case "trust":
      return "address" in op && typeof op.address === "string";
    case "signIns":
      return "change" in op && isSignInChange(op.change);
    default:
      return false;
  }
}

/** The journal's entries, oldest first, by their localStorage names. */
function journalEntries(): [name: string, entry: JournalEntry][] {
  const found: [string, JournalEntry][] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (!name?.startsWith(JOURNAL_PREFIX)) continue;
      try {
        const entry = JSON.parse(localStorage.getItem(name) ?? "null") as JournalEntry | null;
        // Named `<tab>:<seq>`, which says whose change it is should it not.
        const [tab] = name.slice(JOURNAL_PREFIX.length).split(":");
        if (
          entry &&
          typeof entry.key === "string" &&
          validOp(entry.op) &&
          Number.isSafeInteger(entry.seq) &&
          entry.seq > 0 &&
          Number.isFinite(entry.at)
        )
          found.push([name, { ...entry, tab: typeof entry.tab === "string" ? entry.tab : tab! }]);
        else localStorage.removeItem(name);
      } catch {
        localStorage.removeItem(name);
      }
    }
  } catch {
    // No localStorage: nothing was written down.
  }
  return found.sort(([, a], [, b]) => a.at - b.at || a.seq - b.seq);
}

export interface DeviceStore {
  /** Which storage this device ended up with. */
  readonly backend: Promise<"indexeddb" | "localstorage">;
  /** The stored text under `key`, or null; rejects when storage cannot be read. */
  read(key: string): Promise<string | null>;
  /** Makes one change, acknowledged once stored, and gives back its result. */
  apply(key: string, op: StoreOp): Promise<unknown>;
  /** Calls back with what another tab stored under `key`, each time it does. */
  watch(key: string, cb: (stored: unknown) => void): () => void;
}

/** The web client's device storage; see the note at the top of this file. */
export function deviceStore(options: { tab?: string } = {}): DeviceStore {
  // Named afresh for every page; a test may name one to stand for a tab already met.
  const tab = options.tab ?? Math.random().toString(36).slice(2, 10);
  let seq = 0;
  const canIndex = typeof indexedDB !== "undefined";
  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel === "function") channel = new BroadcastChannel(CHANNEL);
  } catch {
    // Ownership stays in IndexedDB; storage invalidations can notify instead.
  }
  // Known at once without IndexedDB, so each write still happens within the
  // call that asks for it, as a closing page needs.
  let backend: Backend | null = canIndex ? null : localBackend();
  let pending: Promise<Backend> | null = null;
  const notify = (key: string, raw: string) => {
    try {
      if (channel) {
        channel.postMessage({ key, raw });
        return;
      }
    } catch {
      /* A failed notification does not undo an acknowledged write. */
    }
    try {
      localStorage.setItem(CHANGE_KEY, JSON.stringify({ key, tab, seq: ++seq }));
    } catch {
      // Watchers also refresh on focus; no private content is mirrored here.
    }
  };
  // Changes a closing page left unfinished are made before any other here.
  // One another open tab is still making is made once all the same, by
  // whichever of the two comes first.
  const ready = (): Promise<Backend> => {
    if (pending) return pending;
    pending = (async () => {
      if (canIndex) {
        // Even a refused/blocked open does not authorize an alternate backend.
        if (localStorage.getItem(OWNER_KEY) !== "indexeddb")
          localStorage.setItem(OWNER_KEY, "indexeddb");
      }
      const chosen = canIndex ? indexedBackend(await openDatabase()) : backend!;
      if (!canIndex) {
        const owner = localStorage.getItem(OWNER_KEY);
        if (owner !== null && owner !== "localstorage")
          throw new Error("The saved device storage is unavailable. Please try again.");
        if (owner !== "localstorage") localStorage.setItem(OWNER_KEY, "localstorage");
      }
      for (const [name, entry] of journalEntries()) {
        // A failure stops replay before newer sequences can suppress older work.
        // Nothing expires merely because storage remained unavailable.
        const { raw, made } = await chosen.apply(entry.key, entry.op, entry);
        if (made && chosen.kind === "indexeddb") notify(entry.key, raw);
        crossOut(name);
      }
      backend = chosen;
      return chosen;
    })().catch((error) => {
      pending = null;
      if (canIndex) backend = null;
      throw error;
    });
    return pending;
  };

  /** Written down at once, while it may be the last thing a closing page does. */
  const writeDown = (key: string, op: StoreOp, origin: Origin): string | null => {
    if (backend?.kind === "localstorage") return null;
    const name = `${JOURNAL_PREFIX}${tab}:${origin.seq}`;
    try {
      localStorage.setItem(name, JSON.stringify({ key, op, at: Date.now(), ...origin }));
      return name;
    } catch {
      // No room to write it down: it is still made, only not again after a crash.
      return null;
    }
  };
  const crossOut = (name: string | null) => {
    if (!name) return;
    try {
      localStorage.removeItem(name);
    } catch {
      // Made again next time, which changes nothing.
    }
  };

  const unavailable = () => {
    if (canIndex) {
      backend = null;
      pending = null;
    }
  };
  const initial = ready().then((chosen) => chosen.kind);
  // Most callers only use read/apply; exposing backend must not create an
  // unhandled rejection when their strict read correctly handles the failure.
  void initial.catch(() => {});
  return {
    backend: initial,
    read: async (key) => {
      try {
        return await (backend ?? (await ready())).read(key);
      } catch (error) {
        unavailable();
        throw error;
      }
    },
    apply: async (key, op) => {
      const origin = { tab, seq: ++seq };
      const name = writeDown(key, op, origin);
      try {
        const chosen = backend ?? (await ready());
        const { raw, result, made } = await chosen.apply(key, op, origin);
        crossOut(name);
        if (made && chosen.kind === "indexeddb") notify(key, raw);
        return result;
      } catch (error) {
        unavailable();
        // Keep the journaled operation for recovery; this write was not acknowledged.
        throw error;
      }
    },
    watch: (key, cb) => {
      let alive = true;
      let generation = 0;
      const fromTab = (event: MessageEvent<{ key: string; raw: string }>) => {
        if (event.data?.key === key) {
          generation++;
          cb(told(event.data.raw));
        }
      };
      const refresh = () => {
        const ticket = ++generation;
        void (backend ? Promise.resolve(backend) : ready())
          .then((chosen) => chosen.read(key))
          .then((raw) => {
            if (alive && ticket === generation) cb(told(raw));
          })
          .catch(() => {});
      };
      // Without BroadcastChannel, storage events carry invalidations only.
      const fromStorage = (event: StorageEvent) => {
        if (event.storageArea !== localStorage) return;
        if (
          event.key === OWNER_KEY &&
          backend?.kind === "localstorage" &&
          event.newValue !== "localstorage"
        ) {
          generation++;
          cb("The saved device storage is unavailable.");
          return;
        }
        if (event.key === CHANGE_KEY) {
          try {
            if (JSON.parse(event.newValue ?? "null")?.key === key) refresh();
          } catch {
            /* Ignore unrelated malformed notices. */
          }
          return;
        }
        if (backend?.kind !== "localstorage") return;
        if (event.key !== LEGACY_PREFIX + key) return;
        try {
          if (localStorage.getItem(OWNER_KEY) !== "localstorage") {
            generation++;
            cb("The saved device storage is unavailable.");
            return;
          }
        } catch {
          generation++;
          cb("The saved device storage is unavailable.");
          return;
        }
        // Left as text when unreadable, which nothing reads as its value.
        cb(told(event.newValue));
      };
      channel?.addEventListener("message", fromTab);
      window.addEventListener("storage", fromStorage);
      window.addEventListener("focus", refresh);
      return () => {
        alive = false;
        generation++;
        channel?.removeEventListener("message", fromTab);
        window.removeEventListener("storage", fromStorage);
        window.removeEventListener("focus", refresh);
      };
    },
  };
}
