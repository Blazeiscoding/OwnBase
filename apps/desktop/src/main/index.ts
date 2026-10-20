import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
  nativeImage,
  powerMonitor,
  safeStorage,
  shell,
  Tray,
} from "electron";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import { Bonjour, type Service } from "bonjour-service";
import {
  DEEP_LINK_PROTOCOLS,
  DEFAULT_PORT,
  MDNS_SERVICE_TYPE,
  isIconVersion,
  isLinkableAddress,
  type DiscoveryTxt,
} from "@slackoss/protocol";
import type { OutboxChanges } from "@slackoss/client-core/outbox";
import type { DraftChanges } from "@slackoss/client-core/drafts";
import { applyRecordChanges, isRecordChanges } from "@slackoss/client-core/records";
import { addTrustedAddress } from "@slackoss/client-core/trustedAddresses";
import {
  cloudflareIceServers,
  createWorkspaceServer,
  isTurn,
  type CallRelay,
  type WorkspaceServer,
} from "@slackoss/server";
import createBackupWorker from "./backupWorker?nodeWorker";
import type { BackupJob, BackupReply } from "./backupWorker.js";
import { createSettingsStorage } from "./settings.js";
import {
  CALL_RELAY_KEY,
  decodeRelay,
  encodeRelay,
  resolveDraft,
  summarize,
  type CallRelaySummary,
} from "./callRelay.js";
import type { CredentialProtector } from "./credentials.js";
import { ClosePreparation } from "./closePreparation.js";
import { appRecipients, guarded, rendererUrlTrust, settingKey } from "./ipcBoundary.js";
import { writeGateReport } from "./releaseGate.js";
import {
  PlaceCheckpoint,
  RENDERER_RECOVERY,
  RendererRecovery,
  isRendererLoadFailure,
} from "./rendererRecovery.js";
import { ScreenChoice, SourceList, THUMBNAIL_SIZE, findSource } from "./screenShare.js";
import { mergeOutboxSetting } from "./outboxStorage.js";
import { mergeDraftsSetting } from "./draftsStorage.js";
import { createHostingController } from "./hosting.js";
import { startHostedServer } from "./hostedServer.js";
import { backupTrayItems } from "./trayBackups.js";
import { loginItemOptions, loginItemProblem, openedAtLogin } from "./loginItem.js";
import {
  findCloudflared,
  openConfiguredAddress,
  openNamedTunnel,
  openQuickTunnel,
  probeHealth,
  resolvePublicAddress,
  validatePublicAddress,
  type PublicAddressConfig,
} from "./tunnel.js";

const isDev = !!process.env.ELECTRON_RENDERER_URL;
/** Tandem name first, previous GATHERLINE_ and SLACKOSS_ names still read. */
const appEnv = (name: string): string | undefined =>
  process.env[`TANDEM_${name}`] ??
  process.env[`GATHERLINE_${name}`] ??
  process.env[`SLACKOSS_${name}`];
const isTest = appEnv("TEST") === "1";
// Branding must not move existing settings, credentials, or hosted databases.
const legacyUserData = app.getPath("userData");
app.setName("Tandem");
app.setPath("userData", appEnv("USER_DATA_DIR") ?? legacyUserData);
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** The app's own page, as the main window loads it. */
const rendererUrl = isDev
  ? process.env.ELECTRON_RENDERER_URL!
  : pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).href;
const trustedRenderer = rendererUrlTrust(rendererUrl);
/**
 * Every request the main process answers comes from the app's own window,
 * its top frame, showing the app's page; anything else is refused before
 * its work starts (REV-14).
 */
const handle = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
): void =>
  ipcMain.handle(
    channel,
    guarded(() => mainWindow, trustedRenderer, listener),
  );
/**
 * Tells the app's window something, and no other window (F09): what is
 * pushed here includes drafts, unsent messages and invite links. `except` is
 * the window whose own change this is.
 */
const pushToApp = (channel: string, args: unknown[], except?: number): void => {
  for (const win of appRecipients(mainWindow, trustedRenderer, except))
    win.webContents.send(channel, ...args);
};
let rendererReady = false;
let quitting = false;
let quitReady = false;
let quitTask: Promise<void> | null = null;

handle("file:download", (_event, value: unknown) => {
  if (!mainWindow || typeof value !== "string") throw new Error("Invalid download request");
  const url = new URL(value);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    !/\/api\/files\/[0-9A-HJKMNP-TV-Z]{26}$/.test(url.pathname) ||
    !/^[a-f0-9]{64}$/.test(url.searchParams.get("download") ?? "") ||
    [...url.searchParams.keys()].some((key) => key !== "download")
  )
    throw new Error("Invalid download URL");
  mainWindow.webContents.downloadURL(url.toString());
});

if ((isDev || isTest) && appEnv("TEST_MEDIA") === "1") {
  app.commandLine.appendSwitch("remote-debugging-port", "9222");
  // Fake mic/camera so huddles can be exercised without real hardware.
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

// ---------- tandem:// deep links (gatherline:// and slackoss:// still open) ----------

/** Held until a window exists to receive it (cold start via a link). */
let pendingDeepLink: string | null = null;

function deliverDeepLink(url: string): void {
  pendingDeepLink = url;
  const win = showMainWindow();
  if (win && rendererReady && appRecipients(win, trustedRenderer).length > 0) {
    pendingDeepLink = null;
    pushToApp("deeplink", [url]);
  }
}

function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((a) => DEEP_LINK_PROTOCOLS.some((p) => a.startsWith(`${p}://`))) ?? null;
}

// A second launch must hand its link to the running instance, not open a
// second window with its own embedded server.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const url = deepLinkFromArgv(argv);
    if (url) deliverDeepLink(url);
    else showMainWindow();
  });
}

// macOS delivers links through this event rather than argv.
app.on("open-url", (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});

if (!isTest && isDev && process.platform === "win32") {
  // In dev the executable is electron.exe, so the protocol must point at it
  // plus this project's entry, or Windows would launch a bare Electron.
  for (const protocol of DEEP_LINK_PROTOCOLS) {
    app.setAsDefaultProtocolClient(protocol, process.execPath, [
      join(import.meta.dirname, "../.."),
    ]);
  }
} else if (!isTest) {
  for (const protocol of DEEP_LINK_PROTOCOLS) {
    app.setAsDefaultProtocolClient(protocol);
  }
}

// A notification clicked while the window is minimized, or closed to the tray
// while hosting, brings the window back as well as opening its message.
handle("window:reveal", () => {
  showMainWindow();
});

// Where the page is, kept here so a recovery can put it back (F08).
let place = new PlaceCheckpoint(trustedRenderer);
handle("window:rememberPlace", (_event, url: unknown, state: unknown) => {
  place.remember(url, state);
});
handle("window:takePlace", () => place.take());

handle("deeplink:consume", () => {
  rendererReady = true;
  const url = pendingDeepLink;
  pendingDeepLink = null;
  return url;
});

// The huddle's screen picker is the app's own: it lists every screen and
// window with a picture of each, then names the one chosen, which the
// getDisplayMedia request after it shares.
const screenSources = new SourceList((pictures) =>
  desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: pictures ? THUMBNAIL_SIZE : { width: 0, height: 0 },
    fetchWindowIcons: pictures,
  }),
);
const screenChoice = new ScreenChoice();
handle("screen:sources", (_event, quick: unknown) =>
  quick === true ? screenSources.quick() : screenSources.full(),
);
handle("screen:choose", async (_event, id: unknown) => {
  screenChoice.hold(
    await findSource(id, () =>
      desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 },
      }),
    ),
  );
});

// ---------- settings and OS-protected saved sign-ins ----------

const credentialProtector: CredentialProtector = {
  isAvailable: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" ||
      !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())),
  encryptString: (value) => safeStorage.encryptString(value),
  decryptString: (value) => safeStorage.decryptString(value),
};
const settings = createSettingsStorage(
  join(app.getPath("userData"), "settings.json"),
  credentialProtector,
);
const closePreparation = new ClosePreparation();
handle("window:preparedClose", (event, id: unknown, saved: unknown) =>
  closePreparation.acknowledge(event.sender.id, id, saved),
);

/** Input stays in the live window until its owners and settings have acknowledged it (N03). */
async function prepareLocalWrites(win: BrowserWindow | null, forQuit: boolean): Promise<boolean> {
  for (;;) {
    if (win && !win.isDestroyed()) win.setEnabled(false);
    try {
      const active = win && !win.isDestroyed() ? win : null;
      await closePreparation.prepare(
        active?.webContents.id ?? null,
        (id) => {
          if (!active || appRecipients(active, trustedRenderer).length === 0)
            throw new Error("Unavailable window");
          active.webContents.send("window:prepareClose", id);
        },
        () => settings.drain(),
      );
      return true;
    } catch {
      if (win && !win.isDestroyed()) {
        win.setEnabled(true);
        if (!isTest) win.show();
      }
      const choice = await dialog.showMessageBox({
        type: "warning",
        title: "Local work could not finish saving",
        message: "Keep Tandem open to protect your final words?",
        detail:
          "Some drafts or queued messages could not finish saving. Retry saving, or keep the window open to copy your words. Leaving without saving may lose that unfinished work.",
        buttons: [
          "Retry saving",
          "Keep open to copy",
          forQuit ? "Quit without saving" : "Close without saving",
        ],
        defaultId: 1,
        cancelId: 1,
      });
      if (choice.response === 1) return false;
      if (choice.response === 2) return true;
    }
  }
}

handle("storage:get", (_e, key: unknown, options?: { strict?: boolean }) =>
  settings.get(settingKey(key), { strict: options?.strict === true }),
);

// Stores a value only where none is, in the settings queue every window's
// writes share, so a window that read nothing cannot replace another's (GL-01).
handle("storage:initialize", (_e, key: unknown, value: unknown) =>
  settings.update(settingKey(key), (current) =>
    current === null || current === undefined ? value : current,
  ),
);

// An approved address joins the trusted ones in the same queue, so two
// windows approving another address at once both keep theirs (Q02).
handle("storage:trustAddress", async (_e, key: unknown, address: unknown) => {
  if (typeof address !== "string") throw new Error("Invalid workspace address.");
  let addresses: string[] | null = null;
  await settings.update(settingKey(key), (current) => {
    const change = addTrustedAddress(current, address);
    addresses = change.addresses;
    return change.value;
  });
  return addresses;
});

const writeSetting = (key: string, value: unknown) => settings.set(key, value);

/** Running workspaces that calls can be given a relay by, so a change reaches them at once. */
const relayServers = new Set<WorkspaceServer>();
let callRelay: Promise<CallRelay | null> | null = null;

function savedCallRelay(): Promise<CallRelay | null> {
  callRelay ??= settings
    .get(CALL_RELAY_KEY, { strict: true })
    .then((value) => decodeRelay(value, credentialProtector))
    .catch((error: unknown) => {
      // Read again next time: a locked key store may be unlocked by then.
      callRelay = null;
      throw error;
    });
  return callRelay;
}
handle("storage:set", (_e, key: unknown, value: unknown) => writeSetting(settingKey(key), value));

// Outbox changes from every window are merged here, one at a time; the other
// windows hear what is stored now, so each can take on what it did not see.
handle(
  "storage:mergeOutbox",
  async (event, key: unknown, changes: OutboxChanges, enveloped: boolean) => {
    const { value, outbox } = await mergeOutboxSetting(
      settings,
      settingKey(key),
      changes,
      enveloped,
    );
    pushToApp("storage:outboxChanged", [key, value], event.sender.id);
    return outbox;
  },
);

// Drafts likewise: each window's changed drafts, merged here one at a time.
handle(
  "storage:mergeDrafts",
  async (event, key: unknown, changes: DraftChanges, enveloped: boolean) => {
    const { value, drafts } = await mergeDraftsSetting(
      settings,
      settingKey(key),
      changes,
      enveloped,
    );
    pushToApp("storage:draftsChanged", [key, value], event.sender.id);
    return drafts;
  },
);

// Records likewise: each window's changed names only, such as one account's
// notification choice, so no window's whole copy erases another's (F02).
handle("storage:mergeRecord", async (event, key: unknown, changes: unknown) => {
  if (!isRecordChanges(changes)) throw new Error("Invalid record changes.");
  let value: Record<string, string> = {};
  await settings.update(
    settingKey(key),
    (current) => (value = applyRecordChanges(current, changes)),
  );
  pushToApp("storage:recordChanged", [key, value], event.sender.id);
  return value;
});

// ---------- LAN discovery (mDNS browse) ----------

const bonjour = new Bonjour();
const discovered = new Map<string, Service>();

/** What the Join screen lists: each advertisement at an address a link can reach. */
function discoveredServers() {
  return [...discovered.values()].flatMap((s) => {
    const host = pickAddress(s.addresses ?? []);
    if (!host) return [];
    const txt = (s.txt ?? {}) as Partial<DiscoveryTxt>;
    return [
      {
        name: txt.name ?? s.name,
        host,
        port: s.port,
        serverVersion: txt.ver ?? "?",
        ...(txt.inst ? { instanceId: txt.inst } : {}),
        // Anyone on the network can announce anything, and this goes into a
        // request to the address it came from.
        ...(isIconVersion(txt.icon) ? { iconVersion: txt.icon } : {}),
      },
    ];
  });
}

function publishDiscovered(): void {
  const servers = discoveredServers();
  pushToApp("lan:servers", [servers]);
}

/**
 * IPv4 when there is one, which every network and browser handles; otherwise
 * an IPv6 address a link can carry. Null when the only addresses are
 * link-local IPv6, which work only with an interface no URL can name.
 */
function pickAddress(addresses: string[]): string | null {
  return (
    addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ??
    addresses.find((a) => a.includes(":") && isLinkableAddress(a)) ??
    null
  );
}

function startDiscovery(): void {
  const browser = bonjour.find({ type: MDNS_SERVICE_TYPE });
  const seen = (service: Service) => {
    discovered.set(service.fqdn, service);
    publishDiscovered();
  };
  browser.on("up", seen);
  // A workspace announcing again under the same name, as when its icon
  // changes, is the same service with a new record, not a new one.
  browser.on("txt-update", seen);
  browser.on("srv-update", seen);
  browser.on("down", (service) => {
    discovered.delete(service.fqdn);
    publishDiscovered();
  });
}

handle("lan:snapshot", () => discoveredServers());

// ---------- "Open to LAN" hosting (server runs in this process) ----------

function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(`${iface.address}:${port}`);
    }
  }
  return out;
}

function hostingStatus() {
  return { ...hosting.status(), backgroundAvailable: !!tray && !tray.isDestroyed() };
}

/** Looked up again at most every few seconds, so installing it takes effect without a restart. */
let cloudflaredLookup: { at: number; path: string | null } | null = null;
function cloudflared(): string | null {
  if (!cloudflaredLookup || Date.now() - cloudflaredLookup.at > 5_000)
    cloudflaredLookup = { at: Date.now(), path: findCloudflared() };
  return cloudflaredLookup.path;
}

/**
 * The saved address, kept in memory because hosting status is read far more
 * often than it changes and a settings read cannot block a snapshot. Loaded
 * once at startup and updated by whoever writes it.
 */
let savedPublicAddress: string | null = null;

/** Read again on the same schedule, so a corrected setting needs no restart. */
let publicAddressLookup: { at: number; config: PublicAddressConfig } | null = null;
function publicAddressConfig(): PublicAddressConfig {
  if (!publicAddressLookup || Date.now() - publicAddressLookup.at > 5_000)
    publicAddressLookup = { at: Date.now(), config: resolvePublicAddress(savedPublicAddress) };
  return publicAddressLookup.config;
}

/** Opening to all needs no cloudflared when something else already carries the address. */
function publicAddressCarriedElsewhere(): boolean {
  const config = publicAddressConfig();
  return !!config && !("error" in config) && config.carrier === "elsewhere";
}

/** What the hosting status reports about the stable address, for display and editing. */
function publicAddressStatus(): {
  setting?: string;
  locked?: boolean;
  url?: string;
  managed?: boolean;
  error?: string;
} {
  const config = publicAddressConfig();
  // A saved address the app can change, against one the environment fixed.
  const fromEnvironment = !savedPublicAddress;
  const setting =
    savedPublicAddress ??
    (config && !("error" in config) && config.carrier === "elsewhere" ? config.publicUrl : null);
  return {
    ...(setting ? { setting } : {}),
    ...(setting && fromEnvironment ? { locked: true } : {}),
    ...(config && "error" in config ? { error: config.error } : {}),
    ...(config && !("error" in config)
      ? { url: config.publicUrl, ...(config.carrier === "tandem" ? { managed: true } : {}) }
      : {}),
  };
}

/**
 * Runs a backup, check or restore on a worker thread, so the window and the
 * hosted server keep answering while SQLite copies or checks the database.
 */
function inWorker<T>(job: BackupJob): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = createBackupWorker({ workerData: job });
    let settled = false;
    worker.once("message", (reply: BackupReply) => {
      settled = true;
      if (reply.ok) resolve(reply.result as T);
      else reject(new Error(reply.message));
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`The backup stopped before it finished (exit code ${code}).`));
    });
  });
}

const hosting = createHostingController({
  dataRoot: join(app.getPath("userData"), "hosted"),
  defaultPort: DEFAULT_PORT,
  lanUrls,
  settings,
  backupWorkspace: (options) => inWorker({ kind: "backup", ...options }),
  verifyBackup: (dir) => inWorker({ kind: "verify", dir }),
  restoreWorkspace: (options) => inWorker({ kind: "restore", ...options }),
  freeBytes: async (dir) => {
    const info = await statfs(dir);
    return info.bavail * info.bsize;
  },
  openFolder: (path) => shell.openPath(path),
  onChange: publishHostingStatus,
  inventoryBackup: (dir) => inWorker({ kind: "inventory", dir }),
  startServer: (request) =>
    startHostedServer(request, {
      createServer: createWorkspaceServer,
      webDistPath: app.isPackaged
        ? join(process.resourcesPath, "web")
        : join(import.meta.dirname, "../../../web/dist"),
      savedRelay: savedCallRelay,
      relayServers,
      publicAddressConfigured: () => {
        const configured = publicAddressConfig();
        return !!configured && !("error" in configured);
      },
    }),
  verifyLoopback: async (port, instanceId) =>
    // Only a reply from something that is not this run proves the port leads
    // elsewhere. A probe that cannot connect at all proves nothing, and must
    // not produce a warning naming a program that may not be there.
    (await probeHealth(
      `http://127.0.0.1:${port}/api/health`,
      AbortSignal.timeout(3_000),
      instanceId,
    )) !== "something-else",
  tunnelAvailable: () => cloudflared() !== null || publicAddressCarriedElsewhere(),
  publicAddress: publicAddressStatus,
  savePublicAddress: async (address) => {
    try {
      await writeSetting("publicAddress", address);
    } catch {
      // Filesystem errors can contain the Windows account name and profile
      // path. Give the renderer a useful message without leaking either.
      throw new Error(
        "Tandem could not save the public address. Check that its settings folder is writable, then try again.",
      );
    }
    savedPublicAddress = address;
    publicAddressLookup = null;
  },
  openTunnel: (port, signal, instanceId) => {
    cloudflaredLookup = null;
    publicAddressLookup = null;
    const configured = publicAddressConfig();
    if (configured && "error" in configured) throw new Error(configured.error);
    if (configured && !instanceId)
      throw new Error("The hosted workspace cannot verify its public address. Restart hosting.");
    // Nothing to install or start when something else already carries the
    // address here; the workspace only has to answer at it.
    if (configured?.carrier === "elsewhere")
      return openConfiguredAddress({ ...configured, port, signal, instanceId: instanceId! });
    const command = cloudflared();
    if (!command)
      throw new Error(
        "Open to all needs Cloudflare's free cloudflared tool. Install it, then try again.",
      );
    if (configured)
      return openNamedTunnel({ ...configured, command, port, signal, instanceId: instanceId! });
    return openQuickTunnel({ command, port, signal, instanceId });
  },
});

handle("hosting:status", () => hostingStatus());
// Unreadable settings mean no remembered workspace, not a failed call: the
// join screen simply shows no resume offer.
handle("hosting:lastHosted", () => hosting.lastHosted());
handle("hosting:list", () => hosting.list());
handle("hosting:forget", (_e, folder: unknown) => hosting.forget(folder));
handle("hosting:rename", (_e, request: unknown) => hosting.rename(request));
// The window names a listed workspace; the controller finds its folder.
handle("hosting:openFolder", (_e, folder: unknown) => hosting.openFolder(folder));
// The same: the window names a listed workspace, and gets its icon or null.
handle("hosting:icon", (_e, folder: unknown) => hosting.icon(folder));
handle("hosting:setPort", (_e, request: unknown) => hosting.setPort(request));
/**
 * Turns a workspace's scheduled backups on, changes them, or turns them off.
 * Only the system's folder dialog chooses where they go: the window can ask
 * for one, but never names a path itself.
 */
handle(
  "hosting:setAutoBackup",
  async (event, folder: unknown, schedule: unknown, chooseFolder: unknown) => {
    if (quitting) throw new Error("Tandem is shutting down.");
    if (schedule === null) return hosting.setAutoBackup({ folder, schedule: null });
    const { everyDays, keep } = (schedule ?? {}) as Record<string, unknown>;
    let destination: string | undefined;
    if (chooseFolder === true) {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options = {
        title: "Choose where to keep the backups",
        buttonLabel: "Back up here",
        properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
      };
      const choice = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      // Choosing no folder changes nothing.
      if (choice.canceled || !choice.filePaths[0]) return undefined;
      destination = choice.filePaths[0];
    }
    const saved = await hosting.setAutoBackup({
      folder,
      schedule: { everyDays, keep, ...(destination ? { destination } : {}) },
    });
    // A workspace not backed up yet is due at once, so the first backup is made
    // now, where the host can see it happen, rather than in a quarter of an hour.
    void hosting.runDueBackups();
    return saved;
  },
);
handle("hosting:runDueBackups", () => hosting.runDueBackups(true));
handle("hosting:setReopenPublicOnLaunch", (_e, reopen: unknown) =>
  hosting.setReopenPublicOnLaunch(reopen),
);
handle("hosting:setStartOnLaunch", (_e, folder: unknown) => hosting.setStartOnLaunch(folder));
handle("hosting:dismissLaunchError", () => {
  hosting.dismissLaunchError();
  return hostingStatus();
});

// ---------- starting with the computer ----------

/**
 * The OS opens only an installed app at sign-in: a copy run from source would
 * register Electron itself. Linux has no single place for it that Electron
 * manages, so it is offered on Windows and macOS.
 */
const loginItemAvailable =
  app.isPackaged && (process.platform === "win32" || process.platform === "darwin");
/** Tests must never register the real app with the OS; they get this instead. */
let testOpenAtLogin = false;

function openAtLogin(): boolean | null {
  if (!loginItemAvailable) return null;
  if (isTest) return testOpenAtLogin;
  return app.getLoginItemSettings(loginItemOptions(process.platform)).openAtLogin;
}

handle("hosting:openAtLogin", () => openAtLogin());
handle("hosting:setOpenAtLogin", (_e, open: unknown) => {
  if (typeof open !== "boolean")
    throw new Error("Say whether to open at sign-in with true or false.");
  if (!loginItemAvailable)
    throw new Error("Opening at sign-in needs Tandem installed on Windows or macOS.");
  if (isTest) {
    testOpenAtLogin = open;
    return openAtLogin();
  }
  const options = loginItemOptions(process.platform);
  app.setLoginItemSettings({ openAtLogin: open, ...options });
  const problem = loginItemProblem(process.platform, open, app.getLoginItemSettings(options));
  if (problem) throw new Error(problem);
  return openAtLogin();
});

/** This computer's own network addresses, to notice when they change. */
function addressKey(): string {
  return lanUrls(0).sort().join(" ");
}

/**
 * A workspace announces itself on the interfaces there were when it started,
 * and the host dialog lists the addresses there were when it last looked.
 * After a wake, or a move to another network, both are redone. There is no
 * event for a network change, so the addresses are compared every few seconds.
 */
function followNetworkChanges(): void {
  let known = addressKey();
  powerMonitor.on("resume", () => {
    known = addressKey();
    hosting.networkChanged();
  });
  setInterval(() => {
    const now = addressKey();
    if (now === known) return;
    known = now;
    hosting.networkChanged();
  }, 10_000).unref();
}
handle("hosting:restore", async (event) => {
  if (quitting) throw new Error("Tandem is shutting down.");
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Choose the folder of a backup to restore",
    buttonLabel: "Restore",
    properties: ["openDirectory"] as "openDirectory"[],
  };
  const choice = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (choice.canceled || !choice.filePaths[0]) return null;
  return hosting.restore({ backupDir: choice.filePaths[0] });
});
handle("hosting:backups", (_e, folder: unknown) => hosting.listBackups(folder));
handle("hosting:restoreOver", async (event, folder: unknown, backup: unknown) => {
  if (quitting) throw new Error("Tandem is shutting down.");
  if (backup !== null) return hosting.restoreOver({ folder, backup });
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Choose the folder of an earlier backup",
    buttonLabel: "Restore",
    properties: ["openDirectory"] as "openDirectory"[],
  };
  const choice = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (choice.canceled || !choice.filePaths[0]) return null;
  return hosting.restoreOver({ folder, backupDir: choice.filePaths[0] });
});
handle("hosting:backup", async (event, folder: unknown) => {
  if (quitting) throw new Error("Tandem is shutting down.");
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Choose where to save the backup",
    buttonLabel: "Back up here",
    properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
  };
  const choice = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  // Choosing no folder is not a failure: nothing happens.
  if (choice.canceled || !choice.filePaths[0]) return null;
  return hosting.backup({ folder, destination: choice.filePaths[0] });
});
handle("hosting:start", async (_e, opts: unknown) => {
  if (quitting) throw new Error("Tandem is shutting down. Try again after reopening it.");
  if (trayStopPending) throw new Error("Wait for hosting to stop before starting a workspace.");
  await hosting.start(opts);
  return hostingStatus();
});
handle("hosting:stop", () => hosting.stop());
handle("hosting:openToAll", async (_e, opts: unknown) => {
  if (quitting) throw new Error("Tandem is shutting down.");
  await hosting.openToAll(opts);
  return hostingStatus();
});
handle("hosting:endOpenToAll", async () => {
  await hosting.endOpenToAll();
  return hostingStatus();
});
handle("hosting:setInviteOnly", async (_e, value: unknown) => {
  await hosting.setInviteOnly(value);
  return hostingStatus();
});
handle("hosting:setAccessPolicy", async (_e, value: unknown) => {
  await hosting.setAccessPolicy(value);
  return hostingStatus();
});
handle("hosting:setPublicAddress", async (_e, value: unknown) => {
  if (typeof value !== "string") throw new Error("Enter the address as text.");
  const address = value.trim();
  // Refuse here rather than saving something Open to all would only reject
  // later, when the setting is out of sight.
  const saving = address ? validatePublicAddress(address) : null;
  // The controller serializes this with opening/closing, secures registration
  // before an external carrier can be trusted, and clears errors from the old
  // carrier only after persistence succeeds.
  await hosting.setPublicAddress(saving);
  return hostingStatus();
});

// ---------- the TURN relay for calls between networks ----------

async function relayStatus(): Promise<CallRelaySummary & { error?: string }> {
  try {
    const relay = await savedCallRelay();
    const error = [...relayServers].map((server) => server.relayError()).find(Boolean);
    return { ...summarize(relay), ...(error ? { error } : {}) };
  } catch (error) {
    return { kind: "none", error: error instanceof Error ? error.message : String(error) };
  }
}

handle("hosting:relay", () => relayStatus());
handle("hosting:setRelay", async (_e, draft: unknown) => {
  const relay = resolveDraft(draft, await savedCallRelay().catch(() => null));
  const stored = relay ? encodeRelay(relay, credentialProtector) : null;
  try {
    await writeSetting(CALL_RELAY_KEY, stored);
  } catch {
    // Filesystem errors can name the Windows account; say what to do instead.
    throw new Error(
      "Tandem could not save the relay. Check that its settings folder is writable, then try again.",
    );
  }
  callRelay = Promise.resolve(relay);
  // Calls already connected keep their route; calls started from now, and
  // retries of ones that did not connect, are given this relay.
  for (const server of relayServers) server.setRelay(relay);
  return relayStatus();
});
/**
 * The relay a draft describes, as a call would be given it, so the hosting
 * window can check it gives a route before anyone depends on it. A
 * Cloudflare password asked for here lasts ten minutes.
 */
handle("hosting:testRelay", async (_e, draft: unknown) => {
  const relay = resolveDraft(draft, await savedCallRelay().catch(() => null));
  if (!relay) throw new Error("Choose a relay to test.");
  const servers =
    relay.kind === "cloudflare"
      ? await cloudflareIceServers(relay, { ttl: 600 })
      : [{ urls: relay.urls, username: relay.username, credential: relay.credential }];
  return servers
    .map((server) => ({ ...server, urls: [server.urls].flat().filter(isTurn) }))
    .filter((server) => server.urls.length > 0);
});

function publishHostingStatus(): void {
  const status = hostingStatus();
  pushToApp("hosting:changed", [status]);
  updateTray();
}

function showMainWindow(): BrowserWindow | null {
  if (!app.isReady() || quitting) return null;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const win = mainWindow!;
  if (win.isMinimized()) win.restore();
  if (!isTest) win.show();
  win.focus();
  return win;
}

async function confirmStopAndQuit(): Promise<boolean> {
  const choice = await dialog.showMessageBox({
    type: "question",
    title: "Stop hosting and quit?",
    message: "Quit Tandem and stop the hosted workspace?",
    detail:
      "Teammates will be disconnected until you start hosting again. Stored messages and files stay on this computer.",
    buttons: ["Cancel", "Stop hosting and quit"],
    defaultId: 0,
    cancelId: 0,
  });
  return choice.response === 1;
}

let trayStopPending = false;
// The tray's label already says hosting stops, so it does not ask first.
async function stopFromTray(): Promise<void> {
  if (trayStopPending || quitting) return;
  trayStopPending = true;
  updateTray();
  try {
    await hosting.stop();
  } catch {
    showMainWindow();
    await dialog.showMessageBox({
      type: "error",
      message: "The workspace could not be stopped. Open hosting controls and try again.",
    });
  } finally {
    trayStopPending = false;
    updateTray();
  }
}

function updateTray(): void {
  if (!tray || tray.isDestroyed()) return;
  const status = hosting.status();
  const label =
    status.phase === "starting"
      ? "Starting workspace…"
      : status.phase === "stopping"
        ? "Stopping workspace…"
        : status.running
          ? `Hosting ${status.workspaceName} · ${status.openToAll?.phase === "open" ? "open to all" : `port ${status.port}`}${
              status.connected !== undefined ? ` · ${status.connected} connected` : ""
            }`
          : "Not hosting";
  // Hosting can be running while part of starting with Tandem failed, or
  // a scheduled backup keep failing; the tray is often all there is to see at
  // sign-in, so it says so too.
  const backups = backupTrayItems(hosting.backupAttention());
  const attention = status.launchError || backups.length ? " · needs attention" : "";
  tray.setToolTip(`Tandem — ${label}${attention}`.slice(0, 127));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Tandem",
        click: () => {
          showMainWindow();
        },
      },
      { label: label.replaceAll("&", "&&"), enabled: false },
      ...(status.launchError
        ? [
            {
              label:
                status.launchErrorPart === "public-address"
                  ? "Public address not reopened: see why…"
                  : "Did not start with Tandem: see why…",
              click: () => {
                showMainWindow();
              },
            },
          ]
        : []),
      ...backups.map((item) => ({
        label: item.label,
        click: () => {
          if (item.action === "show") showMainWindow();
          // An explicit retry can bypass the automatic failure backoff.
          else void hosting.runDueBackups(true);
        },
      })),
      {
        label: "Stop hosting",
        enabled: status.phase === "running" && !quitting && !trayStopPending,
        click: () => {
          void stopFromTray().catch(() => {});
        },
      },
      { type: "separator" },
      {
        label: status.phase === "stopped" ? "Quit Tandem" : "Stop hosting and quit",
        enabled: !quitting && !trayStopPending,
        // The label already says hosting stops, so it does not ask again.
        click: () => quitTandem(true),
      },
    ]),
  );
}

function createTray(): void {
  try {
    const file = process.platform === "win32" ? "icon.ico" : "icon.png";
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, "tray", file)
      : join(import.meta.dirname, "../../build", file);
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error("Tray icon is missing.");
    tray = new Tray(
      process.platform === "win32" ? iconPath : icon.resize({ width: 18, height: 18 }),
    );
    tray.on("click", () => {
      showMainWindow();
    });
    tray.on("double-click", () => {
      showMainWindow();
    });
    updateTray();
  } catch {
    tray?.destroy();
    tray = null;
    // A desktop without tray support keeps a hosted window in the taskbar.
  }
}

// ---------- window ----------

function createWindow(): void {
  // A new window starts where the app starts, not where a closed one was.
  place = new PlaceCheckpoint(trustedRenderer);
  mainWindow = new BrowserWindow({
    show: !isTest,
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    // The deep and ink-dim colours of packages/ui/src/theme.css: the window
    // shows this before the page paints, and the overlay sits on the window's
    // own surface, above the sidebar and the conversation card.
    backgroundColor: "#111115",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#111115",
      symbolColor: "#b9bac0",
      height: 40,
    },
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  const win = mainWindow;
  let closeAllowed = false;
  let windowCloseTask: Promise<void> | null = null;
  rendererReady = false;
  win.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) rendererReady = false;
  });
  win.on("close", (event) => {
    if (quitReady || closeAllowed) return;
    if (quitting || hosting.status().phase !== "stopped") {
      event.preventDefault();
      if (hostingStatus().backgroundAvailable) win.hide();
      else win.minimize();
      return;
    }
    event.preventDefault();
    if (process.platform !== "darwin") {
      app.quit();
      return;
    }
    if (windowCloseTask) return;
    windowCloseTask = (async () => {
      if (await prepareLocalWrites(win, false)) {
        closeAllowed = true;
        win.close();
      }
    })().finally(() => {
      windowCloseTask = null;
      if (!win.isDestroyed()) win.setEnabled(true);
    });
    void windowCloseTask.catch(() => {});
  });
  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
      rendererReady = false;
    }
  });

  // Huddles need the microphone, screen share needs display capture, and
  // notifications need their own permission: refused, the renderer's
  // Notification reports "denied" and never shows. A huddle's stage goes full
  // screen; refused, its request never settles and the stage stays put.
  // Grant those to our own renderer; refuse everything else.
  const allowed = new Set(["media", "display-capture", "notifications", "fullscreen"]);
  mainWindow.webContents.session.setPermissionRequestHandler(
    (wc, permission, callback, details) => {
      callback(
        wc === mainWindow?.webContents &&
          details.isMainFrame &&
          trustedRenderer(details.requestingUrl) &&
          allowed.has(permission),
      );
    },
  );
  mainWindow.webContents.session.setPermissionCheckHandler((wc, permission, _origin, details) => {
    return (
      wc === mainWindow?.webContents &&
      trustedRenderer(details.requestingUrl ?? wc.getURL()) &&
      allowed.has(permission)
    );
  });
  // The window chose what to share in its own picker just before asking, so
  // no system picker is shown: the request shares that choice, or nothing.
  mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    const chosen = request.frame && trustedRenderer(request.frame.url) ? screenChoice.take() : null;
    callback(chosen ? { video: chosen } : {});
  });
  mainWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  // External links open in the OS browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // A page that dies or does not load is loaded again, a few times, then the
  // person is asked (REV-09). Hosting runs in this process and carries on
  // either way; what the page had saved comes back with it.
  const recovery = new RendererRecovery();
  const recover = async (what: string, fresh: boolean) => {
    if (win.isDestroyed() || quitting) return;
    rendererReady = false;
    // A page that ran loads again where it was: the address it last reported,
    // and its history entry handed back (F08). One that never loaded starts
    // again from the app's own page, still given the place to return to.
    // Loading the address anew rather than reloading: a crashed page may have
    // nothing to reload.
    const where = place.recover() ?? win.webContents.getURL();
    const reopen = () =>
      fresh || !trustedRenderer(where)
        ? loadRenderer(win)
        : void win.loadURL(where).catch(() => {});
    if (recovery.failed() === "reload") {
      setTimeout(() => {
        if (!win.isDestroyed() && !quitting) reopen();
      }, RENDERER_RECOVERY.reloadDelayMs);
      return;
    }
    const { response } = await dialog.showMessageBox(win, {
      type: "error",
      title: "Tandem",
      message: "Tandem's window keeps stopping.",
      detail: `${what} A hosted workspace keeps running, and messages saved on this computer come back with the window. If it stops again where you were, open it from the start.`,
      buttons: ["Try again", "Open from the start", "Quit Tandem"],
      defaultId: 0,
      cancelId: 0,
    });
    if (win.isDestroyed()) return;
    if (response === 2) {
      app.quit();
      return;
    }
    recovery.reset();
    if (response === 1) {
      // A way out when the place itself is what stops the page.
      place.forget();
      loadRenderer(win);
      return;
    }
    // Trying again returns to the same place an automatic reload would.
    place.recover();
    reopen();
  };
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    console.error(`Tandem: the window's page stopped (${details.reason}).`);
    void recover("The window stopped unexpectedly.", false);
  });
  win.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (!isRendererLoadFailure(code, isMainFrame)) return;
    console.error(`Tandem: the window could not load (${description}).`);
    void recover(`The window could not load (${description}).`, true);
  });

  loadRenderer(win);
}

/** Loads the app's own page into the window: the dev server's, or the built one. */
function loadRenderer(win: BrowserWindow): void {
  rendererReady = false;
  // A failure is reported through did-fail-load, which decides what to do.
  const loading = isDev
    ? win.loadURL(process.env.ELECTRON_RENDERER_URL!)
    : win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  loading.catch(() => {});
}

void app.whenReady().then(async () => {
  if (!primaryInstance) return;
  // The installer gates ask which profile this process uses (F05).
  const gateReport = appEnv("RELEASE_GATE_REPORT");
  if (gateReport)
    void writeGateReport(
      gateReport,
      { userData: app.getPath("userData"), version: app.getVersion() },
      async () => {
        await settings.get("releaseGate", { strict: true });
        return true;
      },
    ).catch(() => {});
  // Unreadable settings mean no saved address, not a failed launch. The
  // environment can still supply one, and Manage hosting can save a new one.
  const stored = await settings.get("publicAddress").catch(() => null);
  savedPublicAddress = typeof stored === "string" && stored.trim() ? stored.trim() : null;
  publicAddressLookup = null;
  const initial = deepLinkFromArgv(process.argv);
  if (initial && !pendingDeepLink) pendingDeepLink = initial;
  createTray();
  followNetworkChanges();
  // A scheduled backup that failed before the app last quit is said in the
  // tray from the start, not only once the window lists the workspaces.
  void hosting.list().then(updateTray, () => {});
  // Scheduled backups: once the app has settled, then every quarter hour.
  setTimeout(() => void hosting.runDueBackups(), 60_000).unref();
  setInterval(() => void hosting.runDueBackups(), 15 * 60_000).unref();
  // Opened by the OS at sign-in, with a workspace hosting and a tray to reach
  // it by, Tandem stays out of the way, unless part of what it was asked
  // to do at sign-in did not happen: hosting on this network while the public
  // address failed to reopen is a failure nobody would otherwise see. Without
  // a sign-in the window opens, and hosting starts meanwhile: it enters
  // "starting" long before the window asks.
  const loginSettings = loginItemAvailable && !isTest ? app.getLoginItemSettings() : {};
  if (openedAtLogin(process.platform, process.argv, loginSettings)) {
    const hosted = await hosting.startForLaunch().catch(() => null);
    if (!hosted?.running || !tray || hosting.status().launchError) createWindow();
  } else {
    void hosting.startForLaunch().catch(() => {});
    createWindow();
  }
  startDiscovery();
  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS keeps an app with no windows running either way; the dock reopens it.
  if (process.platform === "darwin") return;
  if (hosting.status().phase === "stopped") app.quit();
  // A server with nothing on screen and no tray to reach it by would be invisible.
  else if (!quitting && !tray) showMainWindow();
});

app.on("before-quit", (event) => {
  if (quitReady || !primaryInstance) return;
  event.preventDefault();
  quitTandem(false);
});

/**
 * Stops hosting, saves local work and quits. `stopConfirmed` skips asking
 * first, for a choice that already said it stops hosting.
 */
function quitTandem(stopConfirmed: boolean): void {
  if (quitTask || trayStopPending) return;
  quitting = true;
  updateTray();
  quitTask = (async () => {
    if (!stopConfirmed && hosting.status().phase !== "stopped" && !(await confirmStopAndQuit())) {
      quitting = false;
      updateTray();
      return;
    }
    if (!(await prepareLocalWrites(mainWindow, true))) {
      quitting = false;
      updateTray();
      return;
    }
    await hosting.shutdown();
    quitReady = true;
    tray?.destroy();
    tray = null;
    bonjour.destroy();
    app.quit();
  })()
    .catch(async () => {
      const choice = await dialog.showMessageBox({
        type: "error",
        title: "The workspace could not finish stopping",
        message: "Keep Tandem open, or quit without waiting for the remaining work?",
        detail:
          "Shutdown failed. Quitting anyway ends the process immediately and may lose unfinished changes. Existing workspace data is not deleted.",
        buttons: ["Keep open", "Quit anyway"],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice.response === 1) {
        tray?.destroy();
        // Only the user's explicit response to a failed shutdown may bypass draining.
        app.exit(1);
      } else {
        quitting = false;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setEnabled(true);
        showMainWindow();
        updateTray();
      }
    })
    .finally(() => {
      quitTask = null;
      if (!quitReady && quitting) {
        quitting = false;
        showMainWindow();
        updateTray();
      }
      if (!quitReady && mainWindow && !mainWindow.isDestroyed()) mainWindow.setEnabled(true);
    });
  void quitTask.catch(() => {});
}
