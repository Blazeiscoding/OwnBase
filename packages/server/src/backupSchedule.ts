import { spawn } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BackupManifest } from "./backup.js";

/**
 * Backups the server takes by itself on a timer (P3), into dated folders in
 * one directory, keeping the newest few.
 *
 * Each one is an ordinary backup (`backupWorkspace`), so it is verified before
 * it is published and restores with `restore --from`. Only folders named the
 * way this writes them are ever counted or removed, so a directory shared with
 * anything else loses nothing else.
 */
export interface ScheduledBackups {
  /** Where the dated backups go. Must be outside the workspace folder. */
  dir: string;
  /** Time between one backup starting and the next. */
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
}

const NAME = /^backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/;
/** A failed backup is tried again this soon, or at the next regular time if that comes first. */
const RETRY_MS = 3600_000;
/** The longest a timer can wait; a later time is reached by waiting again. */
const LONGEST_TIMER_MS = 2_147_483_647;

/** The folder a backup started at `at` goes in: sortable, and legal on Windows. */
export function backupFolderName(at: number): string {
  return `backup-${new Date(at).toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
}

/** When a folder written by `backupFolderName` was started, or null for any other name. */
export function backupFolderTime(name: string): number | null {
  const match = NAME.exec(name);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const at = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
  return backupFolderName(at) === name ? at : null;
}

/** This schedule's backups in `dir`, oldest first. */
export async function listScheduledBackups(dir: string): Promise<{ name: string; at: number }[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, at: backupFolderTime(entry.name) }))
    .filter((entry): entry is { name: string; at: number } => entry.at !== null)
    .sort((a, b) => a.at - b.at);
}

/** Removes this schedule's oldest backups past `keep`, returning their names. */
export async function pruneScheduledBackups(dir: string, keep: number): Promise<string[]> {
  const backups = await listScheduledBackups(dir);
  const doomed = backups.slice(0, Math.max(0, backups.length - keep)).map((b) => b.name);
  for (const name of doomed) await rm(join(dir, name), { recursive: true, force: true });
  return doomed;
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
}): (out: string, signal: AbortSignal) => Promise<BackupManifest> {
  return (out, signal) =>
    new Promise((resolvePromise, reject) => {
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
        { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, signal },
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
        // Verified by the child before it published the folder.
        readFile(join(out, "manifest.json"), "utf8")
          .then((text) => resolvePromise(JSON.parse(text) as BackupManifest))
          .catch(reject);
      });
    });
}

/**
 * The timer behind scheduled backups. The next one is due `everyMs` after the
 * newest already in the directory, so a server that restarts often does not
 * take one each time, and one stopped past its time takes one soon after it
 * starts. A failure is tried again within the hour.
 */
export class BackupSchedule {
  private timer: ReturnType<typeof setTimeout> | null = null;
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
    this.arm(newest ? Math.max(soonest, newest.at + this.opts.everyMs) : soonest);
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
    const name = backupFolderName(started);
    this.state.running = true;
    try {
      const manifest = await this.opts.run(join(this.dir, name), this.abort.signal);
      this.state.lastSuccessAt = started;
      this.state.lastError = null;
      this.state.failures = 0;
      const removed = await pruneScheduledBackups(this.dir, this.opts.keep);
      this.opts.log.info(
        { backup: name, attachments: manifest.files.length, removed },
        "scheduled backup done",
      );
      this.arm(started + this.opts.everyMs);
    } catch (error) {
      if (this.stopped) return;
      this.state.failures++;
      this.state.lastError = error instanceof Error ? error.message : String(error);
      this.opts.log.error(
        { err: error, failures: this.state.failures, backup: name },
        "scheduled backup failed; it will be tried again",
      );
      this.arm(this.now() + Math.min(RETRY_MS, this.opts.everyMs));
    } finally {
      this.state.running = false;
    }
  }

  status(): BackupScheduleStatus {
    return { ...this.state };
  }

  /** No more backups; one running in a child process is stopped, one in this process finishes. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state.nextAt = null;
    this.abort.abort();
    await this.running?.catch(() => {});
  }
}
