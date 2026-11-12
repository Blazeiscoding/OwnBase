import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { WORKSPACE_NAME_MAX } from "@ownbase/protocol";
import { workspaceDatabase, type readStoppedWorkspace } from "@ownbase/server/stoppedWorkspace";
import type { AutoBackup as AutoBackupView, BackupFailureKind } from "@ownbase/protocol/desktop";
import { DesktopError } from "../shared/desktopError.js";

/**
 * A workspace this computer hosts, as the settings file remembers it. The
 * folder is fixed when the entry is made and never follows the name, so two
 * workspaces can share a name and a rename moves nothing.
 */
export interface HostedWorkspace {
  /** The server's `workspace_id`. Null until a folder adopted without one has started. */
  id: string | null;
  /** A single name under the hosted folder. */
  folder: string;
  /** What the server called itself when it last started. The server is the authority. */
  name: string;
  port: number;
  /**
   * Whether someone chose `port`. A chosen port is kept even when it is busy,
   * and the workspace does not start; an automatic one may move to a free port.
   * Absent in entries saved before this was recorded.
   */
  portChosen?: boolean;
  lastHostedAt: number;
  /** When a backup of it last finished, if one has. */
  lastBackupAt?: number;
  /** Backing it up by itself, into a folder the host chose, keeping the newest few. */
  autoBackup?: AutoBackup;
  /**
   * When it was restored from a backup, until someone puts it back in use.
   * Until then it starts only on its own, for looking inside: nothing queued
   * is sent, no app is called, and only this computer can reach it.
   */
  restoredHold?: number;
}

/**
 * How often, and where, a workspace is backed up without being asked, with
 * what the window is not shown. `lastAt` is absent until this schedule has
 * made a backup into its destination, so a new or changed one is due at once.
 */
export interface AutoBackup extends AutoBackupView {
  /** When it last tried, whether or not that finished (OPS-02). */
  lastAttemptAt?: number;
  /** The folder its last finished backup was made in. */
  lastPath?: string;
  /**
   * Why its last try did not finish. Kept with the schedule, so a restart
   * cannot hide it, until a backup into the same folder finishes.
   */
  failure?: BackupFailure;
  /** Reserved before starting a copy, so interruption and restart keep its retry delay. */
  retry?: { attempts: number; nextAt: number; error: string };
  /** A verified copy exists, but recording completion or cleaning older copies failed. */
  warning?: string;
}

export type { BackupFailureKind };

export interface BackupFailure {
  at: number;
  kind: BackupFailureKind;
  message: string;
}

const FAILURE_KINDS: readonly BackupFailureKind[] = [
  "destination",
  "space",
  "source",
  "cleanup",
  "other",
];

/** A stored failure, or undefined when it cannot be read. */
function parseBackupFailure(value: unknown): BackupFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { at, kind, message } = value as Record<string, unknown>;
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return undefined;
  if (typeof message !== "string") return undefined;
  return {
    at,
    kind: FAILURE_KINDS.includes(kind as BackupFailureKind) ? (kind as BackupFailureKind) : "other",
    message: message.slice(0, 1000),
  };
}

/** A schedule as stored, or undefined when it is not one this version can follow. */
export function parseAutoBackup(value: unknown): AutoBackup | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { destination, everyDays, keep, lastAt, lastAttemptAt, lastPath, failure, retry, warning } =
    value as Record<string, unknown>;
  if (typeof destination !== "string" || !isAbsolute(destination)) return undefined;
  if (everyDays !== 1 && everyDays !== 7) return undefined;
  if (typeof keep !== "number" || !Number.isInteger(keep) || keep < 1 || keep > 60)
    return undefined;
  const schedule: AutoBackup = { destination, everyDays, keep };
  // A time it cannot read only makes the next backup due sooner.
  if (typeof lastAt === "number" && Number.isFinite(lastAt) && lastAt >= 0)
    schedule.lastAt = lastAt;
  if (typeof lastAttemptAt === "number" && Number.isFinite(lastAttemptAt) && lastAttemptAt >= 0)
    schedule.lastAttemptAt = lastAttemptAt;
  if (typeof lastPath === "string" && isAbsolute(lastPath)) schedule.lastPath = lastPath;
  // One that cannot be read is still a failure, rather than a reason to forget it.
  if (failure !== undefined)
    schedule.failure = parseBackupFailure(failure) ?? {
      at: schedule.lastAttemptAt ?? 0,
      kind: "other",
      message: "",
    };
  if (retry && typeof retry === "object" && !Array.isArray(retry)) {
    const { attempts, nextAt, error } = retry as Record<string, unknown>;
    if (
      typeof attempts === "number" &&
      Number.isInteger(attempts) &&
      attempts >= 1 &&
      attempts <= 6 &&
      typeof nextAt === "number" &&
      Number.isFinite(nextAt) &&
      nextAt >= 0 &&
      typeof error === "string" &&
      error.length <= 1000
    )
      schedule.retry = { attempts, nextAt, error };
  }
  if (typeof warning === "string" && warning.length > 0 && warning.length <= 1000)
    schedule.warning = warning;
  return schedule;
}

export const REGISTRY_KEY = "hostedWorkspaces";

/**
 * Plain lowercase letters, digits and hyphens, one path segment. A hand-edited
 * entry cannot point outside the hosted folder, and every folder earlier
 * versions made already fits.
 */
const FOLDER = /^[a-z0-9-]{1,64}$/;

/** A present registry must never be mistaken for a missing, migratable one. */
export class RegistryFormatError extends DesktopError {
  constructor(kind: "newer" | "unsupported" | "invalid") {
    super(
      "registry-unreadable",
      kind === "newer"
        ? "A newer version of OwnBase saved the list of hosted workspaces. Update OwnBase to open it. The list was not changed."
        : kind === "unsupported"
          ? "This version of OwnBase cannot read the list of hosted workspaces. Use the version that saved it. The list was not changed."
          : "The list of hosted workspaces in OwnBase's settings file is damaged. Restore the settings file from a backup, or fix it, before hosting. The list was not changed.",
    );
    this.name = "RegistryFormatError";
  }
}

/** The folder earlier versions derived from a typed name. Kept so upgrades find it. */
export function legacyFolder(workspaceName: string): string {
  return (
    workspaceName
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "") || "workspace"
  );
}

/** A folder for a new workspace, unrelated to its name. */
export function newFolder(): string {
  return `w-${randomUUID().replaceAll("-", "")}`;
}

/**
 * Reads the registry back. Only `undefined` means the key is absent and may
 * be migrated from legacy folders. A present registry with an unreadable
 * format fails closed. A restored row keeps its hold when descriptive fields
 * need repair; an uncertain held identity fails closed instead of being
 * dropped and adopted as an ordinary workspace (N11).
 */
export function parseRegistry(value: unknown): HostedWorkspace[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RegistryFormatError("invalid");
  const { version, workspaces } = value as Record<string, unknown>;
  if (version !== 1)
    throw new RegistryFormatError(
      typeof version === "number" && version > 1 ? "newer" : "unsupported",
    );
  if (!Array.isArray(workspaces)) throw new RegistryFormatError("invalid");
  const folders = new Set<string>();
  const ids = new Set<string>();
  const entries: HostedWorkspace[] = [];
  for (const raw of workspaces) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const {
      id,
      folder,
      name,
      port,
      portChosen,
      lastHostedAt,
      lastBackupAt,
      autoBackup,
      restoredHold,
    } = raw as Record<string, unknown>;
    const held = restoredHold !== undefined;
    if (
      typeof folder !== "string" ||
      !FOLDER.test(folder) ||
      folders.has(folder) ||
      (id !== null && (typeof id !== "string" || !id || ids.has(id)))
    ) {
      if (held) throw new RegistryFormatError("invalid");
      continue;
    }
    const validName =
      typeof name === "string" && !!name.trim() && name.length <= WORKSPACE_NAME_MAX;
    const validPort =
      typeof port === "number" && Number.isInteger(port) && port >= 0 && port <= 65535;
    const validTime = typeof lastHostedAt === "number" && Number.isFinite(lastHostedAt);
    if (!held && (!validName || !validPort || !validTime)) continue;
    folders.add(folder);
    if (id) ids.add(id);
    entries.push({
      id,
      folder,
      name: validName ? (name as string) : folder,
      port: validPort ? (port as number) : 0,
      ...(typeof portChosen === "boolean" ? { portChosen } : {}),
      lastHostedAt: validTime ? (lastHostedAt as number) : 0,
      ...(typeof lastBackupAt === "number" && Number.isFinite(lastBackupAt)
        ? { lastBackupAt }
        : {}),
      ...(parseAutoBackup(autoBackup) ? { autoBackup: parseAutoBackup(autoBackup) } : {}),
      // Anything present holds it: a hold that cannot be read is still a hold.
      ...(restoredHold !== undefined
        ? {
            restoredHold:
              typeof restoredHold === "number" && Number.isFinite(restoredHold) ? restoredHold : 0,
          }
        : {}),
    });
  }
  return entries;
}

export function serializeRegistry(entries: HostedWorkspace[]) {
  return { version: 1, workspaces: entries };
}

/**
 * Adds an entry for every folder under `dataRoot` that holds a database and
 * that no entry names yet: the folders earlier versions made, or any the
 * registry lost. Folders stay where they are. `lastHosted` is what earlier
 * versions remembered; its folder becomes the most recent entry, on its port.
 * Returns the entries to add, and the folders that could not be read.
 */
export async function adoptFolders(options: {
  dataRoot: string;
  known: HostedWorkspace[];
  lastHosted: { workspaceName: string; port: number } | null;
  defaultPort: number;
  now: number;
  read: typeof readStoppedWorkspace;
}): Promise<{ adopted: HostedWorkspace[]; unreadable: string[] }> {
  let names: string[];
  try {
    names = (await readdir(options.dataRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { adopted: [], unreadable: [] };
  }
  const named = new Set(options.known.map((entry) => entry.folder));
  const ids = new Set(options.known.flatMap((entry) => (entry.id ? [entry.id] : [])));
  const remembered = options.lastHosted ? legacyFolder(options.lastHosted.workspaceName) : null;
  const adopted: HostedWorkspace[] = [];
  const unreadable: string[] = [];
  for (const folder of names.sort()) {
    if (!FOLDER.test(folder) || named.has(folder)) continue;
    const dataDir = join(options.dataRoot, folder);
    if (!existsSync(workspaceDatabase(dataDir))) continue;
    const found = options.read(dataDir);
    if (!found) {
      unreadable.push(folder);
      continue;
    }
    // A copy of a folder already listed is the same workspace twice. Starting
    // both would give two servers one identity, so the copy is left alone.
    if (found.id && ids.has(found.id)) continue;
    if (found.id) ids.add(found.id);
    const last = folder === remembered;
    adopted.push({
      id: found.id,
      folder,
      name: found.name?.trim().slice(0, WORKSPACE_NAME_MAX) || folder,
      port: last ? options.lastHosted!.port : options.defaultPort,
      lastHostedAt: last
        ? options.now
        : await stat(workspaceDatabase(dataDir)).then(
            (info) => Math.min(info.mtimeMs, options.now - 1),
            () => 0,
          ),
    });
  }
  return { adopted, unreadable };
}
