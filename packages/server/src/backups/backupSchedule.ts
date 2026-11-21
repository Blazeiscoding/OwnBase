import { spawn } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BackupManifest } from "./backup.js";
import type { BackupEncryption } from "./encryption.js";
import type { OffsiteUploader } from "./offsite.js";
import { ENCRYPTED_SUFFIX, readSealedManifest } from "./sealed.js";

/**
 * Backups the server takes by itself on a timer (P3), into dated folders in
 * one directory, keeping the newest few.
 *
 * Each one is an ordinary backup (`backupWorkspace`), so it is verified before
 * it is published and restores with `restore --from`. Only folders and
 * encrypted files named the way this writes them are ever counted or removed,
 * so a directory shared with anything else loses nothing else.
 */
export interface ScheduledBackups {
  /** Where the dated backups go. Must be outside the workspace folder. */
  dir: string;
  everyMs: number;
  /** How many to keep; older ones go once a newer one is verified. */
  keep: number;
  /** How long after starting the first is taken when none is recent. One minute by default. */
  firstDelayMs?: number;
  /**
   * Takes one backup into `out`. In this process by default; the command line
   * hands it to a child process instead, because copying and checking the
   * database holds this one's event loop for as long as it takes, about a
   * second and a half for 300 MB, and chat waits that long.
   */
  run?: (out: string, signal: AbortSignal) => Promise<BackupManifest>;
  /** Also sends each backup elsewhere, such as an R2 bucket, keeping the newest few there. */
  offsite?: OffsiteUploader;
  /**
   * Seals each backup with a passphrase: a file named like the folder would
   * be, ending in `.encrypted`. The offsite copy is that file.
   */
  encryption?: BackupEncryption;
}

/** How scheduled backups are going, for the owner and admins. */
export interface BackupScheduleStatus {
  everyMs: number;
  keep: number;
  lastSuccessAt: number | null;
  lastError: string | null;
  /** Failures since the last success. */
  failures: number;
  nextAt: number | null;
  running: boolean;
  /** Copies sent elsewhere, when configured: the backup time of the newest one sent, and failures since. */
  offsite: { lastSuccessAt: number | null; lastError: string | null; failures: number } | null;
}

/*
 * The rule every scheduled backup follows, the server's own and the desktop
 * app's for the workspaces it hosts: how a backup is named, when the next is
 * due, how long a failure waits, and which older ones go. Each caller says
 * only which workspace, which folder, and what checks a copy.
 */

const STAMP = String.raw`(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})`;
/** A label of plain letters, digits and hyphens, the time, then Z. */
const NAME = new RegExp(String.raw`^([a-z0-9-]+)-${STAMP}(Z?)$`);
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
/** The longest a timer can wait; a later time is reached by waiting again. */
const LONGEST_TIMER_MS = 2_147_483_647;

/**
 * The folder a backup started at `at` goes in: sortable, and legal on
 * Windows. `label` comes first: "backup" for the server's own schedule, the
 * workspace's name in the desktop app, where one folder may hold several.
 */
export function backupFolderName(at: number, label = "backup"): string {
  return `${label}-${new Date(at).toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
}

/**
 * When a folder written by `backupFolderName` with `label` was started, or
 * null for any other name. A null label takes any, and also the names the
 * desktop app wrote until November 2026, which end without the Z.
 */
export function backupFolderTime(name: string, label: string | null = "backup"): number | null {
  const match = NAME.exec(name);
  if (!match) return null;
  const [, found, y, mo, d, h, mi, s, z] = match;
  if (label !== null && (found !== label || !z)) return null;
  const at = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
  return backupFolderName(at, found) === (z ? name : `${name}Z`) ? at : null;
}

/**
 * When a scheduled backup named `name` was started: a folder named by
 * `backupFolderName`, or an encrypted file named the same with
 * `.encrypted` after it. Null for any other name.
 */
export function scheduledBackupTime(name: string, label: string | null = "backup"): number | null {
  return backupFolderTime(
    name.endsWith(ENCRYPTED_SUFFIX) ? name.slice(0, -ENCRYPTED_SUFFIX.length) : name,
    label,
  );
}

/**
 * The scheduled backups in `dir` named with `label` (null for any), oldest
 * first: plain folders and encrypted files both, so turning a passphrase on
 * or off keeps counting the ones from before, and prunes them in their turn.
 */
export async function listScheduledBackups(
  dir: string,
  label: string | null = "backup",
): Promise<{ name: string; at: number }[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .map((entry) => ({
      name: entry.name,
      at: entry.isDirectory()
        ? backupFolderTime(entry.name, label)
        : entry.isFile() && entry.name.endsWith(ENCRYPTED_SUFFIX)
          ? scheduledBackupTime(entry.name, label)
          : null,
    }))
    .filter((entry): entry is { name: string; at: number } => entry.at !== null)
    .sort((a, b) => a.at - b.at);
}

/** When the next backup is due: `everyMs` after the last, or at once when there is none. */
export function nextBackupAt(lastAt: number | null | undefined, everyMs: number): number {
  return lastAt === null || lastAt === undefined ? 0 : lastAt + everyMs;
}

/**
 * How long to wait after the `failures`-th failure in a row before trying
 * again: an hour, doubling with each failure after it, never longer than a
 * day or than the regular interval. Each try can copy the whole database, so
 * a full disk or a folder out of reach is not tried every hour forever.
 */
export function backupRetryDelay(failures: number, everyMs: number): number {
  return Math.min(HOUR_MS * 2 ** (Math.max(1, failures) - 1), DAY_MS, everyMs);
}

/**
 * Removes the backups past `keep` once `fresh` is made, and gives back what
 * it removed. `keep` recoverable copies stay: the fresh one, verified as it
 * was made, and the newest others that `recoverable` passes. They are taken
 * newest first by the time in their names; a clock set wrong can make that
 * order lie, which is why only checked copies count and the fresh one always
 * stays. A copy that fails the check is neither counted nor removed while
 * copies are still wanted, so a damaged or oddly dated one cannot take a
 * good one's place. Past `keep`, every older one goes.
 */
export async function pruneBackups<T extends { name: string; at: number }>(opts: {
  backups: readonly T[];
  fresh: string;
  keep: number;
  recoverable: (backup: T) => Promise<boolean>;
  remove: (backup: T) => Promise<void>;
}): Promise<T[]> {
  const older = opts.backups.filter((b) => b.name !== opts.fresh).sort((a, b) => b.at - a.at);
  const removed: T[] = [];
  let kept = 1;
  for (const backup of older) {
    if (kept >= opts.keep) {
      await opts.remove(backup);
      removed.push(backup);
    } else if (await opts.recoverable(backup).catch(() => false)) kept++;
  }
  return removed;
}

/**
 * Whether a backup in the server's folder opens: a folder whose manifest
 * reads, or an encrypted file whose manifest the passphrase opens. The full
 * check is not run on every kept copy: it reads each one through, and each
 * was verified before it was published.
 */
async function backupOpens(path: string, encryption: BackupEncryption | undefined) {
  const manifest: unknown = path.endsWith(ENCRYPTED_SUFFIX)
    ? encryption && (await readSealedManifest(path, encryption.passphrase))
    : JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
  return typeof (manifest as BackupManifest | undefined)?.database?.bytes === "number";
}

/**
 * Runs `backup` from this same program in a child process, so the copy and
 * its checks never hold the server's event loop. `script` and `execArgv` are
 * what started this process, which is how a loader such as tsx comes along.
 * Stopping the server kills the child; the half-made copy it leaves is
 * removed by the next backup into the same directory.
 */
export function backupInChildProcess(opts: {
  script: string;
  dataDir: string;
  execArgv?: string[];
}): (out: string, signal: AbortSignal, encryption?: BackupEncryption) => Promise<BackupManifest> {
  return (out, signal, encryption) =>
    new Promise((resolvePromise, reject) => {
      // The child seals only what it is told to: the owner's copy is taken
      // the same way and must stay a plain folder, whatever this process's
      // environment holds. The passphrase goes in the environment, never in
      // the arguments, which anyone on the machine can list.
      const env = { ...process.env };
      delete env.OWNBASE_BACKUP_PASSPHRASE;
      delete env.OWNBASE_BACKUP_PASSPHRASE_FILE;
      if (encryption) env.OWNBASE_BACKUP_PASSPHRASE = encryption.passphrase;
      const child = spawn(
        process.execPath,
        [
          ...(opts.execArgv ?? process.execArgv),
          opts.script,
          "backup",
          "--data",
          opts.dataDir,
          "--out",
          out,
        ],
        { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, signal, env },
      );
      let errors = "";
      child.stderr!.on("data", (chunk) => {
        if (errors.length < 4000) errors += String(chunk);
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) {
          reject(new Error(errors.trim() || `The backup process ended with code ${code}.`));
          return;
        }
        // Verified by the child before it published it.
        (encryption
          ? readSealedManifest(out, encryption.passphrase)
          : readFile(join(out, "manifest.json"), "utf8").then(
              (text) => JSON.parse(text) as BackupManifest,
            )
        )
          .then(resolvePromise)
          .catch(reject);
      });
    });
}

/**
 * The timer behind scheduled backups. The next one is due `everyMs` after the
 * newest already in the directory, so a server that restarts often does not
 * take one each time, and one stopped past its time takes one soon after it
 * starts. A failure is tried again as `backupRetryDelay` says.
 */
export class BackupSchedule {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Sends a backup offsite again after a failure, without taking a new one. */
  private offsiteTimer: ReturnType<typeof setTimeout> | null = null;
  /** The newest backup that did not reach offsite yet. */
  private offsitePending: string | null = null;
  private running: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private stopped = false;
  private lastStarted = 0;
  private readonly state: BackupScheduleStatus;
  readonly dir: string;

  constructor(
    private readonly opts: ScheduledBackups & {
      run: (out: string, signal: AbortSignal) => Promise<BackupManifest>;
      log: {
        info: (details: object, message: string) => void;
        error: (details: object, message: string) => void;
      };
      now?: () => number;
    },
  ) {
    this.dir = resolve(opts.dir);
    this.state = {
      everyMs: opts.everyMs,
      keep: opts.keep,
      lastSuccessAt: null,
      lastError: null,
      failures: 0,
      nextAt: null,
      running: false,
      offsite: opts.offsite ? { lastSuccessAt: null, lastError: null, failures: 0 } : null,
    };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * Arms the first backup from what is already in the directory. Never
   * rejects: a directory that cannot be read now is the first backup's
   * failure to report, not a reason for the server not to start.
   */
  async start(): Promise<void> {
    let newest: { at: number } | undefined;
    try {
      newest = (await listScheduledBackups(this.dir)).at(-1);
    } catch (error) {
      this.opts.log.error({ err: error, dir: this.dir }, "cannot read the backup directory");
    }
    if (newest) this.state.lastSuccessAt = newest.at;
    const soonest = this.now() + (this.opts.firstDelayMs ?? 60_000);
    this.arm(Math.max(soonest, nextBackupAt(newest?.at, this.opts.everyMs)));
  }

  private arm(at: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped) {
      this.state.nextAt = null;
      return;
    }
    this.state.nextAt = at;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        if (this.now() < at) this.arm(at);
        else void this.runNow();
      },
      Math.min(Math.max(0, at - this.now()), LONGEST_TIMER_MS),
    );
    this.timer.unref();
  }

  /** Takes a backup now, or joins the one already running. */
  runNow(): Promise<void> {
    if (this.running) return this.running;
    if (this.stopped) return Promise.resolve();
    this.running = this.backUp().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async backUp(): Promise<void> {
    // A second apart at least, so two backups never ask for one folder name.
    const started = Math.max(this.now(), this.lastStarted + 1000);
    this.lastStarted = started;
    const name = backupFolderName(started) + (this.opts.encryption ? ENCRYPTED_SUFFIX : "");
    this.state.running = true;
    try {
      const manifest = await this.opts.run(join(this.dir, name), this.abort.signal);
      this.state.lastSuccessAt = started;
      this.state.lastError = null;
      this.state.failures = 0;
      const removed = await pruneBackups({
        backups: await listScheduledBackups(this.dir),
        fresh: name,
        keep: this.opts.keep,
        recoverable: (backup) => backupOpens(join(this.dir, backup.name), this.opts.encryption),
        remove: (backup) => rm(join(this.dir, backup.name), { recursive: true, force: true }),
      });
      this.opts.log.info(
        { backup: name, attachments: manifest.files.length, removed: removed.map((b) => b.name) },
        "scheduled backup done",
      );
      this.arm(started + this.opts.everyMs);
    } catch (error) {
      this.state.running = false;
      if (this.stopped) return;
      this.state.failures++;
      this.state.lastError = error instanceof Error ? error.message : String(error);
      this.opts.log.error(
        { err: error, failures: this.state.failures, backup: name },
        "scheduled backup failed; it will be tried again",
      );
      this.arm(this.now() + backupRetryDelay(this.state.failures, this.opts.everyMs));
      return;
    }
    this.offsitePending = name;
    await this.sendOffsite();
    this.state.running = false;
  }

  /**
   * Sends the newest backup offsite and removes the oldest copies there. A
   * failure leaves the backup itself standing, and only the sending is tried
   * again, after the first retry delay; a newer backup goes in its place.
   */
  private async sendOffsite(): Promise<void> {
    const offsite = this.opts.offsite;
    const name = this.offsitePending;
    if (!offsite || !name || this.stopped) return;
    if (this.offsiteTimer) clearTimeout(this.offsiteTimer);
    this.offsiteTimer = null;
    const state = this.state.offsite!;
    try {
      const sent = await offsite.upload(join(this.dir, name), name, this.abort.signal);
      const removed = await offsite.prune(this.abort.signal);
      if (this.offsitePending === name) this.offsitePending = null;
      state.lastSuccessAt = scheduledBackupTime(name);
      state.lastError = null;
      state.failures = 0;
      this.opts.log.info(
        { backup: name, key: sent.key, bytes: sent.bytes, removed },
        "offsite copy sent",
      );
    } catch (error) {
      if (this.stopped) return;
      state.failures++;
      state.lastError = error instanceof Error ? error.message : String(error);
      this.opts.log.error(
        { err: error, failures: state.failures, backup: name, where: offsite.where },
        "offsite copy failed; it will be tried again",
      );
      this.offsiteTimer = setTimeout(
        () => {
          this.offsiteTimer = null;
          if (this.running || this.stopped) return;
          this.running = this.retryOffsite().finally(() => {
            this.running = null;
          });
        },
        backupRetryDelay(1, this.opts.everyMs),
      );
      this.offsiteTimer.unref();
    }
  }

  /** The retry of a failed send, if its backup is still there to send. */
  private async retryOffsite(): Promise<void> {
    const name = this.offsitePending;
    if (!name) return;
    const kept = await listScheduledBackups(this.dir).catch(() => []);
    if (!kept.some((backup) => backup.name === name)) {
      this.offsitePending = null;
      return;
    }
    this.state.running = true;
    try {
      await this.sendOffsite();
    } finally {
      this.state.running = false;
    }
  }

  status(): BackupScheduleStatus {
    return { ...this.state, offsite: this.state.offsite && { ...this.state.offsite } };
  }

  /** No more backups; one running in a child process is stopped, one in this process finishes. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.offsiteTimer) clearTimeout(this.offsiteTimer);
    this.offsiteTimer = null;
    this.state.nextAt = null;
    this.abort.abort();
    await this.running?.catch(() => {});
  }
}
