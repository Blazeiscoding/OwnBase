import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { HostedBackup } from "@ownbase/protocol/desktop";
import {
  backupFolderName,
  backupRetryDelay,
  listScheduledBackups,
  nextBackupAt,
  pruneBackups,
} from "@ownbase/server/backupSchedule";
import type { HostedList } from "./hostedList.js";
import type { HostingOptions } from "./hosting.js";
import {
  legacyFolder,
  parseAutoBackup,
  type AutoBackup,
  type BackupFailure,
  type BackupFailureKind,
  type HostedWorkspace,
} from "./registry.js";

/** A scheduled backup whose last try did not finish, for the tray to say so (OPS-02). */
export interface BackupAttention {
  folder: string;
  name: string;
  /** What the window says of it. */
  note: string;
  /** Whether trying again would make a backup: not when one was made and only removing older ones failed. */
  canRetry: boolean;
}

/** Everything under a folder, counted by size. Files that vanish while counting are skipped. */
async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await folderBytes(path);
    else if (entry.isFile())
      total += await stat(path).then(
        (info) => info.size,
        () => 0,
      );
  }
  return total;
}

export function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/** A backup that did not finish, for a reason someone can act on. */
class BackupFailed extends Error {
  constructor(
    readonly kind: BackupFailureKind,
    message: string,
  ) {
    super(message);
  }
}

/** What kind of failure an error from a backup is, as far as it says. */
function failureKind(error: unknown): BackupFailureKind {
  if (error instanceof BackupFailed) return error.kind;
  // A full disk can be found only partway through the copy, in the worker.
  const said = `${(error as { code?: unknown } | null)?.code ?? ""} ${
    error instanceof Error ? error.message : ""
  }`;
  return /\b(ENOSPC|EDQUOT)\b/.test(said) ? "space" : "other";
}

/** What the window says of a scheduled backup that did not finish, until one does. */
export function backupFailureNote(name: string, failure: BackupFailure | undefined): string | null {
  if (!failure) return null;
  return (
    failure.kind === "cleanup"
      ? `The scheduled backup of ${name} was made, but older ones there could not be removed. ${failure.message}`
      : `The scheduled backup of ${name} did not finish. ${failure.message}`
  ).trim();
}

export type HostedBackups = ReturnType<typeof createHostedBackups>;

/**
 * Backs up hosted workspaces, when asked and on their schedules, and finds
 * the backups a schedule keeps. Every copy takes its turn in the
 * controller's queue.
 */
export function createHostedBackups(
  options: Pick<HostingOptions, "backupWorkspace" | "freeBytes" | "verifyBackup"> & {
    hosted: HostedList;
    serialized<T>(operation: () => Promise<T>): Promise<T>;
    refuseWhileQuitting(): void;
    /** OwnBase is quitting, so no more scheduled backups start. */
    quitting(): boolean;
    changed(): void;
    now: () => number;
    read: HostingOptions["stopped"]["read"];
  },
) {
  const { hosted, serialized, refuseWhileQuitting, quitting, changed, now, read } = options;

  /**
   * The scheduled backups whose last try did not finish, from the list as
   * last read. A restored copy waiting to be put back in use is left out:
   * its schedule is not running.
   */
  function backupAttention(): BackupAttention[] {
    return (hosted.current() ?? []).flatMap((entry) => {
      const schedule = entry.autoBackup;
      const note =
        schedule?.warning ??
        backupFailureNote(entry.name, schedule?.failure) ??
        schedule?.retry?.error;
      if (!note || entry.restoredHold !== undefined) return [];
      return [
        {
          folder: entry.folder,
          name: entry.name,
          note,
          canRetry: !schedule?.warning && schedule?.failure?.kind !== "cleanup",
        },
      ];
    });
  }

  /**
   * Copies a hosted workspace into a new folder inside `destination`, running
   * or not, and records when. It waits its turn behind starting and stopping,
   * so the app cannot quit or change workspaces halfway through a copy.
   *
   * The folder must hold the workspace the list says it does, and so must the
   * copy: a folder swapped for another workspace's, before or during the
   * copy, is refused rather than reported as this workspace's backup.
   */
  function backup(value: unknown): Promise<{ path: string; at: number }> {
    const { folder, destination } = (value ?? {}) as Record<string, unknown>;
    if (typeof folder !== "string" || typeof destination !== "string" || !isAbsolute(destination))
      return Promise.reject(new Error("Choose a workspace and a folder to back it up to."));
    return serialized(async () => {
      refuseWhileQuitting();
      const entry = await hosted.listed(folder);
      return backupNow(entry, destination);
    });
  }

  /** The copy itself, for a caller already holding the serialized turn. */
  async function backupNow(
    entry: HostedWorkspace,
    destination: string,
  ): Promise<{ path: string; at: number }> {
    const dataDir = hosted.dataDirOf(entry);
    if (!existsSync(dataDir))
      throw new BackupFailed(
        "source",
        `The folder that held ${entry.name} is missing, so there is nothing to back up.`,
      );
    // Never made anew: a drive that is not connected would leave its folder
    // missing, and the backup would land on whatever disk holds the path.
    const unreachable = () =>
      new BackupFailed(
        "destination",
        `The folder ${destination} cannot be reached. If it is on a drive or network share, connect it, then try again.`,
      );
    if (!existsSync(destination)) throw unreachable();
    // The copy is about the size of the folder. A little over that leaves
    // room for the database's snapshot to be larger than the file it came from.
    const needed = Math.ceil((await folderBytes(dataDir)) * 1.1) + 16 * 1024 * 1024;
    const free = await options.freeBytes(destination).catch(() => {
      throw unreachable();
    });
    if (free < needed)
      throw new BackupFailed(
        "space",
        `There is not enough free space there. The backup needs about ${megabytes(needed)}, and ${megabytes(free)} is free.`,
      );
    const inside = hosted.folderHolds(entry);
    if (entry.id && inside.holds !== "it")
      throw new BackupFailed(
        "source",
        `The folder listed as ${entry.name} holds ${
          inside.holds === "another" && inside.name
            ? `“${inside.name}”`
            : "a different or unreadable workspace"
        } instead, so nothing was backed up.`,
      );
    const expected = entry.id ?? (inside.holds === "it" ? inside.id : null);
    // Two backups in one second would want one name; the later moves on a second.
    let at = now();
    const named = (time: number) =>
      join(destination, backupFolderName(time, legacyFolder(entry.name)));
    while (existsSync(named(at))) at += 1000;
    const out = named(at);
    await options.backupWorkspace({ dataDir, out });
    if (read(out)?.id !== expected) {
      // A copy of something else must not stand in for this workspace's backup.
      await rm(out, { recursive: true, force: true }).catch(() => {});
      throw new BackupFailed(
        "source",
        `The folder of ${entry.name} changed while it was being copied, so the copy was removed. Try again.`,
      );
    }
    const done = now();
    hosted.update(entry.folder, { lastBackupAt: done });
    await hosted.keep();
    changed();
    return { path: out, at: done };
  }

  /**
   * This workspace's own backups in `destination`, newest first by the time
   * in their names: folders named as scheduled backups are, under any
   * workspace's name, holding a manifest and this very workspace's id.
   * Nothing is checked or touched here.
   */
  async function ownBackups(
    entry: HostedWorkspace,
    destination: string,
  ): Promise<{ name: string; path: string; at: number }[]> {
    if (!entry.id) return [];
    const found: { name: string; path: string; at: number }[] = [];
    for (const { name, at } of await listScheduledBackups(destination, null)) {
      const path = join(destination, name);
      if (!existsSync(join(path, "manifest.json"))) continue;
      if (read(path)?.id !== entry.id) continue;
      found.push({ name, path, at });
    }
    return found.reverse();
  }

  /**
   * The backups of a workspace kept in its backup folder, the one its
   * schedule uses, newest first. Each is checked as a restore would check it,
   * so a damaged one is listed as such and cannot be chosen. Without a
   * schedule, or with its folder out of reach, there are none to list.
   */
  async function listBackups(value: unknown): Promise<HostedBackup[]> {
    if (typeof value !== "string") throw new Error("Choose a workspace whose backups to list.");
    const entry = await hosted.listed(value);
    const destination = entry.autoBackup?.destination;
    if (!destination || !existsSync(destination)) return [];
    const listed: HostedBackup[] = [];
    for (const { name, path, at } of await ownBackups(entry, destination).catch(() => [])) {
      try {
        const manifest = await options.verifyBackup(path);
        const bytes = manifest.database.bytes + manifest.files.reduce((n, f) => n + f.bytes, 0);
        listed.push({ name, at, bytes, damaged: false });
      } catch {
        listed.push({ name, at, bytes: null, damaged: true });
      }
    }
    return listed;
  }

  /**
   * Backs a workspace up by itself from now on, into `destination`, every day
   * or every week, keeping the newest `keep` of its backups there. Null turns
   * it off; backups already made stay where they are.
   */
  function setAutoBackup(value: unknown): Promise<AutoBackup | null> {
    const { folder, schedule } = (value ?? {}) as Record<string, unknown>;
    if (typeof folder !== "string")
      return Promise.reject(new Error("Choose a workspace to back up automatically."));
    if (schedule !== null && (!schedule || typeof schedule !== "object"))
      return Promise.reject(
        new Error("Choose a folder, daily or weekly, and to keep 1 to 60 backups."),
      );
    return serialized(async () => {
      refuseWhileQuitting();
      const entry = await hosted.listed(folder);
      let chosen: AutoBackup | null = null;
      if (schedule !== null) {
        const asked = schedule as Record<string, unknown>;
        // Changing how often or how many keeps the folder already chosen.
        const destination = asked.destination ?? entry.autoBackup?.destination;
        if (destination === undefined)
          throw new Error("Choose a folder to back the workspace up into.");
        chosen =
          parseAutoBackup({
            // Only a schedule still writing to the same folder keeps how its
            // last run went, failure included; a new folder is due at once.
            ...(destination === entry.autoBackup?.destination ? entry.autoBackup : {}),
            destination,
            everyDays: asked.everyDays,
            keep: asked.keep,
            // Changing frequency/retention does not bypass a failed copy's delay.
            // Explicitly choosing a destination is an operator-requested retry.
            retry: asked.destination === undefined ? entry.autoBackup?.retry : undefined,
          }) ?? null;
        if (!chosen)
          throw new Error("Choose a folder, daily or weekly, and to keep 1 to 60 backups.");
      }
      if (chosen && !existsSync(chosen.destination))
        throw new Error("That folder is not there any more. Choose another.");
      const previous = entry.autoBackup;
      hosted.update(entry.folder, { autoBackup: chosen ?? undefined });
      try {
        await hosted.save();
      } catch {
        hosted.update(entry.folder, { autoBackup: previous });
        throw new Error(
          "OwnBase could not save the backup schedule. Check that its settings folder is writable, then try again.",
        );
      }
      changed();
      return chosen;
    });
  }

  /**
   * Removes a workspace's older backups from its schedule's folder by the
   * shared rule, counting a copy only when it passes the check a restore
   * makes. Only a folder named as a backup, holding a backup of this very
   * workspace, is ever removed; anything else there is left alone.
   */
  async function removeOlderBackups(
    entry: HostedWorkspace,
    schedule: AutoBackup,
    fresh: string,
  ): Promise<void> {
    await pruneBackups({
      backups: await ownBackups(entry, schedule.destination),
      fresh: basename(fresh),
      keep: schedule.keep,
      recoverable: async ({ path }) => {
        await options.verifyBackup(path);
        return read(path)?.id === entry.id;
      },
      remove: ({ path }) => rm(path, { recursive: true, force: true }),
    });
  }

  /**
   * Backs up every workspace whose schedule has come due, one at a time, then
   * keeps only the newest of its backups. A failure is kept for the window to
   * show across restarts. Retries wait one hour, then double up to one day.
   * An explicit operator retry can bypass that delay for a failed capture.
   *
   * One pass runs at a time. A check asked for while one runs, such as a
   * schedule just saved, runs once more after it rather than beside it, and
   * each workspace's schedule and freshness are read again in the same turn
   * that makes its copy, so a schedule turned off or already served is not
   * backed up twice.
   */
  let duePass: Promise<void> | null = null;
  let dueAgain = false;
  let retryRequested = false;
  function runDueBackups(retryFailed = false): Promise<void> {
    retryRequested ||= retryFailed;
    if (duePass) {
      dueAgain = true;
      return duePass;
    }
    duePass = (async () => {
      do {
        const retryFailed = retryRequested;
        retryRequested = false;
        dueAgain = false;
        await dueOnce(retryFailed);
      } while (dueAgain && !quitting());
    })().finally(() => {
      duePass = null;
    });
    return duePass;
  }

  async function dueOnce(retryFailed: boolean): Promise<void> {
    let entries: HostedWorkspace[];
    try {
      entries = await hosted.load();
    } catch {
      return;
    }
    for (const { folder } of entries) {
      if (quitting()) return;
      try {
        const ran = await serialized(async () => {
          const entry = (await hosted.load()).find((e) => e.folder === folder);
          const schedule = entry?.autoBackup;
          // A restored copy is neither backed up nor allowed to remove older
          // backups until it is put back in use: a newer one there may be the
          // only copy of what the restore went back past.
          if (!entry || !schedule || entry.restoredHold !== undefined || quitting()) return false;
          if (!existsSync(hosted.dataDirOf(entry))) return false;
          if (schedule.retry && now() < schedule.retry.nextAt && !retryFailed) return false;
          // Never backed up by this schedule into its folder, it is due now.
          // A little early is fine: the check runs every 15 minutes.
          const everyMs = schedule.everyDays * 24 * 3600_000;
          if (now() < nextBackupAt(schedule.lastAt, everyMs) - 10 * 60_000) return false;
          const attempt = now();
          // The delay stops growing by the sixth.
          const attempts = Math.min((schedule.retry?.attempts ?? 0) + 1, 6);
          const retry = {
            attempts,
            nextAt: attempt + backupRetryDelay(attempts, everyMs),
            error: "The last scheduled backup did not finish. OwnBase will try it again later.",
          };
          // Reserve before taking any snapshot. A killed worker/app must not
          // restart into an immediate expensive retry, or erase the failure.
          hosted.update(entry.folder, {
            autoBackup: { ...schedule, lastAttemptAt: attempt, retry },
          });
          let made: Awaited<ReturnType<typeof backupNow>>;
          try {
            await hosted.save();
            made = await backupNow(entry, schedule.destination);
          } catch (error) {
            const latest = hosted.current()?.find((e) => e.folder === entry.folder) ?? entry;
            const failure: BackupFailure = {
              at: now(),
              kind: failureKind(error),
              message: (error instanceof Error ? error.message : "").slice(0, 1000),
            };
            hosted.update(entry.folder, {
              autoBackup: {
                ...(latest.autoBackup ?? schedule),
                lastAttemptAt: attempt,
                failure,
                warning: undefined,
                retry: {
                  ...retry,
                  error: backupFailureNote(entry.name, failure)!.slice(0, 1000),
                },
              },
            });
            await hosted.keep();
            throw error;
          }
          const latest = hosted.current()?.find((e) => e.folder === entry.folder) ?? entry;
          const {
            retry: _retry,
            warning: _warning,
            failure: _failure,
            ...completed
          } = latest.autoBackup ?? schedule;
          const finished = { ...completed, lastAt: made.at, lastPath: made.path };
          hosted.update(entry.folder, { autoBackup: finished });
          let savedCompletion = false;
          try {
            await hosted.save();
            savedCompletion = true;
            // A failed capture cannot trigger retention or displace a verified copy.
            await removeOlderBackups(latest, schedule, made.path);
          } catch (error) {
            // A verified copy is a successful capture even if its metadata or
            // retention cleanup fails. Do not promise a capture retry that its
            // fresh lastAt would correctly prevent, or create another snapshot.
            const warning =
              `A verified backup of ${entry.name} was made, but ${savedCompletion ? "older backup cleanup did not finish" : "its completion could not be saved"}. Some older backups may remain. ${error instanceof Error ? error.message : ""}`
                .trim()
                .slice(0, 1000);
            hosted.update(entry.folder, {
              autoBackup: {
                ...finished,
                warning,
                failure: {
                  at: now(),
                  kind: "cleanup",
                  message: (error instanceof Error ? error.message : "").slice(0, 1000),
                },
              },
            });
            await hosted.keep();
          }
          return true;
        });
        if (ran) changed();
      } catch {
        // Saved with its schedule above, for the window to show.
        changed();
      }
    }
  }

  return { backupAttention, backup, listBackups, ownBackups, setAutoBackup, runDueBackups };
}
