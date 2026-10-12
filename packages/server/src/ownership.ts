import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Held by whichever process has the workspace open for writing. */
export const WORKSPACE_LOCK = "workspace.lock";
/** Added to the folder's path: a file beside it, there only while something has the path. */
export const WORKSPACE_PATH_LOCK = ".lock";
/** Who holds it, for the message a second process is refused with. */
export const WORKSPACE_OWNER = "workspace.owner.json";

export interface WorkspaceOwner {
  /** What holds it: a server, a restore, an account recovery. */
  purpose: string;
  pid: number;
  hostname: string;
  startedAt: number;
  /** The port it serves on, once it is listening. */
  port: number | null;
}

/** Another process already has this workspace open for writing. */
export class WorkspaceInUseError extends Error {
  readonly code = "workspace_in_use";
  readonly dataDir: string;
  /** Null when the holder has not said who it is, or said it unreadably. */
  readonly owner: WorkspaceOwner | null;
  constructor(dataDir: string, owner: WorkspaceOwner | null) {
    super(
      `This workspace is already open in another process${describe(owner)}. ` +
        `Stop that one first, or use a different data directory. (${dataDir})`,
    );
    this.dataDir = dataDir;
    this.owner = owner;
  }
}

function describe(owner: WorkspaceOwner | null): string {
  if (!owner) return "";
  const parts = [`${owner.purpose}, process ${owner.pid} on ${owner.hostname}`];
  if (owner.port !== null) parts.push(`serving on port ${owner.port}`);
  parts.push(`since ${new Date(owner.startedAt).toISOString()}`);
  return ` (${parts.join(", ")})`;
}

export interface WorkspaceHold {
  /** Records the port once the server is listening, for anyone refused later. */
  describe(update: Partial<Pick<WorkspaceOwner, "port">>): void;
  /** Lets the workspace be opened again. Safe to call more than once. */
  release(): void;
}

/** A place to stand while the folder at a path is taken, moved or put there. */
export interface WorkspacePathHold {
  /** Lets others ask for the path again. Safe to call more than once. */
  release(): void;
}

/**
 * Takes SQLite's write lock on `file` and keeps it, or returns null when
 * another connection has it. The transaction is never committed, which makes
 * the lock the operating system's to release: when the holder exits or
 * crashes, the lock goes with it, so there is no stale lock file to judge and
 * no process id to trust.
 */
function lockFile(file: string, journal: "DELETE" | "MEMORY" = "DELETE"): DatabaseSync | null {
  const lock = new DatabaseSync(file);
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    // A write-ahead log would keep its locks in a shared-memory file; a
    // rollback journal keeps them on the database file, where they belong here.
    lock.exec(`PRAGMA journal_mode = ${journal}`);
    lock.exec("BEGIN IMMEDIATE");
    return lock;
  } catch (err) {
    lock.close();
    if (/locked|busy/i.test((err as Error).message)) return null;
    throw err;
  }
}

function unlockFile(lock: DatabaseSync): void {
  try {
    lock.exec("ROLLBACK");
  } finally {
    lock.close();
  }
}

/** Which file is at a path, so a new one there is told from the one before. Null when none is. */
function fileAt(path: string): string | null {
  const info = statSync(path, { bigint: true, throwIfNoEntry: false });
  return info ? `${info.dev}:${info.ino}:${info.birthtimeNs}` : null;
}

/**
 * Locks the file a path's lock is kept in, or returns null when another
 * connection has it, and says whether the file locked is certainly the one at
 * that path.
 *
 * The file is removed when the lock is let go, so nothing is left beside the
 * workspace. A process that opened it a moment earlier can then lock a file
 * that is no longer at the path, which keeps nobody out. So the file is looked
 * at before it is opened and again once locked, and when the two differ the
 * lock is let go and taken again. A file this call made is found the same on
 * the second pass.
 */
function lockPathFile(file: string): { lock: DatabaseSync; certain: boolean } | null {
  for (let attempt = 0; ; attempt += 1) {
    const before = fileAt(file);
    // Its journal is kept in memory: one beside the file would outlast the
    // file's removal, and the next file there would take it for its own.
    const lock = lockFile(file, "MEMORY");
    if (!lock) return null;
    if (before !== null && fileAt(file) === before) return { lock, certain: true };
    // Where the two never agree, the lock is still better held than not.
    if (attempt === 4) return { lock, certain: false };
    unlockFile(lock);
  }
}

function removeFile(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // Left behind, empty, it is found and removed by whoever holds the path next.
  }
}

/**
 * Takes the path `dataDir` for this process alone, whether or not a folder is
 * there, or throws WorkspaceInUseError if another has it.
 *
 * The folder's own lock is a file inside it, and Windows will not rename a
 * folder with an open file in it. So a restore has to let that lock go to move
 * the old folder aside and the restored one in, and for a moment the path has
 * no folder and no lock: a server starting then would make itself a new, empty
 * workspace there, and the restore could neither finish nor put the original
 * back. This lock is a file beside the folder, so it is held across both
 * renames, and everything that takes the folder asks for it first.
 *
 * It is found by its path, so the same folder reached through a link has a
 * different one. Where the file cannot be made, in a place this process may
 * not write to, nothing can be staged beside the workspace to restore it
 * either, and the path is taken without it.
 */
export function holdWorkspacePath(dataDir: string): WorkspacePathHold {
  const dir = resolve(dataDir);
  const file = `${dir}${WORKSPACE_PATH_LOCK}`;
  let held: { lock: DatabaseSync; certain: boolean } | null | undefined;
  try {
    mkdirSync(dirname(dir), { recursive: true });
    held = lockPathFile(file);
  } catch {
    held = undefined;
  }
  if (held === null) throw new WorkspaceInUseError(dir, readOwner(dir));
  return {
    release() {
      if (!held) return;
      const { lock, certain } = held;
      held = undefined;
      // Only its holder removes the file, and only a file it is certain of:
      // removing another would take it from under whoever holds that one.
      // Windows will not remove a file that is open, so there it goes once
      // closed, and stays if anyone has opened it by then. Elsewhere an open
      // file can be removed, so it goes while the lock is still held and
      // nobody can have locked it in between.
      if (certain && process.platform !== "win32") removeFile(file);
      unlockFile(lock);
      if (certain && process.platform === "win32") removeFile(file);
    },
  };
}

/**
 * Takes the workspace in `dataDir` for this process alone, or throws
 * WorkspaceInUseError if another process, or another server in this one,
 * already has it.
 *
 * Two servers on one folder each keep their own count of its attachments and
 * run their own schedulers and clean-up, so each can pass a storage cap the
 * other has already reached. Refusing the second before it opens the database
 * is the only way to keep one owner's view of the folder true.
 *
 * The lock is SQLite's own file lock on a small database beside the workspace,
 * held by a write transaction that is never committed. It is taken on the file
 * itself, so two spellings of the same folder, or a link to it, find the same
 * lock. It is advisory, and as reliable as file locking on the filesystem
 * holding the folder: a network share may not honour it, and SQLite's
 * documentation advises against keeping a database on one.
 *
 * The path is held while the folder is made and taken, so neither happens
 * while a restore is moving folders there.
 *
 * Reading the workspace, as a backup does, needs no hold.
 */
export function holdWorkspace(dataDir: string, purpose: string): WorkspaceHold {
  const path = holdWorkspacePath(dataDir);
  try {
    return holdFolder(dataDir, purpose);
  } finally {
    path.release();
  }
}

/**
 * Takes the folder `dataDir` as holdWorkspace does, without asking for its
 * path: for whoever already holds the path, and for a folder nothing moves.
 */
export function holdFolder(dataDir: string, purpose: string): WorkspaceHold {
  const dir = resolve(dataDir);
  mkdirSync(dir, { recursive: true });
  const lock = lockFile(join(dir, WORKSPACE_LOCK));
  if (!lock) throw new WorkspaceInUseError(dir, readOwner(dir));

  const owner: WorkspaceOwner = {
    purpose,
    pid: process.pid,
    hostname: hostname(),
    startedAt: Date.now(),
    port: null,
  };
  const ownerFile = join(dir, WORKSPACE_OWNER);
  const writeOwner = () => {
    // Only what someone refused needs to recognise the holder: no address a
    // stranger could use, and nothing secret.
    try {
      const staged = `${ownerFile}.${process.pid}.tmp`;
      writeFileSync(staged, JSON.stringify(owner));
      renameSync(staged, ownerFile);
    } catch {
      // The description is a courtesy; the lock is what keeps the workspace safe.
    }
  };
  writeOwner();

  let held = true;
  return {
    describe(update) {
      if (!held) return;
      Object.assign(owner, update);
      writeOwner();
    },
    release() {
      if (!held) return;
      held = false;
      try {
        rmSync(ownerFile, { force: true });
      } catch {
        // A leftover description is overwritten by the next holder.
      }
      unlockFile(lock);
    },
  };
}

function readOwner(dir: string): WorkspaceOwner | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, WORKSPACE_OWNER), "utf8")) as WorkspaceOwner;
    return typeof value.pid === "number" && typeof value.purpose === "string" ? value : null;
  } catch {
    return null;
  }
}
