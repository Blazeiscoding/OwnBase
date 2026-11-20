import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LastHosted } from "@ownbase/protocol/desktop";
import type { readStoppedWorkspace } from "@ownbase/server/stoppedWorkspace";
import {
  REGISTRY_KEY,
  adoptFolders,
  legacyFolder,
  parseRegistry,
  serializeRegistry,
  type HostedWorkspace,
} from "./registry.js";

/**
 * What earlier versions remembered as hosted last, and what this one still
 * writes for them. They reopen by name, so it names a workspace only when an
 * earlier version would find that workspace's folder from it.
 */
export type LegacyLastHosted = Omit<LastHosted, "folder">;

/**
 * Reads an earlier version's remembered workspace, refusing anything
 * malformed rather than starting hosting under a name or port nobody chose.
 */
export function parseLastHosted(value: unknown): LegacyLastHosted | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { workspaceName, port } = value as Record<string, unknown>;
  if (
    typeof workspaceName !== "string" ||
    !workspaceName.trim() ||
    workspaceName.trim().length > 80
  )
    return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) return null;
  return { workspaceName: workspaceName.trim(), port };
}

/**
 * What earlier versions are told they hosted last. They reopen by name, so
 * it names the entry only when that name leads them to the entry's folder.
 */
export function legacyPointer(entry: HostedWorkspace | undefined): LegacyLastHosted | null {
  return entry && entry.folder === legacyFolder(entry.name)
    ? { workspaceName: entry.name, port: entry.port }
    : null;
}

/** The entry started most recently, which the resume offer names. */
export function mostRecent(entries: HostedWorkspace[]): HostedWorkspace | null {
  return entries.reduce<HostedWorkspace | null>(
    (best, entry) => (!best || entry.lastHostedAt > best.lastHostedAt ? entry : best),
    null,
  );
}

/** What a listed workspace's folder holds now, as `folderHolds` reads it. */
export type FolderHolds =
  | { holds: "nothing" }
  | { holds: "unreadable" }
  | { holds: "another"; name: string | null }
  | { holds: "it"; id: string | null };

export type HostedList = ReturnType<typeof createHostedList>;

/**
 * The list of workspaces hosted on this computer, held in memory and kept in
 * the settings file. Callers take their turn in the controller's queue.
 */
export function createHostedList(options: {
  settings: {
    get(
      key: string,
      options?: { strict?: boolean; distinguishMissing?: boolean },
    ): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  dataRoot: string;
  defaultPort: number;
  now: () => number;
  read: typeof readStoppedWorkspace;
  changed(): void;
}) {
  const { now, read, changed } = options;
  /** Every workspace hosted here, once read. Null until then, or while it cannot be. */
  let registry: HostedWorkspace[] | null = null;
  let registryLoad: Promise<HostedWorkspace[]> | null = null;
  /** Folders adoption could not read, named until the registry is read again. */
  let unreadableFolders: string[] = [];
  /** Said in the status while the list in memory has changes the settings file lacks. */
  let registryUnsaved: string | undefined;

  /**
   * Reads the list of hosted workspaces once, adopting any folder it does not
   * name. Nothing can start before this finishes, so adoption never opens a
   * database a running server has open. A settings file that cannot be read
   * is not taken as an empty list, and is tried again next time.
   */
  function loadRegistry(): Promise<HostedWorkspace[]> {
    if (registry) return Promise.resolve(registry);
    registryLoad ??= (async () => {
      const stored = await options.settings.get(REGISTRY_KEY, {
        strict: true,
        distinguishMissing: true,
      });
      const known = parseRegistry(stored);
      // Only the first start of this version converts what earlier ones kept.
      const legacy =
        stored === undefined
          ? parseLastHosted(await options.settings.get("lastHosted").catch(() => null))
          : null;
      const { adopted, unreadable } = await adoptFolders({
        dataRoot: options.dataRoot,
        known,
        lastHosted: legacy,
        defaultPort: options.defaultPort,
        now: now(),
        read,
      });
      unreadableFolders = unreadable;
      registry = [...known, ...adopted];
      if (adopted.length > 0) await keepRegistry();
      return registry;
    })().finally(() => {
      registryLoad = null;
    });
    return registryLoad;
  }

  async function saveRegistry(): Promise<void> {
    await options.settings.set(REGISTRY_KEY, serializeRegistry(registry ?? []));
    if (registryUnsaved) {
      registryUnsaved = undefined;
      changed();
    }
  }

  /**
   * Saves the list where what is in memory is already the truth: the work it
   * records is done. A failure is said in the status until a later save
   * succeeds, which writes the whole list, so the file catches up.
   */
  async function keepRegistry(): Promise<boolean> {
    try {
      await saveRegistry();
      return true;
    } catch {
      registryUnsaved =
        "OwnBase could not save its list of hosted workspaces, so it may be out of date after a restart. Check that its settings folder is writable.";
      changed();
      return false;
    }
  }

  function updateEntry(folder: string, change: Partial<HostedWorkspace>): void {
    registry = (registry ?? []).map((entry) =>
      entry.folder === folder ? { ...entry, ...change } : entry,
    );
  }

  function dataDirOf(entry: HostedWorkspace): string {
    return join(options.dataRoot, entry.folder);
  }

  /** The entry for `folder` in `list`; the window names a listed workspace, never a path. */
  function entryIn(list: HostedWorkspace[], folder: string): HostedWorkspace {
    const entry = list.find((e) => e.folder === folder);
    if (!entry) throw new Error("That workspace is not in the list hosted on this computer.");
    return entry;
  }

  async function listedEntry(folder: string): Promise<HostedWorkspace> {
    return entryIn(await loadRegistry(), folder);
  }

  /**
   * What a listed workspace's folder holds now, read without starting it: a
   * folder copied or swapped by hand can hold some other workspace. An entry
   * adopted before its first start has no id yet, so whatever is there is it.
   */
  function folderHolds(entry: HostedWorkspace): FolderHolds {
    const dataDir = dataDirOf(entry);
    if (!existsSync(dataDir)) return { holds: "nothing" };
    const inside = read(dataDir);
    if (!inside) return { holds: "unreadable" };
    if (entry.id && inside.id !== entry.id) return { holds: "another", name: inside.name };
    return { holds: "it", id: inside.id };
  }

  return {
    /** The list as last read or changed, or null before it has been read. */
    current: () => registry,
    /** Puts `list` in place of the one in memory, as a change or to undo one. */
    replace(list: HostedWorkspace[]): void {
      registry = list;
    },
    load: loadRegistry,
    save: saveRegistry,
    keep: keepRegistry,
    update: updateEntry,
    dataDirOf,
    entryIn,
    listed: listedEntry,
    folderHolds,
    unreadable: () => unreadableFolders,
    unsaved: () => registryUnsaved,
  };
}
