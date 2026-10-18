import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ACCESS_POLICIES, type AccessPolicy } from "@slackoss/protocol";
import { TunnelCleanupError, type Tunnel } from "./tunnel.js";
import {
  REGISTRY_KEY,
  RegistryFormatError,
  adoptFolders,
  legacyFolder,
  newFolder,
  parseAutoBackup,
  parseRegistry,
  readWorkspace,
  serializeRegistry,
  writeWorkspaceName,
  type AutoBackup,
  type BackupFailure,
  type BackupFailureKind,
  type HostedWorkspace,
} from "./registry.js";

export interface HostingSnapshot {
  running: boolean;
  phase: "stopped" | "starting" | "running" | "stopping";
  workspaceName?: string;
  /** The running workspace's entry in the list of hosted workspaces. */
  folder?: string;
  port?: number;
  /**
   * The running server's instance id, new on every start and also in its
   * network announcement, so a discovered workspace can be recognised as
   * this one rather than as anything else on the same port.
   */
  instanceId?: string;
  dataDir?: string;
  lanUrls?: string[];
  warning?: string;
  /** Published at a public address, for as long as this app is using it. */
  openToAll?: { phase: "opening" } | { phase: "open"; url: string };
  /** Why opening to all failed or ended, until it is tried again. */
  openToAllError?: string;
  /** Whether this computer has what opening to all needs. */
  tunnelAvailable?: boolean;
  /** A configured address that stays the same each time the link is opened. */
  publicAddress?: string;
  /** What the public address setting holds, valid or not, for editing. */
  publicAddressSetting?: string;
  /** Whether the environment set the address, so this app cannot change it. */
  publicAddressLocked?: boolean;
  /** Whether Tandem runs the connector, rather than something else. */
  publicAddressManaged?: boolean;
  /** Why a configured stable address cannot be used, and what to correct. */
  publicAddressError?: string;
  /** Whether an account after the first needs an invite code. */
  inviteOnly?: boolean;
  /** Who may join: invited accounts, any account, or guests too. */
  accessPolicy?: AccessPolicy;
  /** The running workspace is the one chosen to start when Tandem opens. */
  startsOnLaunch?: boolean;
  /**
   * What did not happen when Tandem opened: the workspace chosen to start
   * with it did not start, or started on this network without reopening its
   * stable address. Kept, whatever else runs meanwhile, until that part
   * recovers or the host dismisses it.
   */
  launchError?: string;
  /** Which part `launchError` is about. */
  launchErrorPart?: "hosting" | "public-address";
  /** The folder of the workspace `launchError` is about, when it is about one. */
  launchErrorFolder?: string;
  /** How many people are connected to the running workspace now. */
  connected?: number;
  /**
   * The running workspace is a restored copy started only for looking inside:
   * nothing queued is sent, no app is called, and only this computer reaches it.
   */
  isolated?: boolean;
  /** The running workspace reopens its stable public address when it starts with Tandem. */
  reopensPublicOnLaunch?: boolean;
}

/** The settings key naming, by its folder, the workspace to start when the app opens. */
export const START_ON_LAUNCH_KEY = "startOnLaunch";

/**
 * The settings key for reopening a stable public address when the workspace
 * starts with Tandem: which workspace, and which address, so a changed
 * address or another workspace is never published by it.
 */
export const REOPEN_PUBLIC_KEY = "reopenPublicOnLaunch";

/**
 * Calls through a tunnel still go directly between people, so each side has
 * to find its public address. Cloudflare already carries the tunnel, so its
 * STUN server adds nobody new.
 */
export const OPEN_TO_ALL_ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];

/**
 * What earlier versions remembered as hosted last, and what this one still
 * writes for them. They reopen by name, so it names a workspace only when an
 * earlier version would find that workspace's folder from it.
 */
export interface LastHosted {
  workspaceName: string;
  port: number;
}

/** One entry in the list of workspaces hosted on this computer, as the window sees it. */
export interface HostedWorkspaceSummary {
  folder: string;
  name: string;
  port: number;
  lastHostedAt: number;
  /** When a backup of it last finished, or null if none has here. */
  lastBackupAt: number | null;
  running: boolean;
  /** Its folder is gone, so it cannot start. */
  missing: boolean;
  /** Chosen to start when Tandem opens. */
  startsOnLaunch: boolean;
  /** Backed up by itself on a schedule, and where. */
  autoBackup: AutoBackup | null;
  /** Why the last scheduled backup did not finish, until one does. */
  autoBackupError: string | null;
  /** Restored from a backup and not yet put back in use. */
  restored: boolean;
}

/** A scheduled backup whose last try did not finish, for the tray to say so (OPS-02). */
export interface BackupAttention {
  folder: string;
  name: string;
  /** What the window says of it. */
  note: string;
  /** Whether trying again would make a backup: not when one was made and only removing older ones failed. */
  canRetry: boolean;
}

/**
 * Reads an earlier version's remembered workspace, refusing anything
 * malformed rather than starting hosting under a name or port nobody chose.
 */
export function parseLastHosted(value: unknown): LastHosted | null {
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

export interface HostedServer {
  port: number;
  /** The identity the server keeps in its database, recorded in the registry. */
  workspaceId?(): string | null;
  /** The name the server keeps, which may differ from a name typed before. */
  workspaceName?(): string;
  /** Renames the workspace while it runs, telling everyone connected. */
  setWorkspaceName?(name: string): void;
  /** Announces the workspace on the local network again, after a network change. */
  reannounce?(): void;
  /** How many people are connected now, and a way to hear when that changes. */
  connectedPeople?(): number;
  onConnectedChange?(listener: () => void): () => void;
  /** Identifies this run, so a public address can be confirmed to reach it. */
  instanceId?: string;
  stop(): Promise<void>;
  /** How the running server is reached and joined; see `WorkspaceServer`. */
  setPublicUrl?(url: string | null): void;
  setTrustLoopbackProxy?(enabled: boolean): void;
  setIceServers?(servers: { urls: string }[]): void;
  inviteOnly?(): boolean;
  setInviteOnly?(inviteOnly: boolean): void;
  accessPolicy?(): AccessPolicy;
  setAccessPolicy?(policy: AccessPolicy): void;
  /**
   * Hears the workspace renamed or who may join changed, by this host (`by`
   * null) or by an owner or admin in Workspace settings. Returns how to stop.
   */
  onWorkspaceChange?(listener: (change: HostedWorkspaceChange) => void): () => void;
  /** How many accounts exist, so opening to all can wait for the owner's. */
  accountCount?(): number;
}

/** A change to the running workspace, as `HostedServer.onWorkspaceChange` reports it. */
export interface HostedWorkspaceChange {
  workspaceName?: string;
  accessPolicy?: AccessPolicy;
  /** The owner or admin who made it, or null when this host did. */
  by: string | null;
}

interface HostingOptions {
  /** `workspaceName` is given for a new workspace only; an existing one keeps its own. */
  startServer(options: {
    workspaceName?: string;
    port: number;
    dataDir: string;
    /** A restored copy started only for looking inside; see `HostedWorkspace.restoredHold`. */
    isolated?: boolean;
  }): Promise<HostedServer>;
  /** Where the list of hosted workspaces is kept. `strict` reads throw when the file is unreadable. */
  settings: {
    get(
      key: string,
      options?: { strict?: boolean; distinguishMissing?: boolean },
    ): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  /** Reads a workspace's identity from its folder without starting it. */
  readWorkspace?: typeof readWorkspace;
  /** Writes a stopped workspace's new name into its database. */
  writeWorkspaceName?: typeof writeWorkspaceName;
  /**
   * Shows a folder in the system's file manager, as Electron's
   * `shell.openPath` does: resolves to why it could not, or to "" when it did.
   */
  openFolder?(path: string): Promise<string>;
  /** The server's verified backup: a consistent copy of the database and every attachment. */
  backupWorkspace?(options: { dataDir: string; out: string }): Promise<{ files: unknown[] }>;
  /** Bytes free on the disk holding `dir`. */
  freeBytes?(dir: string): Promise<number>;
  /** The server's check of a backup's checksums and database, returning its manifest. */
  verifyBackup?(dir: string): Promise<{
    workspaceName: string;
    database: { bytes: number };
    files: { bytes: number }[];
  }>;
  /** What a checked backup would reach or set off once started, for the host to see. */
  inventoryBackup?(dir: string): Promise<RestoreInventory>;
  /** The server's restore: verified, staged beside `dataDir`, then swapped in. */
  restoreWorkspace?(options: { backupDir: string; dataDir: string }): Promise<unknown>;
  now?: () => number;
  dataRoot: string;
  defaultPort: number;
  lanUrls(port: number): string[];
  onChange?(): void;
  /** Opens a tunnel to a port on this computer. Absent where there is none to open. */
  openTunnel?(port: number, signal: AbortSignal, instanceId?: string): Promise<Tunnel>;
  /** Whether a tunnel could be opened now. */
  tunnelAvailable?(): boolean;
  /**
   * The stable public address configured for this computer: what the setting
   * holds, the address that passed validation, who carries it, and what is
   * wrong with it. Absent where only temporary addresses are available.
   */
  publicAddress?(): {
    setting?: string;
    locked?: boolean;
    url?: string;
    managed?: boolean;
    error?: string;
  };
  /** Persists an address the host supplied, after the controller makes the change safe. */
  savePublicAddress?(address: string | null): Promise<void>;
  /**
   * Whether `http://127.0.0.1:<port>` answers as this run. Windows lets a
   * wildcard bind succeed beside an existing loopback one, so holding the
   * port does not prove the port reaches us. Absent where nothing can check.
   */
  verifyLoopback?(port: number, instanceId?: string): Promise<boolean>;
  /**
   * A stop that never answers stays owned and can be retried, rather than
   * blocking quit forever. A quit waits this long too for work ahead of it.
   */
  cleanupTimeoutMs?: number;
}

type StartRequest = ({ workspaceName: string } | { folder: string }) & {
  port?: number;
  /** Puts a restored workspace back in use, rather than starting it only to look inside. */
  activate?: boolean;
};

/** What a restored backup brings with it, as the server's inventory reports it. */
export interface RestoreInventory {
  appAddresses: { origin: string; uses: string[] }[];
  scheduled: { waiting: number; earliestAt: number | null };
  undeliveredEvents: number;
  sessions: number;
}

/**
 * Why a workspace did not start, fit to show. A system error's own message
 * names paths, and with them the account, so it is described by its code.
 */
function startFailure(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code))
    return new Error(
      `The workspace could not start (${code}). Check that its data folder is writable and its port is free, then try again.`,
    );
  return error instanceof Error ? error : new Error("The workspace could not start.");
}

/** A port someone chose: a whole number a program may listen on. */
function portOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error("Choose a port from 1 to 65535.");
  return value;
}

/** A name as typed, trimmed, for a new workspace or a rename alike. */
function workspaceNameOf(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 80 ||
    /\p{Cc}/u.test(value)
  )
    throw new Error("Use a workspace name of 1 to 80 characters without control characters.");
  return value.trim();
}

/**
 * `{ folder }` starts a workspace already in the list. `{ workspaceName }`
 * always makes a new one: nothing is ever found by its name.
 */
function startOptions(value: unknown): StartRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose a workspace name before starting hosting.");
  const { workspaceName, folder, port, activate } = value as Record<string, unknown>;
  if (activate !== undefined && typeof activate !== "boolean")
    throw new Error("Say whether to put the workspace back in use with true or false.");
  if (
    port !== undefined &&
    (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
  )
    throw new Error("The hosting port must be a whole number from 0 to 65535.");
  if (folder !== undefined) {
    if (typeof folder !== "string" || workspaceName !== undefined)
      throw new Error("Choose one workspace to start.");
    return { folder, port: port as number | undefined, ...(activate ? { activate: true } : {}) };
  }
  return { workspaceName: workspaceNameOf(workspaceName), port: port as number | undefined };
}

/**
 * What earlier versions are told they hosted last. They reopen by name, so
 * it names the entry only when that name leads them to the entry's folder.
 */
function legacyPointer(entry: HostedWorkspace | undefined): LastHosted | null {
  return entry && entry.folder === legacyFolder(entry.name)
    ? { workspaceName: entry.name, port: entry.port }
    : null;
}

/** The entry started most recently, which the resume offer names. */
function mostRecent(entries: HostedWorkspace[]): HostedWorkspace | null {
  return entries.reduce<HostedWorkspace | null>(
    (best, entry) => (!best || entry.lastHostedAt > best.lastHostedAt ? entry : best),
    null,
  );
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

/** The name `backup` gives a backup's folder: the workspace's name, then when. */
const BACKUP_NAME = /^[a-z0-9-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

function megabytes(bytes: number): string {
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
function backupFailureNote(name: string, failure: BackupFailure | undefined): string | null {
  if (!failure) return null;
  return (
    failure.kind === "cleanup"
      ? `The scheduled backup of ${name} was made, but older ones there could not be removed. ${failure.message}`
      : `The scheduled backup of ${name} did not finish. ${failure.message}`
  ).trim();
}

/** Owns the embedded server, including operations accepted just before app shutdown. */
export function createHostingController(options: HostingOptions) {
  let server: HostedServer | null = null;
  let workspace: { workspaceName: string; folder: string; dataDir: string } | null = null;
  /** The running workspace is a restored copy started only to look inside. */
  let isolatedRun = false;
  /** What `REOPEN_PUBLIC_KEY` holds, once read; null when nothing is to reopen. */
  let reopenPublic: { folder: string; address: string } | null | undefined;
  let phase: HostingSnapshot["phase"] = "stopped";
  const now = options.now ?? Date.now;
  const read = options.readWorkspace ?? readWorkspace;
  const writeName = options.writeWorkspaceName ?? writeWorkspaceName;
  /** Every workspace hosted here, once read. Null until then, or while it cannot be. */
  let registry: HostedWorkspace[] | null = null;
  let registryLoad: Promise<HostedWorkspace[]> | null = null;
  /** Folders adoption could not read, named until the registry is read again. */
  let unreadableFolders: string[] = [];
  let warning: string | undefined;
  /**
   * Kept apart from `warning`, which saving settings clears on its next
   * success. Where this run is listening is true until it stops.
   */
  let portWarning: string | undefined;
  let metadataDirty = false;
  let stopFailed = false;
  let pending: Promise<unknown> = Promise.resolve();
  let closing = false;
  let shutdownPromise: Promise<void> | null = null;
  let tunnel: Tunnel | null = null;
  /** A connector returned before cancellation/setup failed, not safe to publish or forget. */
  let cleanupTunnel: Tunnel | null = null;
  /** The current address is carried by a process outside this app's control. */
  let externalCarrier = false;
  /**
   * Who could join before the public link opened. Guests let in while it is
   * open leave with it; any other rule chosen then stays, as it always has.
   * An owner or admin choosing in Workspace settings meanwhile forgets it:
   * what they chose is the workspace's, and closing the link keeps it.
   */
  let policyBeforeOpen: AccessPolicy | undefined;
  /**
   * Counts who-may-join changes made inside the workspace by an owner or
   * admin. A step that read the rule before waiting puts back what it read
   * only if this has not moved meanwhile, so it never undoes their choice.
   */
  let workspacePolicyChanges = 0;
  /** Set while a tunnel is opening, so stopping or quitting need not wait for it. */
  let opening: AbortController | null = null;
  let openError: string | undefined;
  /** Invalidates public-open requests that were queued before a close or stop. */
  let publicRequest = 0;
  /** Counts starts, so a step that waited can tell the run it began with from a later one. */
  let runs = 0;
  /**
   * The folder of the workspace to start when the app opens, once read: null
   * for none, undefined until read. Kept so a status snapshot, which cannot
   * wait for the settings file, can say whether the running one is it.
   */
  let launchFolder: string | null | undefined;
  let launchError:
    { message: string; part: "hosting" | "public-address"; folder: string | null } | undefined;
  /** Stops listening for who connects to the running server. */
  let stopWatchingConnections: (() => void) | null = null;
  /** Stops following the running workspace's name and who may join. */
  let stopFollowingWorkspace: (() => void) | null = null;

  function changed(): void {
    // A renderer/tray notification must never lose ownership of a live server.
    try {
      options.onChange?.();
    } catch {
      // The next snapshot still reports the actual state.
    }
  }

  /**
   * Read for each snapshot, so correcting the configuration takes effect
   * without a restart. Configuration that cannot be read at all leaves the
   * temporary address available rather than failing the status call.
   */
  function publicAddress(): NonNullable<ReturnType<NonNullable<HostingOptions["publicAddress"]>>> {
    try {
      return options.publicAddress?.() ?? {};
    } catch {
      return {};
    }
  }

  function status(): HostingSnapshot {
    const address = publicAddress();
    return {
      running: server !== null,
      phase,
      ...(workspace ?? {}),
      ...(server ? { port: server.port, lanUrls: options.lanUrls(server.port) } : {}),
      ...(server?.instanceId ? { instanceId: server.instanceId } : {}),
      ...(server?.inviteOnly ? { inviteOnly: server.inviteOnly() } : {}),
      ...(server?.accessPolicy ? { accessPolicy: server.accessPolicy() } : {}),
      ...(opening
        ? { openToAll: { phase: "opening" as const } }
        : tunnel
          ? { openToAll: { phase: "open" as const, url: tunnel.url } }
          : {}),
      ...(openError ? { openToAllError: openError } : {}),
      ...(options.tunnelAvailable ? { tunnelAvailable: options.tunnelAvailable() } : {}),
      ...(address.url ? { publicAddress: address.url } : {}),
      ...(address.setting ? { publicAddressSetting: address.setting } : {}),
      ...(address.locked ? { publicAddressLocked: true } : {}),
      ...(address.managed ? { publicAddressManaged: true } : {}),
      ...(address.error ? { publicAddressError: address.error } : {}),
      ...(portWarning || warning
        ? { warning: [portWarning, warning].filter(Boolean).join(" ") }
        : {}),
      ...(server && workspace && launchFolder === workspace.folder ? { startsOnLaunch: true } : {}),
      ...(server?.connectedPeople ? { connected: server.connectedPeople() } : {}),
      ...(launchError
        ? {
            launchError: launchError.message,
            launchErrorPart: launchError.part,
            ...(launchError.folder ? { launchErrorFolder: launchError.folder } : {}),
          }
        : {}),
      ...(server && isolatedRun ? { isolated: true } : {}),
      ...(server &&
      workspace &&
      reopenPublic &&
      reopenPublic.folder === workspace.folder &&
      reopenPublic.address === address.url
        ? { reopensPublicOnLaunch: true }
        : {}),
    };
  }

  /** The folder chosen to start when the app opens. An unreadable setting is no choice. */
  /**
   * The workspace chosen to start with the app, or null when none was. A
   * choice that cannot be read is not "none": it throws, and nothing is kept,
   * so reading again after the settings file is repaired finds it.
   */
  async function readLaunchFolder(): Promise<string | null> {
    if (launchFolder !== undefined) return launchFolder;
    const stored = await options.settings.get(START_ON_LAUNCH_KEY, { strict: true });
    if (stored !== null && (typeof stored !== "string" || !stored))
      throw new Error("The workspace chosen to start with Tandem is not one it can read.");
    launchFolder = stored;
    return launchFolder;
  }

  /** Back to reachable only on this network: no public address, no STUN. */
  function closeReach(target: HostedServer): void {
    for (const clear of [
      () => target.setTrustLoopbackProxy?.(false),
      () => target.setPublicUrl?.(null),
      () => target.setIceServers?.([]),
    ]) {
      try {
        clear();
      } catch {
        // Keep clearing the other public state even if an implementation fails.
      }
    }
  }

  async function endTunnel(): Promise<void> {
    const current = tunnel ?? cleanupTunnel;
    if (!current) return;
    const openPolicy =
      tunnel === current && !externalCarrier && server ? policyOf(server) : undefined;
    const previousPolicy =
      openPolicy === "guest_allowed" && policyBeforeOpen && policyBeforeOpen !== "guest_allowed"
        ? policyBeforeOpen
        : openPolicy;
    policyBeforeOpen = undefined;
    const policyChanges = workspacePolicyChanges;
    // A close may reject or time out while its connector is still exiting.
    // Keep every public-access mutation gated until that same handle closes.
    cleanupTunnel = current;
    // Remove the public address from new links before asking the connector to
    // drain. Keep its handle/status until exit is confirmed so closing can be
    // retried if the child process refuses to stop.
    if (server) {
      closeReach(server);
      // Stopping our use of an external route cannot stop that route. Keep it
      // from becoming an open-registration endpoint if it is still running.
      if (externalCarrier || cleanupTunnel) server.setInviteOnly?.(true);
    }
    await finishCleanup(current.close(), "The public link did not finish closing in time.");
    if (tunnel === current) {
      tunnel = null;
      externalCarrier = false;
    }
    if (cleanupTunnel === current) {
      cleanupTunnel = null;
    }
    // Chosen inside the workspace while the link closed, the rule stays theirs.
    if (previousPolicy !== undefined && server && policyChanges === workspacePolicyChanges)
      applyPolicy(server, previousPolicy);
  }

  async function finishCleanup(work: Promise<void>, message: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), options.cleanupTimeoutMs ?? 30_000);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function cancelPublicOpen(): void {
    publicRequest += 1;
    opening?.abort();
  }

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = pending.catch(() => {}).then(operation);
    pending = next;
    return next;
  }

  /**
   * Whether loopback leads somewhere other than this run. Only a clear "no"
   * counts: a probe that cannot be made, throws, or is slow says nothing
   * about who owns the port, and a false alarm here would be worse than
   * silence.
   */
  async function loopbackTaken(target: HostedServer): Promise<boolean> {
    if (!options.verifyLoopback) return false;
    try {
      return !(await options.verifyLoopback(target.port, target.instanceId));
    } catch {
      return false;
    }
  }

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
      // Kept in memory if this fails, and written with the next change.
      if (adopted.length > 0) await saveRegistry().catch(() => {});
      return registry;
    })().finally(() => {
      registryLoad = null;
    });
    return registryLoad;
  }

  function saveRegistry(): Promise<void> {
    return options.settings.set(REGISTRY_KEY, serializeRegistry(registry ?? []));
  }

  function updateEntry(folder: string, change: Partial<HostedWorkspace>): void {
    registry = (registry ?? []).map((entry) =>
      entry.folder === folder ? { ...entry, ...change } : entry,
    );
  }

  async function saveMetadata(): Promise<void> {
    if (!server || !workspace) return;
    try {
      await saveRegistry();
      // Earlier versions find a folder from its name. Name one to them only
      // when that leads to this workspace, never to a different one.
      await options.settings.set(
        "lastHosted",
        legacyPointer(registry?.find((e) => e.folder === workspace!.folder)),
      );
      metadataDirty = false;
      if (!stopFailed) warning = undefined;
    } catch {
      metadataDirty = true;
      if (!stopFailed)
        warning =
          "The workspace is running, but its last-used hosting settings could not be saved.";
    }
    changed();
  }

  function start(value: unknown): Promise<HostingSnapshot> {
    if (closing) return Promise.reject(new Error("The app is quitting. Hosting cannot start."));
    let requested: ReturnType<typeof startOptions>;
    try {
      requested = startOptions(value);
    } catch (error) {
      return Promise.reject(error);
    }
    return serialized(async () => {
      if (server) {
        if (stopFailed || cleanupTunnel)
          throw new Error("Finish stopping the workspace before starting it again.");
        const same =
          "folder" in requested
            ? requested.folder === workspace?.folder
            : requested.workspaceName === workspace?.workspaceName;
        if (!same)
          throw new Error(
            "Another workspace is already running. Stop it before starting this one.",
          );
        if (requested.activate && isolatedRun)
          throw new Error(
            `Stop looking inside ${workspace?.workspaceName ?? "the restored workspace"} before putting it back in use.`,
          );
        if (requested.port !== undefined && requested.port !== 0 && requested.port !== server.port)
          throw new Error(
            "This workspace is already running on another port. Stop it before changing ports.",
          );
        if (metadataDirty) await saveMetadata();
        return status();
      }

      let list: HostedWorkspace[];
      try {
        list = await loadRegistry();
      } catch (error) {
        if (error instanceof RegistryFormatError) throw error;
        throw new Error(
          "Tandem could not read its list of hosted workspaces, so it will not start one. Check that its settings file can be read, then try again.",
        );
      }
      let entry: HostedWorkspace;
      const created = !("folder" in requested);
      if ("folder" in requested) {
        const found = list.find((e) => e.folder === requested.folder);
        if (!found) throw new Error("That workspace is not in the list hosted on this computer.");
        const dataDir = join(options.dataRoot, found.folder);
        // Never recreated empty: an empty folder would look like the workspace.
        if (!existsSync(dataDir))
          throw new Error(`The folder that held ${found.name} is missing, so it cannot start.`);
        if (found.id) {
          const inside = read(dataDir);
          if (!inside)
            throw new Error(
              `${found.name}'s database is missing or unreadable, so it cannot start.`,
            );
          // A folder copied or swapped by hand holds some other workspace.
          if (inside.id !== found.id)
            throw new Error(
              `The folder for ${found.name} holds a different workspace, so it will not start.`,
            );
        }
        entry = found;
      } else {
        // A new folder that has nothing to do with the name. It is listed
        // before the server starts in it, so the app can always find it again.
        entry = {
          id: null,
          folder: newFolder(),
          name: requested.workspaceName,
          port: requested.port ?? options.defaultPort,
          portChosen: requested.port !== undefined && requested.port !== 0,
          lastHostedAt: now(),
        };
        const dataDir = join(options.dataRoot, entry.folder);
        await mkdir(options.dataRoot, { recursive: true });
        await mkdir(dataDir);
        registry = [...list, entry];
        try {
          await saveRegistry();
        } catch {
          registry = list;
          await rm(dataDir, { recursive: true, force: true }).catch(() => {});
          throw new Error(
            "Tandem could not add the workspace to its settings, so it did not create it. Check that its settings folder is writable, then try again.",
          );
        }
      }
      workspace = {
        workspaceName: entry.name,
        folder: entry.folder,
        dataDir: join(options.dataRoot, entry.folder),
      };
      // A restored workspace starts only for looking inside until it is put
      // back in use on purpose: its queue, apps and sign-ins are live otherwise.
      const isolated = !created && entry.restoredHold !== undefined && !requested.activate;
      // Looked inside, it listens on a port the system picks, never the one
      // it is listed with or the usual one: a tunnel, port forward or link
      // still aimed at those must not reach it. Its listed port waits for
      // it to be put back in use.
      const preferred = isolated
        ? 0
        : (requested.port ?? (created ? options.defaultPort : entry.port));
      const usualPorts = new Set([options.defaultPort, ...list.map((e) => e.port)]);
      // A port asked for now, or chosen before, is kept; only an automatic one
      // may move. Entries from before this was recorded count a port other
      // than the usual one as chosen, since that is how it usually got there.
      const portChosen =
        requested.port !== undefined
          ? requested.port !== 0
          : (entry.portChosen ?? entry.port !== options.defaultPort);
      const serverOptions = {
        dataDir: workspace.dataDir,
        // An existing workspace keeps the name it has; only a new one is given one.
        ...(created ? { workspaceName: entry.name } : {}),
        ...(isolated ? { isolated: true } : {}),
      };
      phase = "starting";
      warning = undefined;
      portWarning = undefined;
      changed();
      let movedFrom: number | undefined;
      try {
        try {
          server = await options.startServer({ ...serverOptions, port: preferred });
        } catch (error) {
          // Only the automatic port choice may change behind the user's back.
          // A port someone asked for is theirs to change.
          if (portChosen && (error as NodeJS.ErrnoException)?.code === "EADDRINUSE")
            throw new Error(
              created || requested.port !== undefined
                ? `Port ${preferred} is already in use on this computer. Choose another, or leave the port empty to use one that is free.`
                : `Port ${preferred}, chosen for ${entry.name}, is already in use on this computer, so it did not start. Close the program using it, or change ${entry.name}'s port. Its port was not changed.`,
            );
          if (portChosen || (error as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw error;
          server = await options.startServer({ ...serverOptions, port: 0 });
          // Whatever holds the usual port is still answering there. Anything
          // aimed at it now reaches that program instead of this workspace.
          movedFrom = preferred;
        }
        // The system can happen to pick a port a workspace here is listed
        // with. A restored copy then gives it back and asks again.
        for (let tries = 1; isolated && usualPorts.has(server.port); tries++) {
          const unwanted = server;
          await finishCleanup(
            unwanted.stop(),
            "The restored workspace did not finish stopping in time.",
          );
          server = null;
          if (tries === 3)
            throw new Error(
              `Tandem could not find a free port for looking inside ${entry.name}. Try again.`,
            );
          server = await options.startServer({ ...serverOptions, port: 0 });
        }
      } catch (error) {
        if (server) {
          // A rejected replacement-port cleanup still owns its live server (N12).
          isolatedRun = isolated;
          stopFailed = true;
          phase = "running";
          warning =
            "The restored workspace could not finish stopping. Stop it before trying again.";
          changed();
          throw startFailure(error);
        }
        // The caller reports the failure. A lasting warning would repeat it, and
        // would still be showing long after the next attempt was made elsewhere.
        phase = "stopped";
        workspace = null;
        // A new workspace that never started holds nothing. Take it back out,
        // so trying again does not leave empty workspaces in the list.
        if (created) {
          registry = list;
          await saveRegistry()
            .then(() => rm(join(options.dataRoot, entry.folder), { recursive: true, force: true }))
            .catch(() => {});
        }
        changed();
        throw startFailure(error);
      }
      updateEntry(entry.folder, {
        id: server.workspaceId?.() ?? entry.id,
        name: server.workspaceName?.() ?? entry.name,
        // A restored copy being looked inside keeps the port it is listed with.
        ...(isolated ? {} : { port: server.port, portChosen }),
        lastHostedAt: now(),
        ...(requested.activate ? { restoredHold: undefined } : {}),
      });
      runs += 1;
      isolatedRun = isolated;
      // So the status can say whether this workspace reopens its address.
      void readReopenPublic().then(
        (value) => {
          if (value && value.folder === workspace?.folder) changed();
        },
        () => {},
      );
      workspace.workspaceName = server.workspaceName?.() ?? entry.name;
      phase = "running";
      // Hosting has started, which is what a failed start needed. An address
      // that was not reopened is still not open, and stays said until it is.
      if (launchError?.part === "hosting") launchError = undefined;
      stopWatchingConnections = server.onConnectedChange?.(changed) ?? null;
      const following = entry.folder;
      stopFollowingWorkspace =
        server.onWorkspaceChange?.((change) => followWorkspace(following, change)) ?? null;
      // A carrier forwards to one port and keeps forwarding there. Say so
      // while it can still be corrected, rather than letting Open to all
      // fail later with only "did not answer as this workspace".
      if (movedFrom !== undefined) {
        const configured = publicAddress().url;
        portWarning = configured
          ? `Port ${movedFrom} was already in use, so this workspace is on ${server.port}. Point ${configured} at http://127.0.0.1:${server.port}, or it will reach whatever is using ${movedFrom}.`
          : `Port ${movedFrom} was already in use, so this workspace is on ${server.port}. Links that name ${movedFrom} will not reach it.`;
      } else if (await loopbackTaken(server)) {
        portWarning =
          `Another program is answering on http://127.0.0.1:${server.port}, so anything sent there reaches it and not this workspace. ` +
          `Stop that program and start hosting again, or host on a different port. Teammates on this network can still use ${options.lanUrls(server.port)[0] ?? "this computer's network address"}.`;
      }
      changed();
      // Binding succeeded. A settings failure is a warning, never a failed start.
      await saveMetadata();
      return status();
    });
  }

  /**
   * The scheduled backups whose last try did not finish, from the list as
   * last read. A restored copy waiting to be put back in use is left out:
   * its schedule is not running.
   */
  function backupAttention(): BackupAttention[] {
    return (registry ?? []).flatMap((entry) => {
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

  /** Every workspace hosted here, most recent first, and the folders that could not be read. */
  async function list(): Promise<{ workspaces: HostedWorkspaceSummary[]; unreadable: string[] }> {
    const entries = await loadRegistry();
    // The list is still worth showing when only this choice cannot be read.
    const starting = await readLaunchFolder().catch(() => null);
    return {
      workspaces: [...entries]
        .sort((a, b) => b.lastHostedAt - a.lastHostedAt)
        .map((entry) => ({
          folder: entry.folder,
          name: entry.name,
          port: entry.port,
          lastHostedAt: entry.lastHostedAt,
          lastBackupAt: entry.lastBackupAt ?? null,
          running: server !== null && workspace?.folder === entry.folder,
          missing: !existsSync(join(options.dataRoot, entry.folder)),
          startsOnLaunch: entry.folder === starting,
          autoBackup: entry.autoBackup ?? null,
          autoBackupError:
            entry.autoBackup?.warning ??
            backupFailureNote(entry.name, entry.autoBackup?.failure) ??
            entry.autoBackup?.retry?.error ??
            null,
          restored: entry.restoredHold !== undefined,
        })),
      unreadable: unreadableFolders,
    };
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
    if (!options.backupWorkspace)
      return Promise.reject(new Error("Backing up is not available in this app."));
    return serialized(async () => {
      if (closing) throw new Error("The app is quitting.");
      const entry = (await loadRegistry()).find((e) => e.folder === folder);
      if (!entry) throw new Error("That workspace is not in the list hosted on this computer.");
      return backupNow(entry, destination);
    });
  }

  /** The copy itself, for a caller already holding the serialized turn. */
  async function backupNow(
    entry: HostedWorkspace,
    destination: string,
  ): Promise<{ path: string; at: number }> {
    const dataDir = join(options.dataRoot, entry.folder);
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
    if (options.freeBytes) {
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
    }
    const found = read(dataDir);
    if (entry.id && found?.id !== entry.id)
      throw new BackupFailed(
        "source",
        `The folder listed as ${entry.name} holds ${
          found?.name ? `“${found.name}”` : "a different or unreadable workspace"
        } instead, so nothing was backed up.`,
      );
    const expected = entry.id ?? found?.id ?? null;
    // Two backups in one second would want one name; the later moves on a second.
    let at = now();
    const named = (time: number) =>
      join(
        destination,
        `${legacyFolder(entry.name)}-${new Date(time).toISOString().slice(0, 19).replaceAll(":", "-")}`,
      );
    while (existsSync(named(at))) at += 1000;
    const out = named(at);
    await options.backupWorkspace!({ dataDir, out });
    if (read(out)?.id !== expected) {
      // A copy of something else must not stand in for this workspace's backup.
      await rm(out, { recursive: true, force: true }).catch(() => {});
      throw new BackupFailed(
        "source",
        `The folder of ${entry.name} changed while it was being copied, so the copy was removed. Try again.`,
      );
    }
    const done = now();
    updateEntry(entry.folder, { lastBackupAt: done });
    // The backup is made and verified either way. Only the date shown for it can be lost.
    await saveRegistry().catch(() => {});
    changed();
    return { path: out, at: done };
  }

  /**
   * Restores a backup as a workspace hosted here, without starting it. A
   * workspace this computer does not list gets a new folder. One it lists
   * whose folder is gone comes back into that folder. One still here is left
   * alone: replacing it is a separate, confirmed step.
   */
  function restore(
    value: unknown,
  ): Promise<{ folder: string; name: string; inventory: RestoreInventory | null }> {
    const { backupDir } = (value ?? {}) as Record<string, unknown>;
    if (typeof backupDir !== "string" || !isAbsolute(backupDir))
      return Promise.reject(new Error("Choose the folder of a backup to restore."));
    if (!options.verifyBackup || !options.restoreWorkspace)
      return Promise.reject(new Error("Restoring is not available in this app."));
    return serialized(async () => {
      if (closing) throw new Error("The app is quitting.");
      const list = await loadRegistry();
      const manifest = await options.verifyBackup!(backupDir);
      const id = read(backupDir)?.id ?? null;
      const listed = id ? list.find((e) => e.id === id) : undefined;
      if (listed && existsSync(join(options.dataRoot, listed.folder)))
        throw new Error(
          `${listed.name} is already hosted on this computer, so this backup was not restored over it.`,
        );
      await mkdir(options.dataRoot, { recursive: true });
      if (options.freeBytes) {
        const size = manifest.database.bytes + manifest.files.reduce((n, f) => n + f.bytes, 0);
        // Staged beside its folder and checked before it is swapped in.
        const needed = Math.ceil(size * 1.1) + 16 * 1024 * 1024;
        const free = await options.freeBytes(options.dataRoot);
        if (free < needed)
          throw new Error(
            `There is not enough free space for it. Restoring needs about ${megabytes(needed)}, and ${megabytes(free)} is free.`,
          );
      }
      const entry: HostedWorkspace = {
        ...(listed ?? {
          id,
          folder: newFolder(),
          name: manifest.workspaceName.trim().slice(0, 80) || "Restored workspace",
          port: options.defaultPort,
          lastHostedAt: now(),
        }),
        // Held until someone puts it back in use, across restarts too.
        restoredHold: now(),
      };
      const dataDir = join(options.dataRoot, entry.folder);
      const unsaved = () =>
        new Error(
          "Tandem could not save its settings, so it did not restore the backup. Check that its settings folder is writable, then try again.",
        );
      // Listed and held before anything is restored, as a new workspace is
      // listed before it starts, so a restored one can always be found and
      // is never taken for the workspace itself, even after a restart.
      registry = listed ? list.map((e) => (e === listed ? entry : e)) : [...list, entry];
      try {
        await saveRegistry();
      } catch {
        registry = list;
        throw unsaved();
      }
      // Nor may it start by itself as though nothing had happened, here or in
      // an earlier version that knows nothing of the hold.
      const wasLaunch = (await readLaunchFolder().catch(() => null)) === entry.folder;
      if (wasLaunch) {
        try {
          await options.settings.set(START_ON_LAUNCH_KEY, null);
        } catch {
          registry = list;
          await saveRegistry().catch(() => {});
          throw unsaved();
        }
        launchFolder = null;
      }
      try {
        await options.restoreWorkspace!({ backupDir, dataDir });
      } catch (error) {
        // Nothing arrived, so everything goes back to how it was. Anything
        // that did arrive stays listed and held.
        if (!existsSync(dataDir)) {
          registry = list;
          await saveRegistry().catch(() => {});
          if (wasLaunch)
            await options.settings.set(START_ON_LAUNCH_KEY, entry.folder).then(
              () => (launchFolder = entry.folder),
              () => {},
            );
        }
        throw error;
      }
      const name = manifest.workspaceName.trim().slice(0, 80) || entry.name;
      updateEntry(entry.folder, { name });
      // The hold is saved already. Only the name shown for it can be lost.
      await saveRegistry().catch(() => {});
      const inventory = options.inventoryBackup
        ? await options.inventoryBackup(backupDir).catch(() => null)
        : null;
      changed();
      return { folder: entry.folder, name, inventory };
    });
  }

  /**
   * Takes a workspace whose folder is gone out of the list. One whose folder
   * is still there would only be adopted again on the next launch, so it stays.
   */
  function forget(value: unknown): Promise<void> {
    if (typeof value !== "string")
      return Promise.reject(new Error("Choose a workspace to remove."));
    return serialized(async () => {
      const list = await loadRegistry();
      const entry = list.find((e) => e.folder === value);
      if (!entry) return;
      if (existsSync(join(options.dataRoot, entry.folder)))
        throw new Error(`${entry.name} is still on this computer, so it stays in the list.`);
      registry = list.filter((e) => e.folder !== entry.folder);
      try {
        await saveRegistry();
      } catch (error) {
        registry = list;
        throw error;
      }
      // Nothing is left to start when the app opens.
      if ((await readLaunchFolder().catch(() => null)) === entry.folder) {
        launchFolder = null;
        await options.settings.set(START_ON_LAUNCH_KEY, null).catch(() => {});
      }
      changed();
    });
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
      if (closing) throw new Error("The app is quitting.");
      const entry = (await loadRegistry()).find((e) => e.folder === folder);
      if (!entry) throw new Error("That workspace is not in the list hosted on this computer.");
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
      updateEntry(entry.folder, { autoBackup: chosen ?? undefined });
      try {
        await saveRegistry();
      } catch {
        updateEntry(entry.folder, { autoBackup: previous });
        throw new Error(
          "Tandem could not save the backup schedule. Check that its settings folder is writable, then try again.",
        );
      }
      changed();
      return chosen;
    });
  }

  /**
   * Removes a workspace's older backups from its schedule's folder, keeping
   * `keep` recoverable copies: the one just made, which the server has
   * verified, and the newest others that pass the same check. A copy that
   * fails it never counts towards `keep`, so a damaged or oddly dated folder
   * cannot take a good copy's place. Only a folder this app named, holding a
   * backup of this very workspace, is ever removed; anything else there is
   * left alone.
   */
  async function pruneBackups(
    entry: HostedWorkspace,
    schedule: AutoBackup,
    fresh: string,
  ): Promise<void> {
    if (!entry.id) return;
    const found: { path: string; at: string }[] = [];
    for (const item of await readdir(schedule.destination, { withFileTypes: true })) {
      if (!item.isDirectory() || !BACKUP_NAME.test(item.name)) continue;
      const path = join(schedule.destination, item.name);
      if (path === fresh) continue;
      if (!existsSync(join(path, "manifest.json"))) continue;
      if (read(path)?.id !== entry.id) continue;
      found.push({ path, at: item.name.slice(-19) });
    }
    // Newest first by the time in its name. A clock set wrong can make that
    // order lie, which is why only checked copies count and the fresh one stays.
    found.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    let kept = 1;
    for (const candidate of found) {
      if (kept >= schedule.keep) {
        await rm(candidate.path, { recursive: true, force: true });
        continue;
      }
      let recoverable = false;
      try {
        if (options.verifyBackup) {
          await options.verifyBackup(candidate.path);
          recoverable = read(candidate.path)?.id === entry.id;
        }
      } catch {
        recoverable = false;
      }
      // One that fails is neither counted nor removed while copies are still wanted.
      if (recoverable) kept++;
    }
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
      } while (dueAgain && !closing);
    })().finally(() => {
      duePass = null;
    });
    return duePass;
  }

  async function dueOnce(retryFailed: boolean): Promise<void> {
    let entries: HostedWorkspace[];
    try {
      entries = await loadRegistry();
    } catch {
      return;
    }
    for (const { folder } of entries) {
      if (closing) return;
      try {
        const ran = await serialized(async () => {
          const entry = (await loadRegistry()).find((e) => e.folder === folder);
          const schedule = entry?.autoBackup;
          // A restored copy is neither backed up nor allowed to remove older
          // backups until it is put back in use: a newer one there may be the
          // only copy of what the restore went back past.
          if (!entry || !schedule || entry.restoredHold !== undefined || closing) return false;
          if (!existsSync(join(options.dataRoot, entry.folder))) return false;
          if (schedule.retry && now() < schedule.retry.nextAt && !retryFailed) return false;
          // Never backed up by this schedule into its folder, it is due now.
          // Otherwise a little early is fine: the check runs every few minutes.
          const due =
            schedule.lastAt === undefined
              ? 0
              : schedule.lastAt + schedule.everyDays * 24 * 3600_000 - 10 * 60_000;
          if (now() < due) return false;
          const attempt = now();
          const attempts = Math.min((schedule.retry?.attempts ?? 0) + 1, 6);
          const retry = {
            attempts,
            nextAt: attempt + Math.min(3600_000 * 2 ** (attempts - 1), 24 * 3600_000),
            error:
              "The previous scheduled backup did not finish. It will be tried again after its retry delay.",
          };
          // Reserve before taking any snapshot. A killed worker/app must not
          // restart into an immediate expensive retry, or erase the failure.
          updateEntry(entry.folder, {
            autoBackup: { ...schedule, lastAttemptAt: attempt, retry },
          });
          let made: Awaited<ReturnType<typeof backupNow>>;
          try {
            await saveRegistry();
            made = await backupNow(entry, schedule.destination);
          } catch (error) {
            const latest = registry?.find((e) => e.folder === entry.folder) ?? entry;
            const failure: BackupFailure = {
              at: now(),
              kind: failureKind(error),
              message: (error instanceof Error ? error.message : "").slice(0, 1000),
            };
            updateEntry(entry.folder, {
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
            await saveRegistry().catch(() => {});
            throw error;
          }
          const latest = registry?.find((e) => e.folder === entry.folder) ?? entry;
          const {
            retry: _retry,
            warning: _warning,
            failure: _failure,
            ...completed
          } = latest.autoBackup ?? schedule;
          const finished = { ...completed, lastAt: made.at, lastPath: made.path };
          updateEntry(entry.folder, { autoBackup: finished });
          let savedCompletion = false;
          try {
            await saveRegistry();
            savedCompletion = true;
            // A failed capture cannot trigger retention or displace a verified copy.
            await pruneBackups(latest, schedule, made.path);
          } catch (error) {
            // A verified copy is a successful capture even if its metadata or
            // retention cleanup fails. Do not promise a capture retry that its
            // fresh lastAt would correctly prevent, or create another snapshot.
            const warning =
              `A verified backup of ${entry.name} was made, but ${savedCompletion ? "older backup cleanup did not finish" : "its completion could not be saved"}. Some older backups may remain. ${error instanceof Error ? error.message : ""}`
                .trim()
                .slice(0, 1000);
            updateEntry(entry.folder, {
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
            await saveRegistry().catch(() => {});
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

  /**
   * Changes the port a stopped workspace starts on. The running one is left
   * alone: moving it would disconnect everyone and break every link to it.
   */
  function setPort(value: unknown): Promise<{ folder: string; port: number }> {
    const { folder, port } = (value ?? {}) as Record<string, unknown>;
    if (typeof folder !== "string")
      return Promise.reject(new Error("Choose a workspace to change the port of."));
    let next: number;
    try {
      next = portOf(port);
    } catch (error) {
      return Promise.reject(error);
    }
    return serialized(async () => {
      if (closing) throw new Error("The app is quitting.");
      const entry = (await loadRegistry()).find((e) => e.folder === folder);
      if (!entry) throw new Error("That workspace is not in the list hosted on this computer.");
      if (server && workspace?.folder === entry.folder)
        throw new Error(`Stop hosting ${entry.name} before changing its port.`);
      updateEntry(entry.folder, { port: next, portChosen: true });
      try {
        await saveRegistry();
      } catch {
        updateEntry(entry.folder, { port: entry.port, portChosen: entry.portChosen });
        throw new Error(
          "Tandem could not save the new port. Check that its settings folder is writable, then try again.",
        );
      }
      changed();
      return { folder: entry.folder, port: next };
    });
  }

  /**
   * Chooses the workspace to start whenever Tandem opens, by its folder,
   * or none. Only a workspace in the list can be chosen, and only one at a time.
   */
  function setStartOnLaunch(value: unknown): Promise<string | null> {
    if (value !== null && typeof value !== "string")
      return Promise.reject(new Error("Choose a workspace to start when Tandem opens."));
    return serialized(async () => {
      const chosen =
        value === null ? undefined : (await loadRegistry()).find((e) => e.folder === value);
      if (value !== null && !chosen)
        throw new Error("That workspace is not in the list hosted on this computer.");
      if (chosen?.restoredHold !== undefined)
        throw new Error(`Put ${chosen.name} back in use before choosing it to start with Tandem.`);
      try {
        await options.settings.set(START_ON_LAUNCH_KEY, value);
      } catch {
        throw new Error(
          "Tandem could not save that choice. Check that its settings folder is writable, then try again.",
        );
      }
      launchFolder = value;
      // Starting nothing leaves nothing that failed to start.
      if (value === null) launchError = undefined;
      changed();
      return value;
    });
  }

  /**
   * Starts the workspace chosen to start with the app, if one was. A failure
   * is kept in the status to be shown, rather than lost while no window is
   * open to say it. A choice whose workspace has left the list is dropped.
   */
  async function startForLaunch(): Promise<HostingSnapshot | null> {
    let folder: string | null;
    try {
      folder = await readLaunchFolder();
    } catch {
      launchError = {
        part: "hosting",
        folder: null,
        message:
          "Tandem did not start hosting when it opened, because it could not read which workspace to start. Check that its settings file can be read, then choose the workspace again under When this computer starts.",
      };
      changed();
      return null;
    }
    if (!folder) return null;
    let entry: HostedWorkspace | undefined;
    try {
      entry = (await loadRegistry()).find((e) => e.folder === folder);
    } catch (error) {
      launchError = {
        part: "hosting",
        folder,
        message:
          error instanceof RegistryFormatError
            ? `Tandem did not start hosting when it opened. ${error.message}`
            : "Tandem did not start hosting when it opened, because it could not read its list of hosted workspaces.",
      };
      changed();
      return null;
    }
    if (!entry) {
      launchFolder = null;
      await options.settings.set(START_ON_LAUNCH_KEY, null).catch(() => {});
      return null;
    }
    if (entry.restoredHold !== undefined) {
      launchError = {
        part: "hosting",
        folder,
        message: `Tandem did not start hosting ${entry.name} when it opened, because it was restored from a backup and has not been put back in use.`,
      };
      changed();
      return null;
    }
    let started: HostingSnapshot;
    try {
      started = await start({ folder });
    } catch (error) {
      launchError = {
        part: "hosting",
        folder,
        message: `Tandem did not start hosting ${entry.name} when it opened. ${
          error instanceof Error ? error.message : ""
        }`.trim(),
      };
      changed();
      return null;
    }
    // Read before any request queued behind the start can take its turn.
    return reopenPublicAfterLaunch(entry.name, folder, runs, started);
  }

  async function readReopenPublic(): Promise<{ folder: string; address: string } | null> {
    if (reopenPublic !== undefined) return reopenPublic;
    const stored = (await options.settings.get(REOPEN_PUBLIC_KEY).catch(() => null)) as {
      folder?: unknown;
      address?: unknown;
    } | null;
    reopenPublic =
      stored && typeof stored.folder === "string" && typeof stored.address === "string"
        ? { folder: stored.folder, address: stored.address }
        : null;
    return reopenPublic;
  }

  /**
   * Publishes the stable address again after starting with Tandem, when
   * the host asked for that for this workspace and this address. Open to all
   * checks that the address reaches this running workspace before publishing,
   * and asks for an invite unless told otherwise, so nothing is weakened. A
   * failure is kept to be shown; hosting on the network carries on.
   *
   * Only the run that started with Tandem is published. One stopped
   * meanwhile, or replaced by another workspace or another start of this
   * one, is left alone.
   */
  async function reopenPublicAfterLaunch(
    name: string,
    folder: string,
    run: number,
    started: HostingSnapshot,
  ): Promise<HostingSnapshot> {
    const launched = () => server !== null && workspace?.folder === folder && runs === run;
    const wanted = await readReopenPublic();
    if (!launched()) return status();
    if (!wanted || wanted.folder !== folder || isolatedRun) return started;
    const current = publicAddress();
    if (current.url !== wanted.address) {
      launchError = {
        part: "public-address",
        folder,
        message: `${name} started, but ${wanted.address} was not reopened, because the stable address Tandem is set up with has changed${current.url ? ` to ${current.url}` : ""}. Open it to all again, then choose to reopen it.`,
      };
      changed();
      return started;
    }
    try {
      // Asked for now, before anything else can start; its turn checks the run again.
      return await openToAll({});
    } catch (error) {
      if (!launched()) return status();
      launchError = {
        part: "public-address",
        folder,
        message: `${name} started on this network, but ${wanted.address} was not reopened. ${
          error instanceof Error ? error.message : ""
        }`.trim(),
      };
      changed();
      return status();
    }
  }

  /**
   * Chooses whether the running workspace reopens its stable public address
   * when it starts with Tandem. Only a stable address can be chosen: a
   * temporary one is different every time, so reopening it would publish an
   * address nobody was given.
   */
  function setReopenPublicOnLaunch(value: unknown): Promise<boolean> {
    if (typeof value !== "boolean")
      return Promise.reject(new Error("Say whether to reopen the address with true or false."));
    return serialized(async () => {
      if (value) {
        if (!server || !workspace || phase !== "running")
          throw new Error("Start hosting the workspace before choosing to reopen its address.");
        if (isolatedRun)
          throw new Error(
            "A restored copy you are looking inside has no public address to reopen.",
          );
        const address = publicAddress();
        if (!address.url || address.error)
          throw new Error(
            "Only a stable address can be reopened when Tandem starts. Set one up first; a temporary address changes every time.",
          );
      }
      const next = value ? { folder: workspace!.folder, address: publicAddress().url! } : null;
      try {
        await options.settings.set(REOPEN_PUBLIC_KEY, next);
      } catch {
        throw new Error(
          "Tandem could not save that choice. Check that its settings folder is writable, then try again.",
        );
      }
      reopenPublic = next;
      // Not reopening it any more leaves nothing that failed to reopen.
      if (!value && launchError?.part === "public-address") launchError = undefined;
      changed();
      return value;
    });
  }

  /**
   * The host has read what did not happen when Tandem opened and does not
   * need it said again. Whatever is running carries on as it is.
   */
  function dismissLaunchError(): HostingSnapshot {
    launchError = undefined;
    changed();
    return status();
  }

  /** The running workspace is public now, which a failed reopen of it was waiting for. */
  function publicReopened(): void {
    if (launchError?.part === "public-address" && launchError.folder === workspace?.folder)
      launchError = undefined;
  }

  /**
   * The computer woke, or its network changed: announce the running workspace
   * again, and tell the window its addresses may be different.
   */
  function networkChanged(): void {
    if (server && phase === "running") {
      try {
        server.reannounce?.();
      } catch {
        // The workspace still answers at its addresses; only being listed is lost.
      }
    }
    changed();
  }

  /**
   * Renames a hosted workspace, running or not. The name lives in the
   * workspace's database and the list keeps a copy; the folder never moves.
   * A running workspace is renamed by its own server, which tells everyone
   * connected. A stopped one has the name written into its database now,
   * rather than handed to its next start: a start given a name is how
   * earlier versions came to overwrite the name a workspace had.
   */
  function rename(value: unknown): Promise<{ folder: string; name: string }> {
    const { folder, name } = (value ?? {}) as Record<string, unknown>;
    if (typeof folder !== "string")
      return Promise.reject(new Error("Choose a workspace to rename."));
    let next: string;
    try {
      next = workspaceNameOf(name);
    } catch (error) {
      return Promise.reject(error);
    }
    return serialized(async () => {
      if (closing) throw new Error("The app is quitting.");
      const entry = (await loadRegistry()).find((e) => e.folder === folder);
      if (!entry) throw new Error("That workspace is not in the list hosted on this computer.");
      if (server && workspace?.folder === entry.folder) {
        if (stopFailed) throw new Error("Finish stopping the workspace before renaming it.");
        if (!server.setWorkspaceName)
          throw new Error(
            "This workspace cannot be renamed while it runs. Stop it, then rename it.",
          );
        server.setWorkspaceName(next);
        next = server.workspaceName?.() ?? next;
        workspace.workspaceName = next;
      } else {
        const dataDir = join(options.dataRoot, entry.folder);
        if (!existsSync(dataDir))
          throw new Error(
            `The folder that held ${entry.name} is missing, so it cannot be renamed.`,
          );
        const inside = read(dataDir);
        if (!inside)
          throw new Error(
            `${entry.name}'s database is missing or unreadable, so it was not renamed.`,
          );
        // A folder copied or swapped by hand holds some other workspace.
        if (entry.id && inside.id !== entry.id)
          throw new Error(
            `The folder for ${entry.name} holds a different workspace, so it was not renamed.`,
          );
        try {
          writeName(dataDir, next);
        } catch {
          // SQLite's own message can name the file, and with it the account.
          throw new Error(
            `${entry.name}'s database could not be changed, so it was not renamed. Check that nothing else is using it, then try again.`,
          );
        }
      }
      updateEntry(entry.folder, { name: next });
      await saveName(entry.folder);
      changed();
      return { folder: entry.folder, name: next };
    });
  }

  /**
   * Saves the list after a workspace's entry took a new name. The database
   * holds the name; the list's copy is written with the next change if not
   * now, and a start reads the name back from the server.
   */
  async function saveName(folder: string): Promise<void> {
    await saveRegistry().catch(() => {});
    // Earlier versions reopen what they last hosted by its name, and would
    // hand the old one to its server.
    const latest = mostRecent(registry ?? []);
    if (latest?.folder === folder)
      await options.settings.set("lastHosted", legacyPointer(latest)).catch(() => {});
  }

  /**
   * Follows a change made to the running workspace from inside it, by an
   * owner or admin in Workspace settings: the list and this window take its
   * new name, and Manage hosting shows who may join now. A rule chosen there
   * is the workspace's, so nothing here puts back an older one over it.
   */
  function followWorkspace(folder: string, change: HostedWorkspaceChange): void {
    if (!workspace || workspace.folder !== folder) return;
    if (change.by !== null && change.accessPolicy !== undefined) {
      workspacePolicyChanges += 1;
      policyBeforeOpen = undefined;
    }
    // The host's own rename keeps the list itself, in its turn.
    if (change.by !== null && change.workspaceName !== undefined) {
      workspace.workspaceName = change.workspaceName;
      // A list not read yet is never written back as an empty one.
      if (registry) {
        updateEntry(folder, { name: change.workspaceName });
        void serialized(() => saveName(folder));
      }
    }
    changed();
  }

  /**
   * Shows a hosted workspace's folder in the system's file manager. The
   * window names the entry; the path comes from the list, never the window.
   */
  async function openFolder(value: unknown): Promise<void> {
    if (typeof value !== "string") throw new Error("Choose a workspace whose folder to open.");
    if (!options.openFolder) throw new Error("Opening a folder is not available in this app.");
    const entry = (await loadRegistry()).find((e) => e.folder === value);
    if (!entry) throw new Error("That workspace is not in the list hosted on this computer.");
    const dataDir = join(options.dataRoot, entry.folder);
    if (!existsSync(dataDir)) throw new Error(`The folder that held ${entry.name} is missing.`);
    // The system's reason can hold the path, and with it the account name.
    if (await options.openFolder(dataDir))
      throw new Error(`The folder for ${entry.name} could not be opened.`);
  }

  /** The workspace hosted most recently, for offering to start it again. */
  async function lastHosted(): Promise<{
    folder: string;
    workspaceName: string;
    port: number;
  } | null> {
    const latest = mostRecent(await loadRegistry().catch(() => []));
    return latest ? { folder: latest.folder, workspaceName: latest.name, port: latest.port } : null;
  }

  async function stopCurrent(): Promise<void> {
    if (!server) return;
    phase = "stopping";
    changed();
    // A link to a server that is gone would only show Cloudflare's error page.
    try {
      await endTunnel();
    } catch (error) {
      phase = "running";
      warning = "The public link could not finish closing. Try stopping the workspace again.";
      changed();
      throw error;
    }
    openError = undefined;
    try {
      await finishCleanup(server.stop(), "The workspace did not finish stopping in time.");
    } catch (error) {
      phase = "running";
      stopFailed = true;
      warning =
        "The workspace could not finish stopping. Use Quit Tandem to review recovery options.";
      changed();
      throw error;
    }
    stopWatchingConnections?.();
    stopWatchingConnections = null;
    stopFollowingWorkspace?.();
    stopFollowingWorkspace = null;
    server = null;
    workspace = null;
    phase = "stopped";
    warning = undefined;
    portWarning = undefined;
    metadataDirty = false;
    stopFailed = false;
    changed();
  }

  function stop(): Promise<void> {
    cancelPublicOpen();
    return serialized(stopCurrent);
  }

  /**
   * Opens the running workspace to all: a tunnel gives it an https address
   * anyone can reach, links are built on that address, and calls look for a
   * route across networks. Joining keeps its rule unless `inviteOnly` is given.
   */
  function openToAll(value: unknown = {}): Promise<HostingSnapshot> {
    if (closing) return Promise.reject(new Error("The app is quitting."));
    const { inviteOnly, accessPolicy } =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as { inviteOnly?: unknown; accessPolicy?: unknown })
        : {};
    if (inviteOnly !== undefined && typeof inviteOnly !== "boolean")
      return Promise.reject(
        new Error("Say whether joining needs an invite code with true or false."),
      );
    if (accessPolicy !== undefined && !isAccessPolicy(accessPolicy))
      return Promise.reject(new Error(`Say who may join with one of ${ACCESS_POLICIES}.`));
    const request = publicRequest;
    // Asked for one run, it never opens another that started while it waited.
    const run = runs;
    return serialized(async () => {
      if (closing || request !== publicRequest || run !== runs)
        throw new Error("Opening to all was cancelled.");
      const target = server;
      if (!target || phase !== "running")
        throw new Error("Start hosting the workspace before opening it to all.");
      if (isolatedRun)
        throw new Error(
          "A restored copy you are looking inside cannot be opened to all. Put it back in use first.",
        );
      if (stopFailed)
        throw new Error("Finish stopping the workspace before changing its public access.");
      if (cleanupTunnel)
        throw new Error(
          "Stop hosting to finish closing the previous public link before opening another.",
        );
      if (!options.openTunnel) throw new Error("Opening to all is not available in this app.");
      // A configured stable address that cannot be used has to be corrected.
      // Falling back would publish a temporary link nobody was given. An
      // already open link keeps working, so its policy can still be changed.
      const configured = publicAddress();
      const carriedElsewhere = !!configured.url && !configured.managed;
      if (!tunnel && configured.error) throw new Error(configured.error);
      if (
        !target.setPublicUrl ||
        !target.setIceServers ||
        !target.inviteOnly ||
        !target.setInviteOnly
      )
        throw new Error("This hosted workspace cannot change its public access settings.");
      // Through a tunnel nothing counts as this computer's own, so the owner
      // would need the claim code to create their account. Theirs comes first.
      if (target.accountCount && target.accountCount() === 0)
        throw new Error("Create your own account in the workspace first, then open it to all.");
      const previousPolicy = policyOf(target);
      const closedPolicy: AccessPolicy = carriedElsewhere ? "invite_only" : previousPolicy;
      if (!tunnel) policyBeforeOpen = previousPolicy;
      const policyChanges = workspacePolicyChanges;
      /**
       * Back to the rule from before, when the link did not open. One an owner
       * or admin chose meanwhile stays, unless something else may be carrying
       * the address, when joining closes whatever was chosen.
       */
      const putBackPolicy = () => {
        if (carriedElsewhere || policyChanges === workspacePolicyChanges)
          applyPolicy(target, closedPolicy);
      };
      openError = undefined;
      if (accessPolicy !== undefined) applyPolicy(target, accessPolicy);
      else target.setInviteOnly(inviteOnly ?? true);
      if (tunnel) {
        publicReopened();
        changed();
        return status();
      }
      const attempt = new AbortController();
      opening = attempt;
      openError = undefined;
      changed();
      let opened: Tunnel;
      try {
        opened = await options.openTunnel(target.port, attempt.signal, target.instanceId);
      } catch (error) {
        if (error instanceof TunnelCleanupError) {
          cleanupTunnel = error.tunnel;
          target.setInviteOnly(true);
          closeReach(target);
          openError =
            "The public link could not finish closing. Stop hosting to retry cleanup before opening another.";
          if (opening === attempt) opening = null;
          changed();
          throw error;
        }
        try {
          putBackPolicy();
        } catch {
          // The original opening error remains the useful one to report.
        }
        // Called off by stopping, quitting or turning it off: nothing failed.
        if (!attempt.signal.aborted)
          openError = error instanceof Error ? error.message : String(error);
        if (opening === attempt) opening = null;
        changed();
        throw error;
      }
      cleanupTunnel = opened;
      if (opening === attempt) opening = null;
      if (attempt.signal.aborted || request !== publicRequest || closing) {
        target.setInviteOnly(true);
        try {
          await endTunnel();
        } catch (error) {
          openError =
            "The cancelled public link could not finish closing. Stop hosting to retry cleanup before opening another.";
          changed();
          throw error;
        }
        putBackPolicy();
        changed();
        throw new Error("Opening to all was cancelled.");
      }
      try {
        // Only a connector Tandem starts is known to replace Cloudflare's
        // client-address header. A generic local proxy may pass a forged one.
        if (!carriedElsewhere) target.setTrustLoopbackProxy?.(true);
        target.setPublicUrl(opened.url);
        target.setIceServers(OPEN_TO_ALL_ICE_SERVERS);
      } catch (error) {
        closeReach(target);
        target.setInviteOnly(true);
        try {
          await endTunnel();
        } catch (cleanupError) {
          openError =
            "The public link could not finish closing after setup failed. Stop hosting to retry cleanup before opening another.";
          changed();
          throw cleanupError;
        }
        putBackPolicy();
        openError = "The workspace could not take its public address. Try opening it to all again.";
        changed();
        throw error;
      }
      tunnel = opened;
      cleanupTunnel = null;
      externalCarrier = carriedElsewhere;
      publicReopened();
      opened.onUnexpectedExit((reason) => {
        if (tunnel !== opened) return;
        tunnel = null;
        const wasExternal = externalCarrier;
        externalCarrier = false;
        closeReach(target);
        if (wasExternal) target.setInviteOnly?.(true);
        openError = configured.url
          ? `The public link stopped working (${reason}). Fix its connection, then open to all again at the same address.`
          : `The public link stopped working (${reason}). Open to all again for a new link.`;
        changed();
      });
      changed();
      return status();
    });
  }

  /** Back to this network only. Links go back to its addresses. */
  function endOpenToAll(): Promise<HostingSnapshot> {
    cancelPublicOpen();
    return serialized(async () => {
      openError = undefined;
      try {
        await endTunnel();
      } catch (error) {
        openError = "The public link could not finish closing. Try closing it again.";
        changed();
        throw error;
      }
      changed();
      return status();
    });
  }

  /**
   * Changes who may join the running workspace. Turning guests off signs every
   * guest out; the status returned is what the server now holds.
   */
  function setAccessPolicy(value: unknown): Promise<HostingSnapshot> {
    if (!isAccessPolicy(value))
      return Promise.reject(new Error(`Say who may join with one of ${ACCESS_POLICIES}.`));
    return serialized(async () => {
      if (!server?.setAccessPolicy || phase !== "running")
        throw new Error("Start hosting the workspace before changing who can join.");
      if (stopFailed || cleanupTunnel)
        throw new Error("Finish stopping the workspace before changing who can join.");
      server.setAccessPolicy(value);
      changed();
      return status();
    });
  }

  function setInviteOnly(value: unknown): Promise<HostingSnapshot> {
    if (typeof value !== "boolean")
      return Promise.reject(
        new Error("Say whether joining needs an invite code with true or false."),
      );
    return serialized(async () => {
      if (!server?.setInviteOnly || phase !== "running")
        throw new Error("Start hosting the workspace before changing who can join.");
      if (stopFailed || cleanupTunnel)
        throw new Error("Finish stopping the workspace before changing who can join.");
      server.setInviteOnly(value);
      changed();
      return status();
    });
  }

  /**
   * Changes the saved external address in the same queue as opening it. An
   * external carrier may already be live, so registration is secured before
   * persistence and remains secured if saving fails.
   */
  function setPublicAddress(value: string | null): Promise<HostingSnapshot> {
    if (!options.savePublicAddress)
      return Promise.reject(new Error("Saving a public address is not available in this app."));
    return serialized(async () => {
      if (closing) throw new Error("The app is quitting.");
      if (tunnel || opening || cleanupTunnel)
        throw new Error("Stop using the current public address before changing it.");
      if (server && phase === "running") server.setInviteOnly?.(true);
      await options.savePublicAddress!(value);
      openError = undefined;
      changed();
      return status();
    });
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    // Set before joining the queue: later IPC starts cannot outrun a pending quit.
    closing = true;
    cancelPublicOpen();
    // Whatever is already running, a backup to a slow disk say, gets as long
    // to finish as a stop does. After that the stop gives up its place: left
    // waiting, it would stop the workspace whenever that work ended, after
    // whoever was asked had chosen to keep the app open. Nothing is abandoned;
    // the work goes on, and the server stays owned to stop on a later try.
    let turn: "waiting" | "taken" | "given up" = "waiting";
    const reached = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (turn !== "waiting") return;
        turn = "given up";
        reject(
          new Error("Tandem is still finishing other work, so the workspace was not stopped."),
        );
      }, options.cleanupTimeoutMs ?? 30_000);
      timer.unref?.();
      void serialized(async () => {
        if (turn === "given up") return;
        turn = "taken";
        clearTimeout(timer);
        await stopCurrent();
      }).then(resolve, reject);
    });
    shutdownPromise = reached.catch((error: unknown) => {
      // The caller can cancel quitting and retry with the same owned server.
      closing = false;
      shutdownPromise = null;
      throw error;
    });
    return shutdownPromise;
  }

  return {
    status,
    list,
    backupAttention,
    lastHosted,
    backup,
    restore,
    forget,
    rename,
    openFolder,
    setStartOnLaunch,
    setReopenPublicOnLaunch,
    dismissLaunchError,
    setPort,
    setAutoBackup,
    runDueBackups,
    startForLaunch,
    networkChanged,
    start,
    stop,
    shutdown,
    openToAll,
    endOpenToAll,
    setInviteOnly,
    setAccessPolicy,
    setPublicAddress,
  };
}

const isAccessPolicy = (value: unknown): value is AccessPolicy =>
  ACCESS_POLICIES.includes(value as AccessPolicy);

/** Who may join, as a value to put back later. An older server says it by invites alone. */
function policyOf(target: HostedServer): AccessPolicy {
  return target.accessPolicy?.() ?? (target.inviteOnly?.() ? "invite_only" : "account_required");
}

function applyPolicy(target: HostedServer, policy: AccessPolicy): void {
  if (target.setAccessPolicy) target.setAccessPolicy(policy);
  else target.setInviteOnly?.(policy === "invite_only");
}
