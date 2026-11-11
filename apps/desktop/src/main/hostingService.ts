import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT } from "@ownbase/protocol";
import type { HostingStatus } from "@ownbase/protocol/desktop";
import {
  cloudflareIceServers,
  createWorkspaceServer,
  isTurn,
  RelayError,
  type CallRelay,
  type WorkspaceServer,
} from "@ownbase/server";
import {
  readStoppedIcon,
  readStoppedIconVersion,
  readStoppedWorkspace,
  renameStoppedWorkspace,
} from "@ownbase/server/stoppedWorkspace";
import type { Channel } from "../shared/bridge.js";
import { DesktopError } from "../shared/desktopError.js";
import type { BackupJob } from "./backupWorker.js";
import { CALL_RELAY_KEY, decodeRelay, encodeRelay, resolveDraft, summarize } from "./callRelay.js";
import { createCloudflaredInstaller, downloadedCloudflared } from "./cloudflaredInstall.js";
import type { CredentialProtector } from "./credentials.js";
import { createHostingController, REOPEN_PUBLIC_KEY, START_ON_LAUNCH_KEY } from "./hosting.js";
import { startHostedServer } from "./hostedServer.js";
import type { Handler, Handlers } from "./ipcBoundary.js";
import { lookup } from "./lookup.js";
import { REGISTRY_KEY } from "./registry.js";
import type { SettingsStorage } from "./settings.js";
import {
  findCloudflared,
  healthUrl,
  openConfiguredAddress,
  openNamedTunnel,
  openQuickTunnel,
  probeHealth,
  resolvePublicAddress,
  validatePublicAddress,
} from "./tunnel.js";

type HostingChannel = Extract<Channel, `hosting:${string}`>;

/** The saved stable public address, which the host can type into Manage hosting. */
const PUBLIC_ADDRESS_KEY = "publicAddress";

export const HOSTING_KEYS = [
  REGISTRY_KEY,
  "lastHosted",
  START_ON_LAUNCH_KEY,
  REOPEN_PUBLIC_KEY,
  CALL_RELAY_KEY,
  PUBLIC_ADDRESS_KEY,
] as const;

/**
 * While OwnBase quits it starts no new work: these alone are answered, since
 * they only read or stop. Anything else is refused.
 */
const ANSWERED_WHILE_QUITTING = new Set<HostingChannel>([
  "hosting:status",
  "hosting:list",
  "hosting:lastHosted",
  "hosting:icon",
  "hosting:backups",
  "hosting:relay:get",
  "hosting:openAtLogin:get",
  "hosting:stop",
  "hosting:endOpenToAll",
  "hosting:dismissLaunchError",
]);

/** The folders the system's dialog is asked for, and how each asks. */
const FOLDER_DIALOGS = {
  backup: { title: "Choose where to save the backup", buttonLabel: "Back up here", create: true },
  autoBackup: {
    title: "Choose where to keep the backups",
    buttonLabel: "Back up here",
    create: true,
  },
  restore: {
    title: "Choose the folder of a backup to restore",
    buttonLabel: "Restore",
    create: false,
  },
  restoreOver: {
    title: "Choose the folder of an earlier backup",
    buttonLabel: "Restore",
    create: false,
  },
} as const;

export type FolderDialog = (typeof FOLDER_DIALOGS)[keyof typeof FOLDER_DIALOGS];

/** Opening OwnBase when someone signs in, where the OS can. */
export interface LoginItem {
  get(): boolean;
  /** Asks the OS, throwing why when it did not take. */
  set(open: boolean): void;
}

export interface HostingServiceOptions {
  /** The main process's own settings, out of the page's reach. */
  settings: SettingsStorage;
  credentials: CredentialProtector;
  dataRoot: string;
  /** Where OwnBase keeps the cloudflared it downloads. */
  cloudflaredFolder: string;
  /** Where the web client a hosted server hands out is kept. */
  webDistPath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Runs a backup, check or restore off the main thread. */
  inWorker<T>(job: BackupJob): Promise<T>;
  freeBytes(dir: string): Promise<number>;
  /** Shows a folder in the system's file manager; resolves to why it could not, or "". */
  openPath(path: string): Promise<string>;
  chooseFolder(dialog: FolderDialog): Promise<string | null>;
  /** Whether closing the window can keep hosting in the system tray. */
  backgroundAvailable(): boolean;
  loginItem: LoginItem | null;
  onChange(): void;
  /** Starts a workspace's server; tests replace it. */
  createServer?: typeof createWorkspaceServer;
}

/** This computer's own IPv4 addresses with `port`, as teammates on its network reach it. */
export function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(`${iface.address}:${port}`);
    }
  }
  return out;
}

/**
 * Hosting on this computer, whole: the workspace server and its list,
 * public links and what carries them, the call relay, starting with the
 * computer, and every hosting call the window makes. Each setting it keeps
 * is its own, in the main process's own file. It says what changed through
 * `onChange`, and the window hears the status pushed, never returned.
 */
export function createHostingService(options: HostingServiceOptions) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  let quitting = false;
  let trayStopping = false;
  let savedAddress: string | null = null;

  const settings = options.settings;

  const cloudflared = lookup(() =>
    findCloudflared(env, existsSync, platform, downloadedCloudflared(options.cloudflaredFolder)),
  );
  const addressConfig = lookup(() => resolvePublicAddress(savedAddress, env));
  const installer = createCloudflaredInstaller({
    dir: options.cloudflaredFolder,
    env,
    platform,
    find: () => {
      cloudflared.forget();
      return cloudflared.get();
    },
    onChange: () => options.onChange(),
  });

  /** What was looked up outside the app may have changed: look again next time. */
  function lookAgain(): void {
    cloudflared.forget();
    addressConfig.forget();
    installer.forget();
  }

  function addressCarriedElsewhere(): boolean {
    const config = addressConfig.get();
    return !!config && !("error" in config) && config.carrier === "elsewhere";
  }

  function publicAddressStatus() {
    const config = addressConfig.get();
    // A saved address the app can change, against one the environment fixed.
    const setting =
      savedAddress ??
      (config && !("error" in config) && config.carrier === "elsewhere" ? config.publicUrl : null);
    return {
      ...(setting ? { setting } : {}),
      ...(setting && !savedAddress ? { locked: true } : {}),
      ...(config && "error" in config ? { error: config.error } : {}),
      ...(config && !("error" in config)
        ? { url: config.publicUrl, ...(config.carrier === "ownbase" ? { managed: true } : {}) }
        : {}),
    };
  }

  /** Running workspaces that calls can be given a relay by, so a change reaches them at once. */
  const relayServers = new Set<WorkspaceServer>();
  let relay: Promise<CallRelay | null> | null = null;
  function savedRelay(): Promise<CallRelay | null> {
    relay ??= settings
      .get(CALL_RELAY_KEY, { strict: true })
      .then((value) => decodeRelay(value, options.credentials))
      .catch((error: unknown) => {
        // Read again next time: a locked key store may be unlocked by then.
        relay = null;
        throw error;
      });
    return relay;
  }

  async function relayStatus() {
    try {
      const current = await savedRelay();
      const error = [...relayServers].map((server) => server.relayError()).find(Boolean);
      return { ...summarize(current), ...(error ? { error } : {}) };
    } catch (error) {
      return {
        kind: "none" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const controller = createHostingController({
    dataRoot: options.dataRoot,
    defaultPort: DEFAULT_PORT,
    lanUrls,
    settings,
    stopped: {
      read: readStoppedWorkspace,
      icon: readStoppedIcon,
      iconVersion: readStoppedIconVersion,
      rename: renameStoppedWorkspace,
    },
    backupWorkspace: (request) => options.inWorker({ kind: "backup", ...request }),
    verifyBackup: (dir) => options.inWorker({ kind: "verify", dir }),
    restoreWorkspace: (request) => options.inWorker({ kind: "restore", ...request }),
    inventoryBackup: (dir) => options.inWorker({ kind: "inventory", dir }),
    freeBytes: options.freeBytes,
    openFolder: options.openPath,
    onChange: () => options.onChange(),
    startServer: (request) =>
      startHostedServer(request, {
        createServer: options.createServer ?? createWorkspaceServer,
        webDistPath: options.webDistPath,
        savedRelay,
        relayServers,
        publicAddressConfigured: () => {
          const config = addressConfig.get();
          return !!config && !("error" in config);
        },
      }),
    verifyLoopback: async (port, instanceId) =>
      // Only a reply from something that is not this run proves the port leads
      // elsewhere. A probe that cannot connect at all proves nothing.
      (await probeHealth(
        healthUrl(`http://127.0.0.1:${port}`),
        AbortSignal.timeout(3_000),
        instanceId,
      )) !== "something-else",
    tunnelAvailable: () => cloudflared.get() !== null || addressCarriedElsewhere(),
    publicAddress: publicAddressStatus,
    savePublicAddress: async (address) => {
      try {
        await settings.set(PUBLIC_ADDRESS_KEY, address);
      } catch {
        // Filesystem errors can contain the Windows account name and profile path.
        throw new Error(
          "OwnBase could not save the public address. Check that its settings folder is writable, then try again.",
        );
      }
      savedAddress = address;
      addressConfig.forget();
    },
    openTunnel: (port, signal, instanceId) => {
      lookAgain();
      const configured = addressConfig.get();
      if (configured && "error" in configured) throw new Error(configured.error);
      if (configured && !instanceId)
        throw new Error(
          "OwnBase cannot check that the public address leads to this workspace. Stop hosting, then start it again.",
        );
      // Nothing to install or start when something else already carries the address.
      if (configured?.carrier === "elsewhere")
        return openConfiguredAddress({ ...configured, port, signal, instanceId: instanceId! });
      const command = cloudflared.get();
      if (!command)
        throw new Error(
          "A public link needs cloudflared, a free program from Cloudflare. Install it, then try again.",
        );
      if (configured)
        return openNamedTunnel({ ...configured, command, port, signal, instanceId: instanceId! });
      return openQuickTunnel({ command, port, signal, instanceId });
    },
  });

  function status(): HostingStatus {
    const base = controller.status();
    // Offered only while a public link lacks it, and shown until an install ends.
    const install = installer.state();
    return {
      ...base,
      backgroundAvailable: options.backgroundAvailable(),
      ...(install && (base.tunnelAvailable === false || install.installing)
        ? { cloudflaredInstall: install }
        : {}),
    };
  }

  async function chooseFolder(dialog: keyof typeof FOLDER_DIALOGS): Promise<string | null> {
    return options.chooseFolder(FOLDER_DIALOGS[dialog]);
  }

  function loginItem(): LoginItem {
    if (!options.loginItem)
      throw new Error("Opening at sign-in needs OwnBase installed on Windows or macOS.");
    return options.loginItem;
  }

  const calls: Handlers<unknown, HostingChannel> = {
    "hosting:status": () => {
      // The window asking again, as Check again does, looks again too.
      lookAgain();
      return status();
    },
    "hosting:start": (_event, request) => {
      if (trayStopping) throw new Error("Wait for hosting to stop before starting a workspace.");
      return controller.start(request);
    },
    "hosting:stop": () => controller.stop(),
    "hosting:openToAll": (_event, accessPolicy) => controller.openToAll({ accessPolicy }),
    "hosting:endOpenToAll": () => controller.endOpenToAll(),
    "hosting:setAccessPolicy": (_event, accessPolicy) => controller.setAccessPolicy(accessPolicy),
    "hosting:setPublicAddress": (_event, value) => {
      if (typeof value !== "string") throw new Error("Enter the address as text.");
      const address = value.trim();
      // Refused here rather than saved, for Open to all to reject later out of sight.
      return controller.setPublicAddress(address ? validatePublicAddress(address) : null);
    },
    "hosting:installCloudflared": async () => {
      await installer.install();
    },
    // Unreadable settings mean no remembered workspace, not a failed call.
    "hosting:lastHosted": () => controller.lastHosted(),
    "hosting:list": () => controller.list(),
    "hosting:backup": async (_event, folder) => {
      const destination = await chooseFolder("backup");
      return destination ? controller.backup({ folder, destination }) : null;
    },
    "hosting:forget": (_event, folder) => controller.forget(folder),
    "hosting:rename": (_event, folder, name) => controller.rename({ folder, name }),
    "hosting:openFolder": (_event, folder) => controller.openFolder(folder),
    "hosting:icon": (_event, folder) => controller.icon(folder),
    "hosting:setStartOnLaunch": async (_event, folder) => {
      await controller.setStartOnLaunch(folder);
    },
    "hosting:setReopenPublicOnLaunch": async (_event, reopen) => {
      await controller.setReopenPublicOnLaunch(reopen);
    },
    "hosting:dismissLaunchError": () => controller.dismissLaunchError(),
    "hosting:setPort": async (_event, folder, port) => {
      await controller.setPort({ folder, port });
    },
    // Only the system's folder dialog chooses where backups go: the window can
    // ask for one, but never names a path itself.
    "hosting:setAutoBackup": async (_event, folder, schedule, chooseAnother) => {
      if (schedule === null) return controller.setAutoBackup({ folder, schedule: null });
      const { everyDays, keep } = (schedule ?? {}) as Record<string, unknown>;
      let destination: string | null = null;
      if (chooseAnother === true) {
        destination = await chooseFolder("autoBackup");
        if (!destination) return undefined;
      }
      const saved = await controller.setAutoBackup({
        folder,
        schedule: { everyDays, keep, ...(destination ? { destination } : {}) },
      });
      // A workspace not backed up yet is due at once, so the first backup is
      // made now, where the host can see it happen.
      void controller.runDueBackups();
      return saved;
    },
    "hosting:retryBackups": () => controller.runDueBackups(true),
    "hosting:restore": async () => {
      const backupDir = await chooseFolder("restore");
      return backupDir ? controller.restore({ backupDir }) : null;
    },
    "hosting:backups": (_event, folder) => controller.listBackups(folder),
    "hosting:restoreOver": async (_event, folder, backup) => {
      if (backup !== null) return controller.restoreOver({ folder, backup });
      const backupDir = await chooseFolder("restoreOver");
      return backupDir ? controller.restoreOver({ folder, backupDir }) : null;
    },
    "hosting:relay:get": () => relayStatus(),
    "hosting:relay:set": async (_event, draft) => {
      const next = resolveDraft(draft, await savedRelay().catch(() => null));
      const stored = next ? encodeRelay(next, options.credentials) : null;
      try {
        await settings.set(CALL_RELAY_KEY, stored);
      } catch {
        // Filesystem errors can name the Windows account; say what to do instead.
        throw new Error(
          "OwnBase could not save the relay. Check that its settings folder is writable, then try again.",
        );
      }
      relay = Promise.resolve(next);
      // Calls already connected keep their route; calls started from now, and
      // retries of ones that did not connect, are given this relay.
      for (const server of relayServers) server.setRelay(next);
      return relayStatus();
    },
    // A Cloudflare password asked for here lasts ten minutes.
    "hosting:relay:test": async (_event, draft) => {
      const next = resolveDraft(draft, await savedRelay().catch(() => null));
      if (!next) throw new Error("Choose a relay to test.");
      let servers;
      try {
        servers =
          next.kind === "cloudflare"
            ? await cloudflareIceServers(next, { ttl: 600 })
            : [{ urls: next.urls, username: next.username, credential: next.credential }];
      } catch (error) {
        if (error instanceof RelayError && error.field)
          throw new DesktopError(
            error.field === "keyId" ? "relay-key-id" : "relay-api-token",
            error.message,
          );
        throw error;
      }
      return servers
        .map((server) => ({ ...server, urls: [server.urls].flat().filter(isTurn) }))
        .filter((server) => server.urls.length > 0);
    },
    "hosting:openAtLogin:get": () => loginItem().get(),
    "hosting:openAtLogin:set": (_event, open) => {
      if (typeof open !== "boolean")
        throw new Error("Say whether to open at sign-in with true or false.");
      const item = loginItem();
      item.set(open);
      return item.get();
    },
  };

  const handlers = Object.fromEntries(
    Object.entries(calls).map(([channel, handler]) => [
      channel,
      (event: unknown, ...args: unknown[]) => {
        if (quitting && !ANSWERED_WHILE_QUITTING.has(channel as HostingChannel))
          throw new Error("OwnBase is shutting down. Try again after reopening it.");
        return (handler as (event: unknown, ...args: unknown[]) => unknown)(event, ...args);
      },
    ]),
  ) as Handlers<unknown, HostingChannel>;

  /**
   * A workspace announces itself on the interfaces there were when it started,
   * and the host dialog lists the addresses there were when it last looked.
   * After a wake, or a move to another network, both are redone. There is no
   * event for a network change, so the addresses are compared every few seconds.
   */
  function followNetworkChanges(onResume: (listener: () => void) => void): void {
    const addresses = () => lanUrls(0).sort().join(" ");
    let known = addresses();
    onResume(() => {
      known = addresses();
      controller.networkChanged();
    });
    setInterval(() => {
      const now = addresses();
      if (now === known) return;
      known = now;
      controller.networkChanged();
    }, 10_000).unref();
  }

  return {
    handlers,
    status,
    /** Reads what hosting keeps before anything asks for it. */
    async load(): Promise<void> {
      // Unreadable settings mean no saved address, not a failed launch: the
      // environment can still supply one, and Manage hosting can save one.
      const stored = await settings.get(PUBLIC_ADDRESS_KEY).catch(() => null);
      savedAddress = typeof stored === "string" && stored.trim() ? stored.trim() : null;
      addressConfig.forget();
    },
    followNetworkChanges,
    list: () => controller.list(),
    backupAttention: () => controller.backupAttention(),
    runDueBackups: (retryFailed = false) => controller.runDueBackups(retryFailed),
    startForLaunch: () => controller.startForLaunch(),
    stoppingFromTray: () => trayStopping,
    async stopFromTray(): Promise<void> {
      if (trayStopping || quitting) return;
      trayStopping = true;
      options.onChange();
      try {
        await controller.stop();
      } finally {
        trayStopping = false;
        options.onChange();
      }
    },
    setQuitting(on: boolean): void {
      quitting = on;
    },
    shutdown: () => controller.shutdown(),
    cancelInstall: () => installer.cancel(),
  };
}

export type HostingService = ReturnType<typeof createHostingService>;

/** A hosting handler typed for one channel, for tests that call them directly. */
export type HostingHandler<C extends HostingChannel> = Handler<C>;
