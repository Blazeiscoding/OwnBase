import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  ACCESS_POLICIES,
  isAccessPolicy,
  WORKSPACE_NAME_MAX,
  workspaceNameSchema,
  type AccessPolicy,
} from "@ownbase/protocol";
import {
  isPort,
  PORT_RULE,
  type HostedBackup,
  type HostedWorkspace as HostedWorkspaceView,
  type HostingStart,
  type HostingStatus,
  type LastHosted,
  type RestoredOver,
  type RestoredWorkspace,
  type RestoreInventory,
  type StartedWorkspace,
} from "@ownbase/protocol/desktop";
import type { WorkspaceChange, WorkspaceServer } from "@ownbase/server";
import type {
  readStoppedIcon,
  readStoppedIconVersion,
  readStoppedWorkspace,
  renameStoppedWorkspace,
} from "@ownbase/server/stoppedWorkspace";
import type { WorkspaceIcon } from "@ownbase/server/workspaceIcon";
import { DesktopError } from "../shared/desktopError.js";
import {
  stableAddress,
  TunnelCleanupError,
  type PublicAddressConfig,
  type StableAddress,
  type Tunnel,
} from "./tunnel.js";
import {
  REGISTRY_KEY,
  RegistryFormatError,
  adoptFolders,
  legacyFolder,
  newFolder,
  parseAutoBackup,
  parseRegistry,
  serializeRegistry,
  type AutoBackup,
  type BackupFailure,
  type BackupFailureKind,
  type HostedWorkspace,
} from "./registry.js";

/** The hosting status as the controller knows it; the app adds what it alone can tell. */
export type HostingSnapshot = Omit<HostingStatus, "backgroundAvailable" | "cloudflaredInstall">;

/** Why hosting refuses to start anything while OwnBase quits. */
export const QUITTING =
  "OwnBase is quitting, so it starts nothing new. Try again after reopening it.";

/** The settings key naming, by its folder, the workspace to start when the app opens. */
export const START_ON_LAUNCH_KEY = "startOnLaunch";

/**
 * The settings key for reopening a stable public address when the workspace
 * starts with OwnBase: which workspace, and which address, so a changed
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
export type LegacyLastHosted = Omit<LastHosted, "folder">;

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

/** The running workspace server, as much of it as hosting uses. */
export type HostedServer = Pick<
  WorkspaceServer,
  | "port"
  | "instanceId"
  | "workspaceId"
  | "workspaceName"
  | "setWorkspaceName"
  | "workspaceIcon"
  | "reannounce"
  | "connectedPeople"
  | "onConnectedChange"
  | "stop"
  | "setPublicUrl"
  | "setTrustLoopbackProxy"
  | "setIceServers"
  | "accessPolicy"
  | "setAccessPolicy"
  | "onWorkspaceChange"
  | "accountCount"
>;

/** The server's readers and writer of a stopped workspace's database. */
export interface StoppedWorkspaces {
  read: typeof readStoppedWorkspace;
  icon: typeof readStoppedIcon;
  iconVersion: typeof readStoppedIconVersion;
  rename: typeof renameStoppedWorkspace;
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
  /** A workspace's own database, read or renamed from its folder without starting it. */
  stopped: StoppedWorkspaces;
  /**
   * Shows a folder in the system's file manager, as Electron's
   * `shell.openPath` does: resolves to why it could not, or to "" when it did.
   */
  openFolder(path: string): Promise<string>;
  /** The server's verified backup: a consistent copy of the database and every attachment. */
  backupWorkspace(options: { dataDir: string; out: string }): Promise<{ files: unknown[] }>;
  /** Bytes free on the disk holding `dir`. */
  freeBytes(dir: string): Promise<number>;
  /** The server's check of a backup's checksums and database, returning its manifest. */
  verifyBackup(dir: string): Promise<{
    workspaceName: string;
    database: { bytes: number };
    files: { bytes: number }[];
  }>;
  /** What a checked backup would reach or set off once started, for the host to see. */
  inventoryBackup(dir: string): Promise<RestoreInventory>;
  /** The server's restore: verified, staged beside `dataDir`, then swapped in. */
  restoreWorkspace(options: { backupDir: string; dataDir: string }): Promise<unknown>;
  now?: () => number;
  dataRoot: string;
  defaultPort: number;
  lanUrls(port: number): string[];
  onChange(): void;
  /** Opens a tunnel to a port on this computer: to the stable address given, or a temporary one. */
  openTunnel(
    port: number,
    signal: AbortSignal,
    instanceId: string,
    address: StableAddress | null,
  ): Promise<Tunnel>;
  /** Whether a public link can be opened: cloudflared is here, or something else carries the address. */
  tunnelAvailable(): boolean;
  /**
   * The stable public address configured for this computer, read for each
   * use so correcting it takes effect without a restart: the address the
   * host saved, if they did, and what the configuration resolves to.
   */
  publicAddress(): { saved: string | null; config: PublicAddressConfig };
  /** Persists an address the host supplied, after the controller makes the change safe. */
  savePublicAddress(address: string | null): Promise<void>;
  /**
   * Whether `http://127.0.0.1:<port>` answers as this run. Windows lets a
   * wildcard bind succeed beside an existing loopback one, so holding the
   * port does not prove the port reaches us.
   */
  verifyLoopback(port: number, instanceId?: string): Promise<boolean>;
  /**
   * A stop that never answers stays owned and can be retried, rather than
   * blocking quit forever. A quit waits this long too for work ahead of it.
   */
  cleanupTimeoutMs?: number;
}

/**
 * Why a workspace did not start, fit to show. A system error's own message
 * names paths, and with them the account, so it is described by its code.
 */
function startFailure(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  // The usual causes, said plainly; the code stays at the end for whoever helps.
  if (code === "EACCES" || code === "EPERM")
    return new Error(
      `The workspace could not start because this computer did not let OwnBase use its data folder or port. Choose another port, or check that OwnBase may change files in that folder, then try again. Error code ${code}.`,
    );
  if (code === "ENOSPC")
    return new Error(
      "The workspace could not start because this computer's disk is full. Free some space, then try again.",
    );
  if (typeof code === "string" && /^E[A-Z]+$/.test(code))
    return new Error(
      `The workspace could not start. Check that OwnBase may change files in its data folder and that no other program uses its port, then try again. Error code ${code}.`,
    );
  return error instanceof Error ? error : new Error("The workspace could not start.");
}

/** A name as typed, trimmed, for a new workspace or a rename alike. */
function workspaceNameOf(value: unknown): string {
  const name = workspaceNameSchema.safeParse(value);
  if (!name.success)
    throw new Error(
      `Use a workspace name of 1 to ${WORKSPACE_NAME_MAX} characters, without line breaks or tabs.`,
    );
  return name.data;
}

/**
 * `{ folder }` starts a workspace already in the list. `{ workspaceName }`
 * always makes a new one: nothing is ever found by its name.
 */
function startOptions(value: unknown): HostingStart {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose a workspace name before starting hosting.");
  const { workspaceName, folder, port, activate } = value as Record<string, unknown>;
  if (activate !== undefined && typeof activate !== "boolean")
    throw new Error("Say whether to put the workspace back in use with true or false.");
  // 0 asks the system for any free port, which only tests ask for.
  if (port !== undefined && port !== 0 && !isPort(port)) throw new Error(PORT_RULE);
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
function legacyPointer(entry: HostedWorkspace | undefined): LegacyLastHosted | null {
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

function iconUrl(icon: WorkspaceIcon | null): string | null {
  return icon && `data:${icon.type};base64,${Buffer.from(icon.bytes).toString("base64")}`;
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
  const read = options.stopped.read;
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
  /** Said in the status while the list in memory has changes the settings file lacks. */
  let registryUnsaved: string | undefined;
  let stopFailed = false;
  let pending: Promise<unknown> = Promise.resolve();
  /** OwnBase is quitting: nothing new starts, and only reading and stopping are answered. */
  let closing = false;
  /** Stops asked for and not yet over, so the status says "stopping" from the moment one is asked. */
  let stopsAsked = 0;
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
  let stopWatchingConnections: (() => void) | null = null;
  /** Stops following the running workspace's name and who may join. */
  let stopFollowingWorkspace: (() => void) | null = null;

  function refuseWhileQuitting(): void {
    if (closing) throw new Error(QUITTING);
  }

  function changed(): void {
    // A renderer/tray notification must never lose ownership of a live server.
    try {
      options.onChange();
    } catch {
      // The next snapshot still reports the actual state.
    }
  }

  /** The stable address a public link would be opened at now, if one is configured and valid. */
  function stableUrl(): string | undefined {
    return stableAddress(options.publicAddress().config)?.publicUrl;
  }

  function status(): HostingSnapshot {
    const { saved, config } = options.publicAddress();
    const usable = stableAddress(config);
    // A saved address the app can change, against one the environment fixed.
    const setting = saved ?? (usable?.carrier === "elsewhere" ? usable.publicUrl : null);
    return {
      running: server !== null,
      phase: phase === "running" && stopsAsked > 0 ? "stopping" : phase,
      ...(workspace ?? {}),
      ...(server ? { port: server.port, lanUrls: options.lanUrls(server.port) } : {}),
      ...(server ? { instanceId: server.instanceId, accessPolicy: server.accessPolicy() } : {}),
      ...(opening
        ? { openToAll: { phase: "opening" as const } }
        : tunnel
          ? { openToAll: { phase: "open" as const, url: tunnel.url } }
          : {}),
      ...(openError ? { openToAllError: openError } : {}),
      tunnelAvailable: options.tunnelAvailable(),
      ...(usable ? { publicAddress: usable.publicUrl } : {}),
      ...(setting ? { publicAddressSetting: setting } : {}),
      ...(setting && !saved ? { publicAddressLocked: true } : {}),
      ...(usable?.carrier === "ownbase" ? { publicAddressManaged: true } : {}),
      ...(config && "error" in config ? { publicAddressError: config.error } : {}),
      ...(portWarning || warning || registryUnsaved
        ? { warning: [portWarning, warning, registryUnsaved].filter(Boolean).join(" ") }
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
      ...(server?.workspaceIcon ? { iconVersion: server.workspaceIcon()?.version ?? null } : {}),
      ...(server &&
      workspace &&
      reopenPublic &&
      reopenPublic.folder === workspace.folder &&
      reopenPublic.address === usable?.publicUrl
        ? { reopensPublicOnLaunch: true }
        : {}),
    };
  }

  /**
   * The workspace chosen to start with the app, or null when none was. A
   * choice that cannot be read is not "none": it throws, and nothing is kept,
   * so reading again after the settings file is repaired finds it.
   */
  async function readLaunchFolder(): Promise<string | null> {
    if (launchFolder !== undefined) return launchFolder;
    const stored = await options.settings.get(START_ON_LAUNCH_KEY, { strict: true });
    if (stored !== null && (typeof stored !== "string" || !stored))
      throw new Error("The workspace chosen to start with OwnBase is not one it can read.");
    launchFolder = stored;
    return launchFolder;
  }

  /** Back to reachable only on this network: no public address, no STUN. */
  function closeReach(target: HostedServer): void {
    for (const clear of [
      () => target.setTrustLoopbackProxy(false),
      () => target.setPublicUrl(null),
      () => target.setIceServers([]),
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
      tunnel === current && !externalCarrier && server ? server.accessPolicy() : undefined;
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
      if (externalCarrier || cleanupTunnel) server.setAccessPolicy("invite_only");
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
      server.setAccessPolicy(previousPolicy);
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
          "The workspace is running, but OwnBase could not save its hosting settings for next time.";
    }
    changed();
  }

  /** The running workspace, as a start that got it running answers. */
  function running(): StartedWorkspace {
    return {
      folder: workspace!.folder,
      workspaceName: workspace!.workspaceName,
      port: server!.port,
    };
  }

  /**
   * Starts a workspace, or answers for the one already running when it is
   * the same. Everything else about it is in `status`.
   */
  function start(value: unknown): Promise<StartedWorkspace> {
    if (closing) return Promise.reject(new Error(QUITTING));
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
        return running();
      }

      let list: HostedWorkspace[];
      try {
        list = await loadRegistry();
      } catch (error) {
        if (error instanceof RegistryFormatError) throw error;
        throw new Error(
          "OwnBase could not read its list of hosted workspaces, so it will not start one. Check that its settings file can be read, then try again.",
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
            "OwnBase could not add the workspace to its settings, so it did not create it. Check that its settings folder is writable, then try again.",
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
              `OwnBase could not find a free port for looking inside ${entry.name}. Try again.`,
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
          // Kept while the list still names it, so it is adopted rather than lost.
          if (await keepRegistry())
            await rm(join(options.dataRoot, entry.folder), { recursive: true, force: true }).catch(
              () => {},
            );
        }
        changed();
        throw startFailure(error);
      }
      updateEntry(entry.folder, {
        id: server.workspaceId(),
        name: server.workspaceName(),
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
      workspace.workspaceName = server.workspaceName();
      phase = "running";
      // Hosting has started, which is what a failed start needed. An address
      // that was not reopened is still not open, and stays said until it is.
      if (launchError?.part === "hosting") launchError = undefined;
      stopWatchingConnections = server.onConnectedChange(changed);
      const following = entry.folder;
      stopFollowingWorkspace = server.onWorkspaceChange((change) =>
        followWorkspace(following, change),
      );
      // A carrier forwards to one port and keeps forwarding there. Say so
      // while it can still be corrected, rather than letting Open to all
      // fail later with only "did not answer as this workspace".
      if (movedFrom !== undefined) {
        const configured = stableUrl();
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
      return running();
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

  async function list(): Promise<{ workspaces: HostedWorkspaceView[]; unreadable: string[] }> {
    const entries = await loadRegistry();
    // The list is still worth showing when only this choice cannot be read.
    const starting = await readLaunchFolder().catch(() => null);
    return {
      workspaces: [...entries]
        .sort((a, b) => b.lastHostedAt - a.lastHostedAt)
        .map((entry) => {
          const running = server !== null && workspace?.folder === entry.folder;
          const missing = !existsSync(join(options.dataRoot, entry.folder));
          return {
            folder: entry.folder,
            name: entry.name,
            port: entry.port,
            lastHostedAt: entry.lastHostedAt,
            lastBackupAt: entry.lastBackupAt ?? null,
            running,
            missing,
            startsOnLaunch: entry.folder === starting,
            autoBackup: entry.autoBackup ?? null,
            autoBackupError:
              entry.autoBackup?.warning ??
              backupFailureNote(entry.name, entry.autoBackup?.failure) ??
              entry.autoBackup?.retry?.error ??
              null,
            restored: entry.restoredHold !== undefined,
            // A stopped one's own database says, read without starting it.
            iconVersion: running
              ? (server?.workspaceIcon()?.version ?? null)
              : missing
                ? null
                : options.stopped.iconVersion(join(options.dataRoot, entry.folder)),
          };
        }),
      unreadable: unreadableFolders,
    };
  }

  /**
   * A hosted workspace's icon as a data URL, from the running server or read
   * from a stopped one's own database without starting it. Null when it has
   * none. The window names a listed workspace; the path comes from the list.
   */
  async function icon(value: unknown): Promise<string | null> {
    if (typeof value !== "string") throw new Error("Choose a workspace whose icon to show.");
    const entry = (await loadRegistry()).find((e) => e.folder === value);
    if (!entry) throw new Error("That workspace is not in the list hosted on this computer.");
    if (server && workspace?.folder === entry.folder) {
      return iconUrl(server.workspaceIcon());
    }
    const dataDir = join(options.dataRoot, entry.folder);
    return existsSync(dataDir) ? iconUrl(options.stopped.icon(dataDir)) : null;
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
    updateEntry(entry.folder, { lastBackupAt: done });
    await keepRegistry();
    changed();
    return { path: out, at: done };
  }

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
      const list = await loadRegistry();
      const manifest = await options.verifyBackup(backupDir);
      const id = read(backupDir)?.id ?? null;
      const listed = id ? list.find((e) => e.id === id) : undefined;
      if (listed && existsSync(join(options.dataRoot, listed.folder)))
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
      const dataDir = join(options.dataRoot, entry.folder);
      const unsaved = () =>
        new Error(
          "OwnBase could not save its settings, so it did not restore the backup. Check that its settings folder is writable, then try again.",
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
          await keepRegistry();
          throw unsaved();
        }
        launchFolder = null;
      }
      try {
        await options.restoreWorkspace({ backupDir, dataDir });
      } catch (error) {
        // Nothing arrived, so everything goes back to how it was. Anything
        // that did arrive stays listed and held.
        if (!existsSync(dataDir)) {
          registry = list;
          await keepRegistry();
          if (wasLaunch)
            await options.settings.set(START_ON_LAUNCH_KEY, entry.folder).then(
              () => (launchFolder = entry.folder),
              () => {},
            );
        }
        throw error;
      }
      const name = manifest.workspaceName.trim().slice(0, WORKSPACE_NAME_MAX) || entry.name;
      updateEntry(entry.folder, { name });
      await keepRegistry();
      const inventory = await options.inventoryBackup(backupDir).catch(() => null);
      changed();
      return { folder: entry.folder, name, inventory };
    });
  }

  /**
   * This workspace's own backups in `destination`, newest first by the time
   * in their names: folders named as `backup` names them, holding a manifest
   * and this very workspace's id. Nothing is checked or touched here.
   */
  async function ownBackups(
    entry: HostedWorkspace,
    destination: string,
  ): Promise<{ name: string; path: string; stamp: string }[]> {
    if (!entry.id) return [];
    const found: { name: string; path: string; stamp: string }[] = [];
    for (const item of await readdir(destination, { withFileTypes: true })) {
      if (!item.isDirectory() || !BACKUP_NAME.test(item.name)) continue;
      const path = join(destination, item.name);
      if (!existsSync(join(path, "manifest.json"))) continue;
      if (read(path)?.id !== entry.id) continue;
      found.push({ name: item.name, path, stamp: item.name.slice(-19) });
    }
    return found.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  }

  /**
   * The backups of a workspace kept in its backup folder, the one its
   * schedule uses, newest first. Each is checked as a restore would check it,
   * so a damaged one is listed as such and cannot be chosen. Without a
   * schedule, or with its folder out of reach, there are none to list.
   */
  async function listBackups(value: unknown): Promise<HostedBackup[]> {
    if (typeof value !== "string") throw new Error("Choose a workspace whose backups to list.");
    const entry = (await loadRegistry()).find((e) => e.folder === value);
    if (!entry) throw new Error("That workspace is not in the list hosted on this computer.");
    const destination = entry.autoBackup?.destination;
    if (!destination || !existsSync(destination)) return [];
    const listed: HostedBackup[] = [];
    for (const found of await ownBackups(entry, destination).catch(() => [])) {
      // The name holds when it was made, in UTC, as `backup` wrote it.
      const at = Date.parse(
        `${found.stamp.slice(0, 10)}T${found.stamp.slice(11).replaceAll("-", ":")}Z`,
      );
      try {
        const manifest = await options.verifyBackup(found.path);
        const bytes = manifest.database.bytes + manifest.files.reduce((n, f) => n + f.bytes, 0);
        listed.push({ name: found.name, at, bytes, damaged: false });
      } catch {
        listed.push({ name: found.name, at, bytes: null, damaged: true });
      }
    }
    return listed;
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
      const list = await loadRegistry();
      const listed = list.find((e) => e.folder === folder);
      if (!listed) throw new Error("That workspace is not in the list hosted on this computer.");
      if (server && workspace?.folder === listed.folder)
        throw new Error(`Stop hosting ${listed.name} before restoring an earlier copy over it.`);
      const dataDir = join(options.dataRoot, listed.folder);
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
      const unsaved = () =>
        new Error(
          "OwnBase could not save its settings, so it did not restore the backup. Check that its settings folder is writable, then try again.",
        );
      // Held before anything is restored, as `restore` holds a copy, so the
      // copy never starts by itself as though nothing had happened.
      const held: HostedWorkspace = { ...listed, restoredHold: now() };
      registry = list.map((e) => (e === listed ? held : e));
      try {
        await saveRegistry();
      } catch {
        registry = list;
        throw unsaved();
      }
      const wasLaunch = (await readLaunchFolder().catch(() => null)) === listed.folder;
      if (wasLaunch) {
        try {
          await options.settings.set(START_ON_LAUNCH_KEY, null);
        } catch {
          registry = list;
          await keepRegistry();
          throw unsaved();
        }
        launchFolder = null;
      }
      let restored: unknown;
      try {
        restored = await options.restoreWorkspace({ backupDir: source, dataDir });
      } catch (error) {
        // The server's restore puts what was there back before it fails, so
        // the workspace is as it was; so is its place in the list.
        registry = list;
        await keepRegistry();
        if (wasLaunch)
          await options.settings.set(START_ON_LAUNCH_KEY, listed.folder).then(
            () => (launchFolder = listed.folder),
            () => {},
          );
        throw error;
      }
      const aside = (restored as { supersededDir?: unknown } | null)?.supersededDir;
      const name = manifest.workspaceName.trim().slice(0, WORKSPACE_NAME_MAX) || listed.name;
      updateEntry(listed.folder, { name });
      await keepRegistry();
      const inventory = await options.inventoryBackup(source).catch(() => null);
      changed();
      return {
        folder: listed.folder,
        name,
        setAside: typeof aside === "string" ? aside : null,
        inventory,
      };
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
      refuseWhileQuitting();
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
          "OwnBase could not save the backup schedule. Check that its settings folder is writable, then try again.",
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
    // Newest first by the time in its name. A clock set wrong can make that
    // order lie, which is why only checked copies count and the fresh one stays.
    const found = (await ownBackups(entry, schedule.destination)).filter((b) => b.path !== fresh);
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
            error: "The last scheduled backup did not finish. OwnBase will try it again later.",
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
            await keepRegistry();
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
            await keepRegistry();
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
    if (!isPort(port)) return Promise.reject(new Error(PORT_RULE));
    const next = port;
    return serialized(async () => {
      refuseWhileQuitting();
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
          "OwnBase could not save the new port. Check that its settings folder is writable, then try again.",
        );
      }
      changed();
      return { folder: entry.folder, port: next };
    });
  }

  /**
   * Chooses the workspace to start whenever OwnBase opens, by its folder,
   * or none. Only a workspace in the list can be chosen, and only one at a time.
   */
  function setStartOnLaunch(value: unknown): Promise<string | null> {
    if (value !== null && typeof value !== "string")
      return Promise.reject(new Error("Choose a workspace to start when OwnBase opens."));
    return serialized(async () => {
      const chosen =
        value === null ? undefined : (await loadRegistry()).find((e) => e.folder === value);
      if (value !== null && !chosen)
        throw new Error("That workspace is not in the list hosted on this computer.");
      if (chosen?.restoredHold !== undefined)
        throw new Error(`Put ${chosen.name} back in use before choosing it to start with OwnBase.`);
      try {
        await options.settings.set(START_ON_LAUNCH_KEY, value);
      } catch {
        throw new Error(
          "OwnBase could not save that choice. Check that its settings folder is writable, then try again.",
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
  async function startForLaunch(): Promise<void> {
    let folder: string | null;
    try {
      folder = await readLaunchFolder();
    } catch {
      launchError = {
        part: "hosting",
        folder: null,
        message:
          "OwnBase did not start hosting when it opened, because it could not read which workspace to start. Check that its settings file can be read, then choose the workspace again under When this computer starts.",
      };
      changed();
      return;
    }
    if (!folder) return;
    let entry: HostedWorkspace | undefined;
    try {
      entry = (await loadRegistry()).find((e) => e.folder === folder);
    } catch (error) {
      launchError = {
        part: "hosting",
        folder,
        message:
          error instanceof RegistryFormatError
            ? `OwnBase did not start hosting when it opened. ${error.message}`
            : "OwnBase did not start hosting when it opened, because it could not read its list of hosted workspaces.",
      };
      changed();
      return;
    }
    if (!entry) {
      launchFolder = null;
      await options.settings.set(START_ON_LAUNCH_KEY, null).catch(() => {});
      return;
    }
    if (entry.restoredHold !== undefined) {
      launchError = {
        part: "hosting",
        folder,
        message: `OwnBase did not start hosting ${entry.name} when it opened, because it was restored from a backup and has not been put back in use.`,
      };
      changed();
      return;
    }
    try {
      await start({ folder });
    } catch (error) {
      launchError = {
        part: "hosting",
        folder,
        message: `OwnBase did not start hosting ${entry.name} when it opened. ${
          error instanceof Error ? error.message : ""
        }`.trim(),
      };
      changed();
      return;
    }
    // Read before any request queued behind the start can take its turn.
    await reopenPublicAfterLaunch(entry.name, folder, runs);
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
   * Publishes the stable address again after starting with OwnBase, when
   * the host asked for that for this workspace and this address. Open to all
   * checks that the address reaches this running workspace before publishing,
   * and asks for an invite unless told otherwise, so nothing is weakened. A
   * failure is kept to be shown; hosting on the network carries on.
   *
   * Only the run that started with OwnBase is published. One stopped
   * meanwhile, or replaced by another workspace or another start of this
   * one, is left alone.
   */
  async function reopenPublicAfterLaunch(name: string, folder: string, run: number): Promise<void> {
    const launched = () => server !== null && workspace?.folder === folder && runs === run;
    const wanted = await readReopenPublic();
    if (!launched() || !wanted || wanted.folder !== folder || isolatedRun) return;
    const current = stableUrl();
    if (current !== wanted.address) {
      launchError = {
        part: "public-address",
        folder,
        message: `${name} started, but the public link at ${wanted.address} was not reopened. The address OwnBase uses has changed${current ? ` to ${current}` : ""}. Press Get a public link, then turn on reopening it again.`,
      };
      changed();
      return;
    }
    try {
      // Asked for now, before anything else can start; its turn checks the run again.
      await openToAll({});
    } catch (error) {
      if (!launched()) return;
      launchError = {
        part: "public-address",
        folder,
        message: `${name} started on this network, but ${wanted.address} was not reopened. ${
          error instanceof Error ? error.message : ""
        }`.trim(),
      };
      changed();
    }
  }

  /**
   * Chooses whether the running workspace reopens its stable public address
   * when it starts with OwnBase. Only a stable address can be chosen: a
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
        if (!stableUrl())
          throw new Error(
            "OwnBase can reopen the public link only if it keeps the same address. Without your own address, the link changes every time. Enter your own address first.",
          );
      }
      const next = value ? { folder: workspace!.folder, address: stableUrl()! } : null;
      try {
        await options.settings.set(REOPEN_PUBLIC_KEY, next);
      } catch {
        throw new Error(
          "OwnBase could not save that choice. Check that its settings folder is writable, then try again.",
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
   * The host has read what did not happen when OwnBase opened and does not
   * need it said again. Whatever is running carries on as it is.
   */
  function dismissLaunchError(): void {
    launchError = undefined;
    changed();
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
        server.reannounce();
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
      refuseWhileQuitting();
      const entry = (await loadRegistry()).find((e) => e.folder === folder);
      if (!entry) throw new Error("That workspace is not in the list hosted on this computer.");
      if (server && workspace?.folder === entry.folder) {
        if (stopFailed) throw new Error("Finish stopping the workspace before renaming it.");
        server.setWorkspaceName(next);
        next = server.workspaceName();
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
          options.stopped.rename(dataDir, next);
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
    await keepRegistry();
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
  function followWorkspace(folder: string, change: WorkspaceChange): void {
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
    const entry = (await loadRegistry()).find((e) => e.folder === value);
    if (!entry) throw new Error("That workspace is not in the list hosted on this computer.");
    const dataDir = join(options.dataRoot, entry.folder);
    if (!existsSync(dataDir)) throw new Error(`The folder that held ${entry.name} is missing.`);
    // The system's reason can hold the path, and with it the account name.
    if (await options.openFolder(dataDir))
      throw new Error(`The folder for ${entry.name} could not be opened.`);
  }

  /** The workspace hosted most recently, for offering to start it again. */
  async function lastHosted(): Promise<LastHosted | null> {
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
        "The workspace could not finish stopping. Quit OwnBase to see what you can do next.";
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

  const STILL_BUSY =
    "OwnBase is still finishing other work, such as a backup, so the workspace was not stopped. Stop it again once that work ends.";

  /**
   * Stops the workspace when the queue reaches it. Whatever is already
   * running, a backup to a slow disk say, gets as long to finish as a stop
   * does. After that the stop gives up its place: left waiting, it would stop
   * the workspace whenever that work ended, long after whoever asked had moved
   * on or, quitting, had chosen to keep the app open. Nothing is abandoned;
   * the work goes on, the server stays owned to stop on a later try, and the
   * status says why until that work ends.
   */
  function stopInTurn(): Promise<void> {
    let turn: "waiting" | "taken" | "given up" = "waiting";
    let before: string | undefined;
    stopsAsked += 1;
    changed();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (turn !== "waiting") return;
        turn = "given up";
        before = warning;
        warning = STILL_BUSY;
        changed();
        reject(new Error(STILL_BUSY));
      }, options.cleanupTimeoutMs ?? 30_000);
      timer.unref?.();
      void serialized(async () => {
        if (turn === "given up") {
          // The work it waited behind has ended, and with it the reason.
          if (warning === STILL_BUSY) {
            warning = before;
            changed();
          }
          return;
        }
        turn = "taken";
        clearTimeout(timer);
        await stopCurrent();
      }).then(resolve, reject);
    }).finally(() => {
      stopsAsked -= 1;
      changed();
    });
  }

  function stop(): Promise<void> {
    cancelPublicOpen();
    return stopInTurn();
  }

  /**
   * Opens the running workspace to all: a tunnel gives it an https address
   * anyone can reach, links are built on that address, and calls look for a
   * route across networks. Who may join becomes `accessPolicy`, invited
   * accounts only unless it says otherwise.
   */
  function openToAll(value: unknown = {}): Promise<void> {
    if (closing) return Promise.reject(new Error(QUITTING));
    const { accessPolicy } =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as { accessPolicy?: unknown })
        : {};
    if (accessPolicy !== undefined && !isAccessPolicy(accessPolicy))
      return Promise.reject(new Error(`Say who may join with one of ${ACCESS_POLICIES}.`));
    const request = publicRequest;
    // Asked for one run, it never opens another that started while it waited.
    const run = runs;
    return serialized(async () => {
      if (closing || request !== publicRequest || run !== runs)
        throw new Error("Getting a public link was cancelled.");
      const target = server;
      if (!target || phase !== "running")
        throw new Error("Start hosting the workspace before getting a public link.");
      if (isolatedRun)
        throw new Error(
          "A restored copy you are looking inside cannot have a public link. Put it back in use first.",
        );
      if (stopFailed)
        throw new Error("Finish stopping the workspace before changing its public link.");
      if (cleanupTunnel)
        throw new Error(
          "Stop hosting to finish closing the previous public link, then get a new one.",
        );
      // A configured stable address that cannot be used has to be corrected.
      // Falling back would publish a temporary link nobody was given. An
      // already open link keeps working, so its policy can still be changed.
      const { config } = options.publicAddress();
      if (!tunnel && config && "error" in config) throw new Error(config.error);
      const configured = stableAddress(config);
      const carriedElsewhere = configured?.carrier === "elsewhere";
      const setPolicy = target.setAccessPolicy;
      // Through a tunnel nothing counts as this computer's own, so the owner
      // would need the claim code to create their account. Theirs comes first.
      if (target.accountCount() === 0)
        throw new DesktopError(
          "owner-account-missing",
          "Create your own account in the workspace first, then get a public link.",
        );
      const previousPolicy = target.accessPolicy();
      const closedPolicy: AccessPolicy = carriedElsewhere ? "invite_only" : previousPolicy;
      if (!tunnel) policyBeforeOpen = previousPolicy;
      const policyChanges = workspacePolicyChanges;
      /**
       * Back to the rule from before, when the link did not open. One an owner
       * or admin chose meanwhile stays, unless something else may be carrying
       * the address, when joining closes whatever was chosen.
       */
      const putBackPolicy = () => {
        if (carriedElsewhere || policyChanges === workspacePolicyChanges) setPolicy(closedPolicy);
      };
      openError = undefined;
      setPolicy(accessPolicy ?? "invite_only");
      if (tunnel) {
        publicReopened();
        changed();
        return;
      }
      const attempt = new AbortController();
      opening = attempt;
      openError = undefined;
      changed();
      let opened: Tunnel;
      try {
        opened = await options.openTunnel(
          target.port,
          attempt.signal,
          target.instanceId,
          configured,
        );
      } catch (error) {
        if (error instanceof TunnelCleanupError) {
          cleanupTunnel = error.tunnel;
          setPolicy("invite_only");
          closeReach(target);
          openError =
            "The public link could not finish closing. Stop hosting to try closing it again, then get a new one.";
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
        setPolicy("invite_only");
        try {
          await endTunnel();
        } catch (error) {
          openError =
            "The cancelled public link could not finish closing. Stop hosting to try closing it again, then get a new one.";
          changed();
          throw error;
        }
        putBackPolicy();
        changed();
        throw new Error("Getting a public link was cancelled.");
      }
      try {
        // Only a connector OwnBase starts is known to replace Cloudflare's
        // client-address header. A generic local proxy may pass a forged one.
        if (!carriedElsewhere) target.setTrustLoopbackProxy(true);
        target.setPublicUrl(opened.url);
        target.setIceServers(OPEN_TO_ALL_ICE_SERVERS);
      } catch (error) {
        closeReach(target);
        setPolicy("invite_only");
        try {
          await endTunnel();
        } catch (cleanupError) {
          openError =
            "Setting up the public link failed, and the link could not finish closing. Stop hosting to try closing it again, then get a new one.";
          changed();
          throw cleanupError;
        }
        putBackPolicy();
        openError =
          "The workspace could not use its public link. Press Get a public link to try again.";
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
        if (wasExternal) setPolicy("invite_only");
        openError = configured
          ? `The public link stopped working (${reason}). Fix its connection, then press Get a public link to open it at the same address.`
          : `The public link stopped working (${reason}). Press Get a public link for a new one.`;
        changed();
      });
      changed();
    });
  }

  /** Back to this network only. Links go back to its addresses. */
  function endOpenToAll(): Promise<void> {
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
    });
  }

  /**
   * Changes who may join the running workspace. Turning guests off signs every
   * guest out.
   */
  function setAccessPolicy(value: unknown): Promise<void> {
    if (!isAccessPolicy(value))
      return Promise.reject(new Error(`Say who may join with one of ${ACCESS_POLICIES}.`));
    return serialized(async () => {
      if (!server?.setAccessPolicy || phase !== "running")
        throw new Error("Start hosting the workspace before changing who can join.");
      if (stopFailed || cleanupTunnel)
        throw new Error("Finish stopping the workspace before changing who can join.");
      server.setAccessPolicy(value);
      changed();
    });
  }

  /**
   * Changes the saved external address in the same queue as opening it. An
   * external carrier may already be live, so registration is secured before
   * persistence and remains secured if saving fails.
   */
  function setPublicAddress(value: string | null): Promise<void> {
    return serialized(async () => {
      refuseWhileQuitting();
      if (tunnel || opening || cleanupTunnel)
        throw new Error("Stop using the current public address before changing it.");
      if (server && phase === "running") server.setAccessPolicy("invite_only");
      await options.savePublicAddress(value);
      openError = undefined;
      changed();
    });
  }

  /**
   * OwnBase begins or stops quitting. While it quits, work already accepted
   * finishes, and nothing new starts: not from the window, and not from a
   * schedule. Calling it off lets everything start again.
   */
  function setQuitting(on: boolean): void {
    closing = on;
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    // Set before joining the queue: later IPC starts cannot outrun a pending quit.
    closing = true;
    cancelPublicOpen();
    shutdownPromise = stopInTurn().catch((error: unknown) => {
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
    listBackups,
    restoreOver,
    forget,
    rename,
    openFolder,
    icon,
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
    setQuitting,
    quitting: () => closing,
    shutdown,
    openToAll,
    endOpenToAll,
    setAccessPolicy,
    setPublicAddress,
  };
}
