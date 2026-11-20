import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  ACCESS_POLICIES,
  isAccessPolicy,
  WORKSPACE_NAME_MAX,
  workspaceNameSchema,
} from "@ownbase/protocol";
import {
  isPort,
  PORT_RULE,
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
import {
  stableAddress,
  type PublicAddressConfig,
  type StableAddress,
  type Tunnel,
} from "./tunnel.js";
import { createHostedList, legacyPointer, mostRecent } from "./hostedList.js";
import { BACKUP_NAME, backupFailureNote, createHostedBackups, megabytes } from "./hostedBackups.js";
import { createHostingLaunch, START_ON_LAUNCH_KEY } from "./hostingLaunch.js";
import { createPublicLink } from "./publicLink.js";
import { RegistryFormatError, newFolder, type HostedWorkspace } from "./registry.js";

/** The hosting status as the controller knows it; the app adds what it alone can tell. */
export type HostingSnapshot = Omit<HostingStatus, "backgroundAvailable" | "cloudflaredInstall">;

/** Why hosting refuses to start anything while OwnBase quits. */
export const QUITTING =
  "OwnBase is quitting, so it starts nothing new. Try again after reopening it.";

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

export interface HostingOptions {
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

function iconUrl(icon: WorkspaceIcon | null): string | null {
  return icon && `data:${icon.type};base64,${Buffer.from(icon.bytes).toString("base64")}`;
}

/** Owns the embedded server, including operations accepted just before app shutdown. */
export function createHostingController(options: HostingOptions) {
  let server: HostedServer | null = null;
  let workspace: { workspaceName: string; folder: string; dataDir: string } | null = null;
  /** The running workspace is a restored copy started only to look inside. */
  let isolatedRun = false;
  let phase: HostingSnapshot["phase"] = "stopped";
  const now = options.now ?? Date.now;
  const read = options.stopped.read;
  const hosted = createHostedList({
    settings: options.settings,
    dataRoot: options.dataRoot,
    defaultPort: options.defaultPort,
    now,
    read,
    changed,
  });
  let warning: string | undefined;
  /**
   * Kept apart from `warning`, which saving settings clears on its next
   * success. Where this run is listening is true until it stops.
   */
  let portWarning: string | undefined;
  let metadataDirty = false;
  let stopFailed = false;
  let pending: Promise<unknown> = Promise.resolve();
  /** OwnBase is quitting: nothing new starts, and only reading and stopping are answered. */
  let closing = false;
  /** Stops asked for and not yet over, so the status says "stopping" from the moment one is asked. */
  let stopsAsked = 0;
  let shutdownPromise: Promise<void> | null = null;
  /** Counts starts, so a step that waited can tell the run it began with from a later one. */
  let runs = 0;
  let stopWatchingConnections: (() => void) | null = null;
  /** Stops following the running workspace's name and who may join. */
  let stopFollowingWorkspace: (() => void) | null = null;
  const link = createPublicLink({
    openTunnel: options.openTunnel,
    publicAddress: options.publicAddress,
    savePublicAddress: options.savePublicAddress,
    run: () => ({
      server,
      phase,
      isolated: isolatedRun,
      stopFailed,
      runs,
      quitting: closing,
    }),
    serialized,
    changed,
    refuseWhileQuitting,
    finishCleanup,
    publicReopened: () => launch.publicReopened(),
  });
  const backups = createHostedBackups({
    backupWorkspace: options.backupWorkspace,
    freeBytes: options.freeBytes,
    verifyBackup: options.verifyBackup,
    hosted,
    serialized,
    refuseWhileQuitting,
    quitting: () => closing,
    changed,
    now,
    read,
  });
  const launch = createHostingLaunch({
    settings: options.settings,
    hosted,
    serialized,
    changed,
    run: () => ({ server, workspace, phase, isolated: isolatedRun, runs }),
    start,
    openToAll,
    stableUrl: link.stableUrl,
  });

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

  function status(): HostingSnapshot {
    const { launchFolder, launchError, reopenPublic } = launch.state();
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
      ...link.status(),
      tunnelAvailable: options.tunnelAvailable(),
      ...(usable ? { publicAddress: usable.publicUrl } : {}),
      ...(setting ? { publicAddressSetting: setting } : {}),
      ...(setting && !saved ? { publicAddressLocked: true } : {}),
      ...(usable?.carrier === "ownbase" ? { publicAddressManaged: true } : {}),
      ...(config && "error" in config ? { publicAddressError: config.error } : {}),
      ...(portWarning || warning || hosted.unsaved()
        ? { warning: [portWarning, warning, hosted.unsaved()].filter(Boolean).join(" ") }
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

  async function saveMetadata(): Promise<void> {
    if (!server || !workspace) return;
    try {
      await hosted.save();
      // Earlier versions find a folder from its name. Name one to them only
      // when that leads to this workspace, never to a different one.
      await options.settings.set(
        "lastHosted",
        legacyPointer(hosted.current()?.find((e) => e.folder === workspace!.folder)),
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
        if (stopFailed || link.closeUnfinished())
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
        list = await hosted.load();
      } catch (error) {
        if (error instanceof RegistryFormatError) throw error;
        throw new Error(
          "OwnBase could not read its list of hosted workspaces, so it will not start one. Check that its settings file can be read, then try again.",
        );
      }
      let entry: HostedWorkspace;
      const created = !("folder" in requested);
      if ("folder" in requested) {
        const found = hosted.entryIn(list, requested.folder);
        const inside = hosted.folderHolds(found);
        // Never recreated empty: an empty folder would look like the workspace.
        if (inside.holds === "nothing")
          throw new Error(`The folder that held ${found.name} is missing, so it cannot start.`);
        if (inside.holds === "unreadable" && found.id)
          throw new Error(`${found.name}'s database is missing or unreadable, so it cannot start.`);
        if (inside.holds === "another")
          throw new Error(
            `The folder for ${found.name} holds a different workspace, so it will not start.`,
          );
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
        const dataDir = hosted.dataDirOf(entry);
        await mkdir(options.dataRoot, { recursive: true });
        await mkdir(dataDir);
        hosted.replace([...list, entry]);
        try {
          await hosted.save();
        } catch {
          hosted.replace(list);
          await rm(dataDir, { recursive: true, force: true }).catch(() => {});
          throw new Error(
            "OwnBase could not add the workspace to its settings, so it did not create it. Check that its settings folder is writable, then try again.",
          );
        }
      }
      workspace = {
        workspaceName: entry.name,
        folder: entry.folder,
        dataDir: hosted.dataDirOf(entry),
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
          hosted.replace(list);
          // Kept while the list still names it, so it is adopted rather than lost.
          if (await hosted.keep())
            await rm(hosted.dataDirOf(entry), { recursive: true, force: true }).catch(() => {});
        }
        changed();
        throw startFailure(error);
      }
      hosted.update(entry.folder, {
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
      void launch.readReopenPublic().then(
        (value) => {
          if (value && value.folder === workspace?.folder) changed();
        },
        () => {},
      );
      workspace.workspaceName = server.workspaceName();
      phase = "running";
      // Hosting has started, which is what a failed start needed. An address
      // that was not reopened is still not open, and stays said until it is.
      launch.hostingStarted();
      stopWatchingConnections = server.onConnectedChange(changed);
      const following = entry.folder;
      stopFollowingWorkspace = server.onWorkspaceChange((change) =>
        followWorkspace(following, change),
      );
      // A carrier forwards to one port and keeps forwarding there. Say so
      // while it can still be corrected, rather than letting Get a public link
      // fail later with only "did not answer as this workspace".
      if (movedFrom !== undefined) {
        const configured = link.stableUrl();
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

  async function list(): Promise<{ workspaces: HostedWorkspaceView[]; unreadable: string[] }> {
    const entries = await hosted.load();
    // The list is still worth showing when only this choice cannot be read.
    const starting = await launch.readLaunchFolder().catch(() => null);
    return {
      workspaces: [...entries]
        .sort((a, b) => b.lastHostedAt - a.lastHostedAt)
        .map((entry) => {
          const running = server !== null && workspace?.folder === entry.folder;
          const missing = !existsSync(hosted.dataDirOf(entry));
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
                : options.stopped.iconVersion(hosted.dataDirOf(entry)),
          };
        }),
      unreadable: hosted.unreadable(),
    };
  }

  /**
   * A hosted workspace's icon as a data URL, from the running server or read
   * from a stopped one's own database without starting it. Null when it has
   * none. The window names a listed workspace; the path comes from the list.
   */
  async function icon(value: unknown): Promise<string | null> {
    if (typeof value !== "string") throw new Error("Choose a workspace whose icon to show.");
    const entry = await hosted.listed(value);
    if (server && workspace?.folder === entry.folder) {
      return iconUrl(server.workspaceIcon());
    }
    const dataDir = hosted.dataDirOf(entry);
    return existsSync(dataDir) ? iconUrl(options.stopped.icon(dataDir)) : null;
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
      if (server && workspace?.folder === listed.folder)
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
            ? await backups.ownBackups(listed, destination).catch(() => [])
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

  /**
   * Takes a workspace whose folder is gone out of the list. One whose folder
   * is still there would only be adopted again on the next launch, so it stays.
   */
  function forget(value: unknown): Promise<void> {
    if (typeof value !== "string")
      return Promise.reject(new Error("Choose a workspace to remove."));
    return serialized(async () => {
      const list = await hosted.load();
      const entry = list.find((e) => e.folder === value);
      if (!entry) return;
      if (existsSync(hosted.dataDirOf(entry)))
        throw new Error(`${entry.name} is still on this computer, so it stays in the list.`);
      hosted.replace(list.filter((e) => e.folder !== entry.folder));
      try {
        await hosted.save();
      } catch (error) {
        hosted.replace(list);
        throw error;
      }
      if ((await launch.readLaunchFolder().catch(() => null)) === entry.folder) {
        launch.rememberLaunchFolder(null);
        await options.settings.set(START_ON_LAUNCH_KEY, null).catch(() => {});
      }
      changed();
    });
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
      const entry = await hosted.listed(folder);
      if (server && workspace?.folder === entry.folder)
        throw new Error(`Stop hosting ${entry.name} before changing its port.`);
      hosted.update(entry.folder, { port: next, portChosen: true });
      try {
        await hosted.save();
      } catch {
        hosted.update(entry.folder, { port: entry.port, portChosen: entry.portChosen });
        throw new Error(
          "OwnBase could not save the new port. Check that its settings folder is writable, then try again.",
        );
      }
      changed();
      return { folder: entry.folder, port: next };
    });
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
      const entry = await hosted.listed(folder);
      if (server && workspace?.folder === entry.folder) {
        if (stopFailed) throw new Error("Finish stopping the workspace before renaming it.");
        server.setWorkspaceName(next);
        next = server.workspaceName();
        workspace.workspaceName = next;
      } else {
        const inside = hosted.folderHolds(entry);
        if (inside.holds === "nothing")
          throw new Error(
            `The folder that held ${entry.name} is missing, so it cannot be renamed.`,
          );
        if (inside.holds === "unreadable")
          throw new Error(
            `${entry.name}'s database is missing or unreadable, so it was not renamed.`,
          );
        if (inside.holds === "another")
          throw new Error(
            `The folder for ${entry.name} holds a different workspace, so it was not renamed.`,
          );
        try {
          options.stopped.rename(hosted.dataDirOf(entry), next);
        } catch {
          // SQLite's own message can name the file, and with it the account.
          throw new Error(
            `${entry.name}'s database could not be changed, so it was not renamed. Check that nothing else is using it, then try again.`,
          );
        }
      }
      hosted.update(entry.folder, { name: next });
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
    await hosted.keep();
    // Earlier versions reopen what they last hosted by its name, and would
    // hand the old one to its server.
    const latest = mostRecent(hosted.current() ?? []);
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
    if (change.by !== null && change.accessPolicy !== undefined) link.workspaceChoseRule();
    // The host's own rename keeps the list itself, in its turn.
    if (change.by !== null && change.workspaceName !== undefined) {
      workspace.workspaceName = change.workspaceName;
      // A list not read yet is never written back as an empty one.
      if (hosted.current()) {
        hosted.update(folder, { name: change.workspaceName });
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
    const entry = await hosted.listed(value);
    const dataDir = hosted.dataDirOf(entry);
    if (!existsSync(dataDir)) throw new Error(`The folder that held ${entry.name} is missing.`);
    // The system's reason can hold the path, and with it the account name.
    if (await options.openFolder(dataDir))
      throw new Error(`The folder for ${entry.name} could not be opened.`);
  }

  /** The workspace hosted most recently, for offering to start it again. */
  async function lastHosted(): Promise<LastHosted | null> {
    const latest = mostRecent(await hosted.load().catch(() => []));
    return latest ? { folder: latest.folder, workspaceName: latest.name, port: latest.port } : null;
  }

  async function stopCurrent(): Promise<void> {
    if (!server) return;
    phase = "stopping";
    changed();
    // A link to a server that is gone would only show Cloudflare's error page.
    try {
      await link.endTunnel();
    } catch (error) {
      phase = "running";
      warning = "The public link could not finish closing. Try stopping the workspace again.";
      changed();
      throw error;
    }
    link.clearError();
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
    link.cancel();
    return stopInTurn();
  }

  /** Gets the running workspace a public link; see `PublicLink.open`. */
  function openToAll(value: unknown = {}): Promise<void> {
    if (closing) return Promise.reject(new Error(QUITTING));
    return link.open(value);
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
      if (stopFailed || link.closeUnfinished())
        throw new Error("Finish stopping the workspace before changing who can join.");
      server.setAccessPolicy(value);
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
    link.cancel();
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
    backupAttention: backups.backupAttention,
    lastHosted,
    backup: backups.backup,
    restore,
    listBackups: backups.listBackups,
    restoreOver,
    forget,
    rename,
    openFolder,
    icon,
    setStartOnLaunch: launch.setStartOnLaunch,
    setReopenPublicOnLaunch: launch.setReopenPublicOnLaunch,
    dismissLaunchError: launch.dismissLaunchError,
    setPort,
    setAutoBackup: backups.setAutoBackup,
    runDueBackups: backups.runDueBackups,
    startForLaunch: launch.startForLaunch,
    networkChanged,
    start,
    stop,
    setQuitting,
    quitting: () => closing,
    shutdown,
    openToAll,
    endOpenToAll: link.end,
    setAccessPolicy,
    setPublicAddress: link.setPublicAddress,
  };
}
