import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
  MessageChannelMain,
  nativeImage,
  nativeTheme,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  Tray,
} from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Bonjour, type Service } from "bonjour-service";
import {
  DEEP_LINK_PROTOCOL,
  MDNS_SERVICE_TYPE,
  isIconVersion,
  isLinkableAddress,
  type DiscoveryTxt,
} from "@ownbase/protocol";
import {
  TITLE_BAR_HEIGHT,
  type DesktopCapabilities,
  type DiscoveredServer,
} from "@ownbase/protocol/desktop";
import type { OutboxChanges } from "@ownbase/client-core/outbox";
import type { DraftChanges } from "@ownbase/client-core/drafts";
import { applyRecordChanges, isRecordChanges } from "@ownbase/client-core/records";
import { addTrustedAddress } from "@ownbase/client-core/trustedAddresses";
import {
  CHANNELS,
  capabilitiesArgument,
  type EventName,
  type Events,
  type WindowTheme,
} from "../shared/bridge.js";
import createBackupWorker from "./backupWorker?nodeWorker";
import type { BackupJob, BackupReply } from "./backupWorker.js";
import { createSettingsStorage, ownSettings as movedOut } from "./settings.js";
import type { CredentialProtector } from "./credentials.js";
import { ClosePreparation } from "./closePreparation.js";
import {
  answering,
  appRecipients,
  rendererUrlTrust,
  settingKey,
  ticketDownloadUrl,
  type Handlers,
} from "./ipcBoundary.js";
import { writeGateReport } from "./releaseGate.js";
import {
  PlaceCheckpoint,
  RENDERER_RECOVERY,
  RendererRecovery,
  isRendererLoadFailure,
} from "./rendererRecovery.js";
import {
  ScreenChoice,
  SourceList,
  THUMBNAIL_SIZE,
  findSource,
  screenSoundSupported,
} from "./screenShare.js";
import { SystemMicrophones, isEndpointId } from "./microphone.js";
import { mergeOutboxSetting } from "./outboxStorage.js";
import { mergeDraftsSetting } from "./draftsStorage.js";
import { HOSTING_KEYS, createHostingService, type LoginItem } from "./hostingService.js";
import { backupTrayItems } from "./trayBackups.js";
import { loginItemOptions, loginItemProblem, openedAtLogin } from "./loginItem.js";
import { isWindowTheme, themeOfAppearance, windowColours } from "./windowTheme.js";
import { MIN_WINDOW_SIZE, WINDOW_PLACE_KEY, placeToOpen, placeToSave } from "./windowPlace.js";
import { ZOOM_KEY, nextZoomLevel, savedZoomLevel, zoomStep } from "./zoomKeys.js";
import { contextMenuItems } from "./contextMenu.js";
import { appMenuTemplate } from "./appMenu.js";
import { readerLocale, systemHourCycle } from "./regionalFormat.js";

const isDev = !!process.env.ELECTRON_RENDERER_URL;
const appEnv = (name: string): string | undefined => process.env[`OWNBASE_${name}`];
const isTest = appEnv("TEST") === "1";
app.setName("OwnBase");
// Settings, credentials and hosted databases live in %APPDATA%\OwnBase (and
// the same under ~/Library/Application Support and ~/.config).
app.setPath("userData", appEnv("USER_DATA_DIR") ?? join(app.getPath("appData"), "OwnBase"));
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** The app's own page, as the main window loads it. */
const rendererUrl = isDev
  ? process.env.ELECTRON_RENDERER_URL!
  : pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).href;
const trustedRenderer = rendererUrlTrust(rendererUrl);
/**
 * Tells the app's window something, and no other window (F09): what is
 * pushed here includes invite links and hosting.
 */
function push<E extends EventName>(event: E, payload: Events[E]): void {
  for (const win of appRecipients(mainWindow, trustedRenderer))
    win.webContents.send(event, payload);
}
let rendererReady = false;
let quitting = false;
let quitReady = false;
let quitTask: Promise<void> | null = null;

/** The browser's fake microphone and camera stand in for real ones, for tests. */
const fakeMedia = (isDev || isTest) && appEnv("TEST_MEDIA") === "1";
if (fakeMedia) {
  app.commandLine.appendSwitch("remote-debugging-port", "9222");
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

// ---------- ownbase:// deep links ----------

/** Held until a window exists to receive it (cold start via a link). */
let pendingDeepLink: string | null = null;

function deliverDeepLink(url: string): void {
  pendingDeepLink = url;
  const win = showMainWindow();
  if (win && rendererReady && appRecipients(win, trustedRenderer).length > 0) {
    pendingDeepLink = null;
    push("deeplink", url);
  }
}

function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((a) => a.startsWith(`${DEEP_LINK_PROTOCOL}://`)) ?? null;
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
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [
    join(import.meta.dirname, "../.."),
  ]);
} else if (!isTest) {
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
}

/** Where the page is, kept here so a recovery can put it back (F08). */
let place = new PlaceCheckpoint(trustedRenderer);

// ---------- the huddle's screen picker ----------

// The picker is the app's own: it lists every screen and window with a
// picture of each, then names the one chosen, which the getDisplayMedia
// request after it shares.
const screenSources = new SourceList((pictures) =>
  desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: pictures ? THUMBNAIL_SIZE : { width: 0, height: 0 },
    fetchWindowIcons: pictures,
  }),
);
const screenChoice = new ScreenChoice();
const screenSound = screenSoundSupported(process.platform, process.getSystemVersion());

// ---------- microphones opened as other apps open them (Windows) ----------

// Chromium opens a microphone raw where it can, which leaves out the sound
// effects set up in Windows; the page asks for one opened the ordinary way
// when it wants none of the browser's own processing (see microphone.ts).
// Not where fake devices stand in for real ones, nor with
// OWNBASE_SYSTEM_MICROPHONE=0, which leaves every microphone to the browser.
const microphoneHelper = (() => {
  if (process.platform !== "win32" || fakeMedia || appEnv("SYSTEM_MICROPHONE") === "0") return null;
  const path = app.isPackaged
    ? join(process.resourcesPath, "native", "ownbase-microphone.exe")
    : join(import.meta.dirname, "../../native/bin/ownbase-microphone.exe");
  return existsSync(path) ? path : null;
})();
const microphones = new SystemMicrophones(microphoneHelper);

// ---------- settings and OS-protected saved sign-ins ----------

const credentialProtector: CredentialProtector = {
  isAvailable: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" ||
      !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())),
  encryptString: (value) => safeStorage.encryptString(value),
  decryptString: (value) => safeStorage.decryptString(value),
};
/** What the window keeps, under whatever names it chooses. */
const settings = createSettingsStorage(
  join(app.getPath("userData"), "settings.json"),
  credentialProtector,
);
/** What the main process keeps for itself, out of the window's reach. */
const ownSettings = movedOut(
  createSettingsStorage(join(app.getPath("userData"), "app-settings.json"), credentialProtector),
  settings,
  [...HOSTING_KEYS, WINDOW_PLACE_KEY, ZOOM_KEY],
);
const closePreparation = new ClosePreparation();

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
        title: "Some of your writing is not saved",
        message: "Keep OwnBase open so you can copy what you wrote?",
        detail:
          "OwnBase could not save some drafts or messages waiting to send. Retry saving, or keep the window open and copy your words. If you leave without saving, that writing may be lost.",
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

// ---------- the window's own colours ----------

/** The theme the window's frame was last told, kept for the next start's first frame. */
const WINDOW_THEME_KEY = "windowTheme";
let windowTheme: WindowTheme = "system";
/** The window's last size and place (windowPlace.ts), read at startup and kept as it moves. */
let savedWindowPlace: unknown = null;
/** Saves the open window's place now rather than after its pause; null without a window. */
let saveWindowPlaceNow: (() => void) | null = null;
/** The page's zoom level (zoomKeys.ts), read at startup and kept as the keys change it. */
let savedZoom = 0;
/** The locale the page writes dates and times in (regionalFormat.ts), worked out at startup. */
let pageLocale: string | null = null;

/** A setting the main process keeps for the window itself; a failure costs only that setting. */
function keepWindowSetting(key: string, value: unknown): void {
  void ownSettings.set(key, value).catch((error: unknown) => {
    console.error(`OwnBase: could not save ${key}.`, error);
  });
}

/**
 * The window's background and title bar overlay in the page's theme: when the
 * theme is chosen, and, for the system's choice, when the system changes.
 */
function paintWindow(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const colours = windowColours(windowTheme, nativeTheme.shouldUseDarkColors);
  win.setBackgroundColor(colours.background);
  // Only Windows and Linux draw the window buttons on an overlay.
  if (process.platform !== "darwin")
    win.setTitleBarOverlay({
      color: colours.background,
      symbolColor: colours.symbols,
      height: TITLE_BAR_HEIGHT,
    });
}
nativeTheme.on("updated", paintWindow);

// ---------- LAN discovery (mDNS browse) ----------

const bonjour = new Bonjour();
const discovered = new Map<string, Service>();

/** What the Join screen lists: each advertisement at an address a link can reach. */
function discoveredServers(): DiscoveredServer[] {
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
    push("lan:servers", discoveredServers());
  };
  browser.on("up", seen);
  // A workspace announcing again under the same name, as when its icon
  // changes, is the same service with a new record, not a new one.
  browser.on("txt-update", seen);
  browser.on("srv-update", seen);
  browser.on("down", (service) => {
    discovered.delete(service.fqdn);
    push("lan:servers", discoveredServers());
  });
}

// ---------- hosting ----------

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
      reject(new Error(`The backup stopped before it finished. Try again. Exit code ${code}.`));
    });
  });
}

/**
 * The OS opens only an installed app at sign-in: a copy run from source would
 * register Electron itself. Linux has no single place for it that Electron
 * manages, so it is offered on Windows and macOS. Tests must never register
 * the real app with the OS, so they get a stand-in.
 */
const loginItem: LoginItem | null = (() => {
  if (!app.isPackaged || (process.platform !== "win32" && process.platform !== "darwin"))
    return null;
  if (isTest) {
    let open = false;
    return { get: () => open, set: (next) => void (open = next) };
  }
  const options = loginItemOptions(process.platform);
  return {
    get: () => app.getLoginItemSettings(options).openAtLogin,
    set: (open) => {
      app.setLoginItemSettings({ openAtLogin: open, ...options });
      const problem = loginItemProblem(process.platform, open, app.getLoginItemSettings(options));
      if (problem) throw new Error(problem);
    },
  };
})();

const hosting = createHostingService({
  settings: ownSettings,
  credentials: credentialProtector,
  dataRoot: join(app.getPath("userData"), "hosted"),
  cloudflaredFolder: join(app.getPath("userData"), "cloudflared"),
  webDistPath: app.isPackaged
    ? join(process.resourcesPath, "web")
    : join(import.meta.dirname, "../../../web/dist"),
  inWorker,
  freeBytes: async (dir) => {
    const info = await statfs(dir);
    return info.bavail * info.bsize;
  },
  openPath: (path) => shell.openPath(path),
  chooseFolder: async ({ title, buttonLabel, create }) => {
    const options = {
      title,
      buttonLabel,
      properties: (create ? ["openDirectory", "createDirectory"] : ["openDirectory"]) as (
        "openDirectory" | "createDirectory"
      )[],
    };
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const choice = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return choice.canceled ? null : (choice.filePaths[0] ?? null);
  },
  backgroundAvailable: () => !!tray && !tray.isDestroyed(),
  loginItem,
  onChange: () => {
    push("hosting:changed", hosting.status());
    updateTray();
  },
});

/** What this copy of the app can do, handed to the window as it is made. */
const capabilities: Omit<DesktopCapabilities, "readerLocale"> = {
  screenSound,
  systemMicrophone: microphoneHelper !== null,
  openAtLogin: loginItem !== null,
};

// ---------- every call the window makes ----------

const handlers: Handlers<IpcMainInvokeEvent> = {
  "file:download": (_event, value) => {
    if (!mainWindow) throw new Error("Invalid download request");
    mainWindow.webContents.downloadURL(ticketDownloadUrl(value));
  },
  "storage:get": (_event, key, options) =>
    settings.get(settingKey(key), {
      strict: (options as { strict?: unknown } | undefined)?.strict === true,
    }),
  "storage:set": (_event, key, value) => settings.set(settingKey(key), value),
  // Stores a value only where none is, in the settings queue every write
  // shares, so a window that read nothing cannot replace another's (GL-01).
  "storage:initialize": (_event, key, value) =>
    settings.update(settingKey(key), (current) =>
      current === null || current === undefined ? value : current,
    ),
  // An approved address joins the trusted ones in the same queue, so two
  // approvals at once both keep theirs (Q02).
  "storage:trustAddress": async (_event, key, address) => {
    if (typeof address !== "string") throw new Error("Invalid workspace address.");
    let addresses: string[] | null = null;
    await settings.update(settingKey(key), (current) => {
      const change = addTrustedAddress(current, address);
      addresses = change.addresses;
      return change.value;
    });
    return addresses;
  },
  "storage:mergeOutbox": async (_event, key, changes, enveloped) =>
    (
      await mergeOutboxSetting(
        settings,
        settingKey(key),
        changes as OutboxChanges,
        enveloped === true,
      )
    ).outbox,
  "storage:mergeDrafts": async (_event, key, changes, enveloped) =>
    (
      await mergeDraftsSetting(
        settings,
        settingKey(key),
        changes as DraftChanges,
        enveloped === true,
      )
    ).drafts,
  // Each changed name only, such as one account's notification choice, so no
  // whole copy erases another's (F02).
  "storage:mergeRecord": async (_event, key, changes) => {
    if (!isRecordChanges(changes)) throw new Error("Invalid record changes.");
    let value: Record<string, string> = {};
    await settings.update(
      settingKey(key),
      (current) => (value = applyRecordChanges(current, changes)),
    );
    return value;
  },
  "lan:snapshot": () => discoveredServers(),
  "deeplink:consume": () => {
    rendererReady = true;
    const url = pendingDeepLink;
    pendingDeepLink = null;
    return url;
  },
  // A notification clicked while the window is minimized, or closed to the
  // tray while hosting, brings the window back as well as opening its message.
  "window:reveal": () => {
    showMainWindow();
  },
  "window:rememberPlace": (_event, url, state) => {
    place.remember(url, state);
  },
  "window:takePlace": () => place.take(),
  "window:preparedClose": (event, id, saved) => {
    closePreparation.acknowledge(event.sender.id, id, saved);
  },
  "window:setTheme": async (_event, theme) => {
    if (!isWindowTheme(theme)) throw new Error("Not a theme.");
    windowTheme = theme;
    paintWindow();
    await ownSettings.set(WINDOW_THEME_KEY, theme);
  },
  "screen:sources": (_event, options) =>
    (options as { quick?: unknown } | undefined)?.quick === true
      ? screenSources.quick()
      : screenSources.full(),
  "screen:choose": async (_event, id, options) => {
    screenChoice.hold(
      await findSource(id, () =>
        desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 0, height: 0 },
        }),
      ),
      (options as { sound?: unknown } | undefined)?.sound === true && screenSound,
    );
  },
  "microphone:list": () => microphones.list(),
  "microphone:open": async (event, id) => {
    if (!isEndpointId(id)) throw new Error("Not a microphone.");
    const { port1, port2 } = new MessageChannelMain();
    const opened = await microphones.open(event.sender.id, id, port1);
    // The page's end of the samples, which it hands to its audio worklet.
    event.sender.postMessage("microphone:port", { session: opened.session }, [port2]);
    return opened;
  },
  "microphone:close": (event, session) => {
    if (typeof session === "number") microphones.close(event.sender.id, session);
  },
  ...hosting.handlers,
};

// Every request comes from the app's own window, its top frame, showing the
// app's page; anything else is refused before its work starts (REV-14).
for (const channel of CHANNELS)
  ipcMain.handle(
    channel,
    answering(
      () => mainWindow,
      trustedRenderer,
      handlers[channel] as Handlers<IpcMainInvokeEvent>[typeof channel],
    ),
  );

// ---------- the tray, and quitting ----------

function showMainWindow(): BrowserWindow | null {
  if (!app.isReady() || quitting) return null;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const win = mainWindow!;
  if (win.isMinimized()) win.restore();
  if (!isTest) win.show();
  win.focus();
  return win;
}

/** While quitting, the tray offers nothing and hosting starts no new work. */
function setQuitting(on: boolean): void {
  quitting = on;
  hosting.setQuitting(on);
}

async function confirmStopAndQuit(): Promise<boolean> {
  const choice = await dialog.showMessageBox({
    type: "question",
    title: "Stop hosting and quit?",
    message: "Quit OwnBase and stop the hosted workspace?",
    detail:
      "Teammates lose their connection until you start hosting again. Messages and files stay on this computer.",
    buttons: ["Cancel", "Stop hosting and quit"],
    defaultId: 0,
    cancelId: 0,
  });
  return choice.response === 1;
}

// The tray's label already says hosting stops, so it does not ask first.
async function stopFromTray(): Promise<void> {
  try {
    await hosting.stopFromTray();
  } catch {
    showMainWindow();
    await dialog.showMessageBox({
      type: "error",
      message: "OwnBase could not stop the workspace. Open Manage hosting and try again.",
    });
  }
}

function updateTray(): void {
  if (!tray || tray.isDestroyed()) return;
  const status = hosting.status();
  const trayStopping = hosting.stoppingFromTray();
  const label =
    status.phase === "starting"
      ? "Starting workspace…"
      : status.phase === "stopping"
        ? "Stopping workspace…"
        : status.running
          ? `Hosting ${status.workspaceName} · ${status.openToAll?.phase === "open" ? "public link open" : `port ${status.port}`}${
              status.connected !== undefined ? ` · ${status.connected} connected` : ""
            }`
          : "Not hosting";
  // Hosting can be running while part of starting with OwnBase failed, or
  // a scheduled backup keep failing; the tray is often all there is to see at
  // sign-in, so it says so too.
  const backups = backupTrayItems(hosting.backupAttention());
  const attention = status.launchError || backups.length ? " · needs attention" : "";
  tray.setToolTip(`OwnBase · ${label}${attention}`.slice(0, 127));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open OwnBase",
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
                  ? "See why the public link did not reopen…"
                  : "See why the workspace did not start…",
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
        enabled: status.phase === "running" && !quitting && !trayStopping,
        click: () => {
          void stopFromTray().catch(() => {});
        },
      },
      { type: "separator" },
      {
        label: status.phase === "stopped" ? "Quit OwnBase" : "Stop hosting and quit",
        enabled: !quitting && !trayStopping,
        // The label already says hosting stops, so it does not ask again.
        click: () => quitOwnBase(true),
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
  // The deep and ink-dim colours of the page's theme (see windowTheme.ts): the
  // window shows this before the page paints, and the overlay sits on the
  // window's own surface, above the sidebar and the conversation card.
  const colours = windowColours(windowTheme, nativeTheme.shouldUseDarkColors);
  // Where it was last, if that is still on a screen (windowPlace.ts).
  const primary = screen.getPrimaryDisplay();
  const opening = placeToOpen(savedWindowPlace, [
    primary.workArea,
    ...screen
      .getAllDisplays()
      .filter((display) => display.id !== primary.id)
      .map((display) => display.workArea),
  ]);
  mainWindow = new BrowserWindow({
    // A window that opens maximized is shown once it is, not first at its smaller size.
    show: !isTest && !opening.maximized,
    ...opening.bounds,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    backgroundColor: colours.background,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: colours.background,
      symbolColor: colours.symbols,
      height: TITLE_BAR_HEIGHT,
    },
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [capabilitiesArgument({ ...capabilities, readerLocale: pageLocale })],
    },
  });

  mainWindow.setMenuBarVisibility(false);
  const win = mainWindow;
  if (opening.maximized) {
    win.maximize();
    if (!isTest) win.show();
  }
  // Its size and place are kept as they change, once it has rested a moment,
  // and when it closes, so the next launch opens it where it was.
  let placeTimer: ReturnType<typeof setTimeout> | null = null;
  const savePlace = () => {
    if (placeTimer) clearTimeout(placeTimer);
    placeTimer = null;
    // Full screen is a passing state, and minimized keeps its last place.
    if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
    savedWindowPlace = placeToSave(win.getNormalBounds(), win.isMaximized());
    keepWindowSetting(WINDOW_PLACE_KEY, savedWindowPlace);
  };
  const savePlaceSoon = () => {
    if (placeTimer) clearTimeout(placeTimer);
    placeTimer = setTimeout(savePlace, 500);
  };
  for (const change of ["resize", "move", "maximize", "unmaximize"] as const)
    win.on(change as "resize", savePlaceSoon);
  saveWindowPlaceNow = savePlace;
  let closeAllowed = false;
  let windowCloseTask: Promise<void> | null = null;
  rendererReady = false;
  // A page that goes lets go of the microphones it opened.
  const contentsId = win.webContents.id;
  win.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      rendererReady = false;
      microphones.closeOwner(contentsId);
    }
  });
  win.webContents.on("render-process-gone", () => microphones.closeOwner(contentsId));
  win.on("close", (event) => {
    if (placeTimer) savePlace();
    if (quitReady || closeAllowed) return;
    if (quitting || hosting.status().phase !== "stopped") {
      event.preventDefault();
      if (tray && !tray.isDestroyed()) win.hide();
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
    if (placeTimer) clearTimeout(placeTimer);
    if (saveWindowPlaceNow === savePlace) saveWindowPlaceNow = null;
    microphones.closeOwner(contentsId);
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
  // Its sound goes only when the page asked for it and the picker allowed it.
  mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    const chosen =
      request.frame && trustedRenderer(request.frame.url)
        ? screenChoice.take(request.audioRequested)
        : null;
    callback(chosen ?? {});
  });
  mainWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  // Ctrl and =, - or 0 zoom as in a browser (zoomKeys.ts), and the zoom is
  // kept for the next launch.
  win.webContents.on("before-input-event", (event, input) => {
    const step = zoomStep(input, process.platform);
    if (!step) return;
    event.preventDefault();
    savedZoom = nextZoomLevel(win.webContents.getZoomLevel(), step);
    win.webContents.setZoomLevel(savedZoom);
    keepWindowSetting(ZOOM_KEY, savedZoom);
  });
  win.webContents.on("did-finish-load", () => {
    if (!win.isDestroyed()) win.webContents.setZoomLevel(savedZoom);
  });

  // A right-click menu as in a browser: spelling, links, pictures, editing (contextMenu.ts).
  win.webContents.on("context-menu", (_event, params) => {
    const items = contextMenuItems(params, {
      replaceMisspelling: (word) => win.webContents.replaceMisspelling(word),
      addToDictionary: (word) => {
        win.webContents.session.addWordToSpellCheckerDictionary(word);
      },
      openLink: (url) => void shell.openExternal(url),
      copyText: (text) => clipboard.writeText(text),
      copyImageAt: (x, y) => win.webContents.copyImageAt(x, y),
    });
    if (items.length && !win.isDestroyed()) Menu.buildFromTemplate(items).popup({ window: win });
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
      title: "OwnBase",
      message: "OwnBase's window stopped working several times.",
      detail: `${what} A workspace you host keeps running, and messages saved on this computer come back with the window. If it stops again at the same place, choose Open from the start.`,
      buttons: ["Try again", "Open from the start", "Quit OwnBase"],
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
    console.error(`OwnBase: the window's page stopped (${details.reason}).`);
    void recover("The window crashed.", false);
  });
  win.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (!isRendererLoadFailure(code, isMainFrame)) return;
    console.error(`OwnBase: the window could not load (${description}).`);
    void recover(`The window could not load (${description}).`, true);
  });

  loadRenderer(win);
}

/** Loads the app's own page into the window: the dev server's, or the built one. */
function loadRenderer(win: BrowserWindow): void {
  rendererReady = false;
  // A failure is reported through did-fail-load, which decides what to do.
  win.loadURL(rendererUrl).catch(() => {});
}

void app.whenReady().then(async () => {
  if (!primaryInstance) return;
  // Asked of the system while the settings are read: whether it writes times
  // on the 24-hour clock, which Chromium does not follow.
  const hourCycle = systemHourCycle(
    process.platform,
    (command, args) =>
      new Promise((resolve, reject) =>
        execFile(command, args, { timeout: 3_000, windowsHide: true }, (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        ),
      ),
  );
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
  await hosting.load();
  // Unreadable, the window follows the system until the page says its theme.
  const saved = await ownSettings.get(WINDOW_THEME_KEY).catch(() => null);
  windowTheme = isWindowTheme(saved)
    ? saved
    : themeOfAppearance(await settings.get("appearance").catch(() => null));
  // Unreadable, the window opens at its usual size, centred.
  savedWindowPlace = await ownSettings.get(WINDOW_PLACE_KEY).catch(() => null);
  savedZoom = savedZoomLevel(await ownSettings.get(ZOOM_KEY).catch(() => null));
  pageLocale = readerLocale({
    appLocale: app.getLocale(),
    systemLocale: app.getSystemLocale(),
    hourCycle: await hourCycle,
  });
  // No Ctrl+W, Ctrl+R or developer tools in the installed app (appMenu.ts).
  if (app.isPackaged)
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(process.platform)));
  const initial = deepLinkFromArgv(process.argv);
  if (initial && !pendingDeepLink) pendingDeepLink = initial;
  createTray();
  hosting.followNetworkChanges((listener) => powerMonitor.on("resume", listener));
  // A scheduled backup that failed before the app last quit is said in the
  // tray from the start, not only once the window lists the workspaces.
  void hosting.list().then(updateTray, () => {});
  // Scheduled backups: once the app has settled, then every quarter hour.
  setTimeout(() => void hosting.runDueBackups(), 60_000).unref();
  setInterval(() => void hosting.runDueBackups(), 15 * 60_000).unref();
  // Opened by the OS at sign-in, with a workspace hosting and a tray to reach
  // it by, OwnBase stays out of the way, unless part of what it was asked
  // to do at sign-in did not happen: hosting on this network while the public
  // address failed to reopen is a failure nobody would otherwise see. Without
  // a sign-in the window opens, and hosting starts meanwhile: it enters
  // "starting" long before the window asks.
  const loginSettings = loginItem && !isTest ? app.getLoginItemSettings() : {};
  if (openedAtLogin(process.platform, process.argv, loginSettings)) {
    await hosting.startForLaunch().catch(() => {});
    const hosted = hosting.status();
    if (!hosted.running || !tray || hosted.launchError) createWindow();
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

app.on("will-quit", () => {
  microphones.closeAll();
  hosting.cancelInstall();
});

app.on("before-quit", (event) => {
  if (quitReady || !primaryInstance) return;
  event.preventDefault();
  quitOwnBase(false);
});

/**
 * Stops hosting, saves local work and quits. `stopConfirmed` skips asking
 * first, for a choice that already said it stops hosting.
 */
function quitOwnBase(stopConfirmed: boolean): void {
  if (quitTask || hosting.stoppingFromTray()) return;
  setQuitting(true);
  updateTray();
  quitTask = (async () => {
    if (!stopConfirmed && hosting.status().phase !== "stopped" && !(await confirmStopAndQuit())) {
      setQuitting(false);
      updateTray();
      return;
    }
    // Kept before the settings are saved for the last time.
    saveWindowPlaceNow?.();
    if (!(await prepareLocalWrites(mainWindow, true))) {
      setQuitting(false);
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
        message: "Keep OwnBase open, or quit without waiting for the remaining work?",
        detail:
          "If you quit anyway, OwnBase closes at once and may lose changes it has not saved yet. Nothing already saved in the workspace is deleted.",
        buttons: ["Keep open", "Quit anyway"],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice.response === 1) {
        tray?.destroy();
        // Only the user's explicit response to a failed shutdown may bypass draining.
        app.exit(1);
      } else {
        setQuitting(false);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setEnabled(true);
        showMainWindow();
        updateTray();
      }
    })
    .finally(() => {
      quitTask = null;
      if (!quitReady && quitting) {
        setQuitting(false);
        showMainWindow();
        updateTray();
      }
      if (!quitReady && mainWindow && !mainWindow.isDestroyed()) mainWindow.setEnabled(true);
    });
  void quitTask.catch(() => {});
}
