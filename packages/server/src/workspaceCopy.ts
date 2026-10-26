import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { WorkspaceCopy } from "@slackoss/protocol";
import type { BackupManifest } from "./backup.js";
import { extractZipEntry, fileCrc32, readZipEntries, zipArchive, type ZipSource } from "./zip.js";

/**
 * A copy of the workspace its owner downloads (P4): an ordinary backup, made
 * fresh, served as one zip. The zip holds the backup's own layout, so
 * `restore --from copy.zip` puts it back, on this server or the owner's own.
 */

const ATTACHMENT = /^files\/[A-Za-z0-9_-]+$/;
const KNOWN = new Set(["manifest.json", "workspace.db"]);

/** What the owner is told about the copy being made or kept. */
export type CopyState = WorkspaceCopy;

/** The files of a backup folder as zip entries, each with its CRC worked out. */
export async function backupZipEntries(dir: string): Promise<ZipSource[]> {
  const sources: { name: string; path: string }[] = [
    { name: "manifest.json", path: join(dir, "manifest.json") },
    { name: "workspace.db", path: join(dir, "workspace.db") },
    ...(await readdir(join(dir, "files")))
      .sort()
      .map((name) => ({ name: `files/${name}`, path: join(dir, "files", name) })),
  ];
  const entries: ZipSource[] = [];
  for (const source of sources) {
    const { crc32, size } = await fileCrc32(source.path);
    entries.push({ name: source.name, size, crc32, open: () => createReadStream(source.path) });
  }
  return entries;
}

/**
 * Unpacks a workspace copy's zip into `out`, which must not exist yet. A zip
 * of the backup folder itself, one level down, is taken too, since that is
 * what zipping the folder by hand makes. Anything that is not part of a
 * backup, such as a macOS `__MACOSX` folder, is left out; anything that would
 * land outside `out` is never written, because only the backup's own names are.
 */
export async function unzipBackup(zipPath: string, out: string): Promise<void> {
  const entries = await readZipEntries(zipPath);
  let prefix = "";
  if (!entries.some((entry) => entry.name === "manifest.json")) {
    const nested = entries.filter((entry) => /^[^/]+\/manifest\.json$/.test(entry.name));
    if (nested.length !== 1) throw new Error("This zip does not hold a workspace backup.");
    prefix = nested[0]!.name.slice(0, -"manifest.json".length);
  }
  const wanted = entries
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => ({ entry, name: entry.name.slice(prefix.length) }))
    .filter(({ name }) => KNOWN.has(name) || ATTACHMENT.test(name));
  if (new Set(wanted.map(({ name }) => name.toLowerCase())).size !== wanted.length)
    throw new Error("This zip holds the same file twice.");
  await mkdir(out);
  await mkdir(join(out, "files"));
  for (const { entry, name } of wanted) await extractZipEntry(zipPath, entry, join(out, name));
}

/**
 * Runs `use` on a backup folder: `from` itself, or, for a zip, its contents
 * unpacked beside it and removed afterwards, whatever `use` does.
 */
export async function withBackupFolder<T>(from: string, use: (dir: string) => Promise<T>) {
  if ((await stat(from)).isDirectory()) return use(from);
  const scratch = await mkdtemp(join(dirname(from), ".tandem-unzip-"));
  try {
    const dir = join(scratch, "backup");
    await unzipBackup(from, dir);
    return await use(dir);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The owner's copy: one at a time, made in `root`, kept for `keepMs` once
 * ready, then removed. Asking again while one is being made gives that one;
 * asking once it is ready, or after it failed, replaces it.
 */
export class WorkspaceCopies {
  private current: {
    state: CopyState;
    dir: string;
    entries?: ZipSource[];
    /** When its backup was taken, which dates every file in the zip. */
    takenAt?: number;
    expiry?: ReturnType<typeof setTimeout>;
  } | null = null;
  private readonly abort = new AbortController();
  private making: Promise<void> | null = null;
  /** Downloads under way; a copy is not removed from under one. */
  private reading = 0;
  private stopped = false;

  constructor(
    private readonly opts: {
      /** Where copies are made. Removed and made afresh when the server starts. */
      root: string;
      take: (out: string, signal: AbortSignal) => Promise<BackupManifest>;
      keepMs?: number;
      onReady?: (state: Extract<CopyState, { state: "ready" }>) => void;
      log: { error: (details: object, message: string) => void };
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Where copies are made. */
  get root(): string {
    return this.opts.root;
  }

  /** Clears copies a previous run left behind. */
  async start(): Promise<void> {
    await rm(this.opts.root, { recursive: true, force: true });
  }

  state(): CopyState | null {
    return this.current?.state ?? null;
  }

  /**
   * Starts a copy, or gives the one being made. Null while the ready one is
   * being downloaded: its files cannot be removed under the download.
   */
  make(): CopyState | null {
    if (this.stopped) throw new Error("The server is stopping.");
    if (this.current?.state.state === "making") return this.current.state;
    if (this.reading > 0) return null;
    void this.discard();
    const id = randomUUID();
    const dir = join(this.opts.root, id);
    const state: CopyState = { id, state: "making", startedAt: this.now() };
    const current: NonNullable<typeof this.current> = { state, dir };
    this.current = current;
    this.making = this.prepare(current).finally(() => {
      this.making = null;
    });
    return state;
  }

  private async prepare(current: NonNullable<typeof this.current>): Promise<void> {
    try {
      await mkdir(this.opts.root, { recursive: true });
      const out = join(current.dir, "backup");
      await mkdir(current.dir);
      const { createdAt } = await this.opts.take(out, this.abort.signal);
      const entries = await backupZipEntries(out);
      if (this.current !== current) return;
      const ready: CopyState = {
        id: current.state.id,
        state: "ready",
        startedAt: current.state.startedAt,
        bytes: zipArchive(entries, createdAt).length,
        expiresAt: this.now() + (this.opts.keepMs ?? 3600_000),
      };
      current.state = ready;
      current.entries = entries;
      current.takenAt = createdAt;
      this.armExpiry(current);
      this.opts.onReady?.(ready);
    } catch (error) {
      if (this.current !== current || this.stopped) return;
      this.opts.log.error({ err: error }, "a copy of the workspace could not be made");
      // Cleared before it says so, so a failed copy never leaves a half on the disk.
      await rm(current.dir, { recursive: true, force: true }).catch(() => {});
      current.state = {
        id: current.state.id,
        state: "failed",
        startedAt: current.state.startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private armExpiry(current: NonNullable<typeof this.current>): void {
    const ready = current.state;
    if (ready.state !== "ready") return;
    current.expiry = setTimeout(
      () => {
        if (this.current !== current) return;
        if (this.reading === 0) {
          void this.discard();
          return;
        }
        // A download still running keeps the copy a little longer.
        ready.expiresAt = this.now() + 300_000;
        this.armExpiry(current);
      },
      Math.max(0, ready.expiresAt - this.now()),
    );
    current.expiry.unref();
  }

  /** The ready copy's zip, if `id` is it. Counts as a download until the stream ends. */
  open(id: string): { length: number; stream: Readable } | null {
    const current = this.current;
    if (!current || current.state.id !== id || !current.entries) return null;
    const archive = zipArchive(current.entries, current.takenAt);
    const stream = archive.open();
    this.reading++;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.reading--;
    };
    stream.once("close", finish);
    stream.once("end", finish);
    stream.once("error", finish);
    return { length: archive.length, stream };
  }

  /** Removes the copy, ready or failed. One being made is abandoned. */
  async discard(): Promise<void> {
    const current = this.current;
    if (!current) return;
    this.current = null;
    if (current.expiry) clearTimeout(current.expiry);
    await rm(current.dir, { recursive: true, force: true }).catch((err: unknown) =>
      this.opts.log.error({ err }, "a copy of the workspace could not be removed"),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.making?.catch(() => {});
    await this.discard();
  }
}
