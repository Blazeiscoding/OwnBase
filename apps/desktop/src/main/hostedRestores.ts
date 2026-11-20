import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { WORKSPACE_NAME_MAX } from "@ownbase/protocol";
import type { RestoredOver, RestoredWorkspace, RestoreInventory } from "@ownbase/protocol/desktop";
import { BACKUP_NAME, megabytes, type HostedBackups } from "./hostedBackups.js";
import type { HostedList } from "./hostedList.js";
import type { HostingOptions } from "./hosting.js";
import { START_ON_LAUNCH_KEY, type HostingLaunch } from "./hostingLaunch.js";
import { newFolder, type HostedWorkspace } from "./registry.js";

export type HostedRestores = ReturnType<typeof createHostedRestores>;

/**
 * Restores a backup as a workspace hosted here, as a new one or over one
 * still on this computer, held until it is put back in use. Every restore
 * takes its turn in the controller's queue.
 */
export function createHostedRestores(
  options: Pick<
    HostingOptions,
    | "settings"
    | "verifyBackup"
    | "inventoryBackup"
    | "restoreWorkspace"
    | "freeBytes"
    | "dataRoot"
    | "defaultPort"
  > & {
    hosted: HostedList;
    launch: Pick<HostingLaunch, "readLaunchFolder" | "rememberLaunchFolder">;
    ownBackups: HostedBackups["ownBackups"];
    /** Whether the workspace in `folder` is the one running. */
    isRunning(folder: string): boolean;
    serialized<T>(operation: () => Promise<T>): Promise<T>;
    refuseWhileQuitting(): void;
    changed(): void;
    now: () => number;
    read: HostingOptions["stopped"]["read"];
  },
) {
  const { hosted, launch, ownBackups, serialized, refuseWhileQuitting, changed, now, read } =
    options;

  /** Refuses a restore the disk has no room for: it is staged beside its folder and checked first. */
  async function roomToRestore(manifest: {
    database: { bytes: number };
    files: { bytes: number }[];
  }): Promise<void> {
    const size = manifest.database.bytes + manifest.files.reduce((n, f) => n + f.bytes, 0);
    const needed = Math.ceil(size * 1.1) + 16 * 1024 * 1024;
    const free = await options.freeBytes(options.dataRoot);
    if (free < needed)
      throw new Error(
        `There is not enough free space for it. Restoring needs about ${megabytes(needed)}, and ${megabytes(free)} is free.`,
      );
  }

  /**
   * Restores `source` into `held`'s folder. The copy is listed and held, and
   * taken off starting with OwnBase, before anything is restored, as a new
   * workspace is listed before it starts: a restored one can always be found,
   * even after a restart, and never starts by itself as though nothing had
   * happened, here or in an earlier version that knows nothing of the hold.
   * When the restore fails and `undo` says nothing changed in the folder,
   * the list and that choice go back to how they were.
   */
  async function restoreHeld(request: {
    list: HostedWorkspace[];
    held: HostedWorkspace;
    source: string;
    workspaceName: string;
    undo: () => boolean;
  }): Promise<{ name: string; inventory: RestoreInventory | null; restored: unknown }> {
    const { list, held } = request;
    const unsaved = () =>
      new Error(
        "OwnBase could not save its settings, so it did not restore the backup. Check that its settings folder is writable, then try again.",
      );
    hosted.replace(
      list.some((e) => e.folder === held.folder)
        ? list.map((e) => (e.folder === held.folder ? held : e))
        : [...list, held],
    );
    try {
      await hosted.save();
    } catch {
      hosted.replace(list);
      throw unsaved();
    }
    const wasLaunch = (await launch.readLaunchFolder().catch(() => null)) === held.folder;
    if (wasLaunch) {
      try {
        await options.settings.set(START_ON_LAUNCH_KEY, null);
      } catch {
        hosted.replace(list);
        await hosted.keep();
        throw unsaved();
      }
      launch.rememberLaunchFolder(null);
    }
    let restored: unknown;
    try {
      restored = await options.restoreWorkspace({
        backupDir: request.source,
        dataDir: hosted.dataDirOf(held),
      });
    } catch (error) {
      if (request.undo()) {
        hosted.replace(list);
        await hosted.keep();
        if (wasLaunch)
          await options.settings.set(START_ON_LAUNCH_KEY, held.folder).then(
            () => launch.rememberLaunchFolder(held.folder),
            () => {},
          );
      }
      throw error;
    }
    const name = request.workspaceName.trim().slice(0, WORKSPACE_NAME_MAX) || held.name;
    hosted.update(held.folder, { name });
    await hosted.keep();
    const inventory = await options.inventoryBackup(request.source).catch(() => null);
    changed();
    return { name, inventory, restored };
  }

  /**
   * Restores a backup as a workspace hosted here, without starting it. A
   * workspace this computer does not list gets a new folder. One it lists
   * whose folder is gone comes back into that folder. One still here is left
   * alone: replacing it is a separate, confirmed step (`restoreOver`).
   */
  function restore(value: unknown): Promise<RestoredWorkspace> {
    const { backupDir } = (value ?? {}) as Record<string, unknown>;
    if (typeof backupDir !== "string" || !isAbsolute(backupDir))
      return Promise.reject(new Error("Choose the folder of a backup to restore."));
    return serialized(async () => {
      refuseWhileQuitting();
      const list = await hosted.load();
      const manifest = await options.verifyBackup(backupDir);
      const id = read(backupDir)?.id ?? null;
      const listed = id ? list.find((e) => e.id === id) : undefined;
      if (listed && existsSync(hosted.dataDirOf(listed)))
        throw new Error(
          `${listed.name} is already hosted on this computer, so this backup was not restored over it.`,
        );
      await mkdir(options.dataRoot, { recursive: true });
      await roomToRestore(manifest);
      const entry: HostedWorkspace = {
        ...(listed ?? {
          id,
          folder: newFolder(),
          name: manifest.workspaceName.trim().slice(0, WORKSPACE_NAME_MAX) || "Restored workspace",
          port: options.defaultPort,
          lastHostedAt: now(),
        }),
        // Held until someone puts it back in use, across restarts too.
        restoredHold: now(),
      };
      const { name, inventory } = await restoreHeld({
        list,
        held: entry,
        source: backupDir,
        workspaceName: manifest.workspaceName,
        // Nothing arrived, so everything goes back to how it was. Anything
        // that did arrive stays listed and held.
        undo: () => !existsSync(hosted.dataDirOf(entry)),
      });
      return { folder: entry.folder, name, inventory };
    });
  }

  /**
   * Puts an earlier copy of a stopped workspace in its place: one of its
   * backups from `listBackups`, by name, or a backup's folder chosen in the
   * system's dialog. It must be a copy of this same workspace. What the
   * workspace holds now is moved aside beside its folder, never deleted, and
   * the copy is held, as any restored one is, until it is put back in use.
   */
  function restoreOver(value: unknown): Promise<RestoredOver> {
    const { folder, backup, backupDir } = (value ?? {}) as Record<string, unknown>;
    if (typeof folder !== "string")
      return Promise.reject(new Error("Choose a workspace to restore."));
    if (
      (backup === undefined) === (backupDir === undefined) ||
      (backup !== undefined && (typeof backup !== "string" || !BACKUP_NAME.test(backup))) ||
      (backupDir !== undefined && (typeof backupDir !== "string" || !isAbsolute(backupDir)))
    )
      return Promise.reject(new Error("Choose one backup to restore."));
    return serialized(async () => {
      refuseWhileQuitting();
      const list = await hosted.load();
      const listed = hosted.entryIn(list, folder);
      if (options.isRunning(listed.folder))
        throw new Error(`Stop hosting ${listed.name} before restoring an earlier copy over it.`);
      const dataDir = hosted.dataDirOf(listed);
      if (!existsSync(dataDir))
        throw new Error(
          `The folder that held ${listed.name} is missing. Restore from a backup brings it back into it.`,
        );
      let source: string;
      if (typeof backup === "string") {
        const destination = listed.autoBackup?.destination;
        // Only a backup listed for this workspace, found again now.
        const there =
          destination && existsSync(destination)
            ? await ownBackups(listed, destination).catch(() => [])
            : [];
        const chosen = there.find((b) => b.name === backup);
        if (!chosen) throw new Error("That backup is no longer in the backup folder.");
        source = chosen.path;
      } else {
        source = backupDir as string;
      }
      const manifest = await options.verifyBackup(source);
      if (!listed.id || read(source)?.id !== listed.id)
        throw new Error(
          `That backup is of a different workspace, so it was not restored over ${listed.name}.`,
        );
      await roomToRestore(manifest);
      const { name, inventory, restored } = await restoreHeld({
        list,
        held: { ...listed, restoredHold: now() },
        source,
        workspaceName: manifest.workspaceName,
        // The server's restore puts what was there back before it fails, so
        // the workspace is as it was; so is its place in the list.
        undo: () => true,
      });
      const aside = (restored as { supersededDir?: unknown } | null)?.supersededDir;
      return {
        folder: listed.folder,
        name,
        setAside: typeof aside === "string" ? aside : null,
        inventory,
      };
    });
  }

  return { restore, restoreOver };
}
