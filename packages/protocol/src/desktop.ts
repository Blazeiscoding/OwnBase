/**
 * What the desktop app's main process and the UI it shows say to each other:
 * the data its calls carry and the ways they fail. The UI describes what it
 * needs in its own `Platform`; the desktop app's bridge contract names these
 * same types, so one declaration serves both sides.
 */
import type { AccessPolicy } from "./entities.js";

/** A port a program may listen on, as a person chooses one: a whole number from 1 to 65535. */
export function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export const PORT_RULE = "Choose a port from 1 to 65535.";

/**
 * The height in CSS pixels of the strip at the top of the desktop window: the
 * system's window buttons are drawn over it on Windows and Linux, and the
 * page leaves it empty for dragging the window.
 */
export const TITLE_BAR_HEIGHT = 40;

export function portFromText(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return isPort(port) ? port : null;
}

/**
 * Why a desktop call failed. `failed` comes with a message the main process
 * wrote for the person reading it; the others name a case the UI says in its
 * own words or acts on.
 */
export type DesktopErrorCode =
  | "failed"
  /** The request did not come from the app's own window. */
  | "refused"
  /** The bridge itself broke: nothing the main process chose to say. */
  | "internal"
  /**
   * The list of hosted workspaces cannot be read as it is: saved by a newer
   * version, or damaged. The message says which, and what to do.
   */
  | "registry-unreadable"
  /** A public link waits for the workspace's owner account. */
  | "owner-account-missing"
  /** A call relay was refused for one of its fields, which the window marks. */
  | "relay-key-id"
  | "relay-api-token"
  | "relay-urls"
  | "relay-username"
  | "relay-credential";

/** A failed desktop call, as it crosses from the main process to the window. */
export interface DesktopFailure {
  code: DesktopErrorCode;
  message: string;
}

/** What this copy of the desktop app can do, decided once by its main process. */
export interface DesktopCapabilities {
  /**
   * The locale to write dates and times in: the system's regional format,
   * where it differs from the language Chromium was started in. Null when
   * the page's own is right.
   */
  readerLocale: string | null;
  /** A shared screen can carry its sound, with the app's own left out. */
  screenSound: boolean;
  /** Microphones can be opened the way other apps on this computer open them. */
  systemMicrophone: boolean;
  /** The OS can be asked to open OwnBase at sign-in. */
  openAtLogin: boolean;
  /** How this copy gets new versions; see `UpdateMode`. */
  updates: UpdateMode;
}

export type HostingPhase = "stopped" | "starting" | "running" | "stopping";

/** How cloudflared would be installed while it is missing, and how far an install has got. */
export interface CloudflaredInstall {
  via: "winget" | "homebrew" | "download";
  installing?: boolean;
  /** Bytes downloaded so far, and of how many, once a download has started. */
  received?: number;
  total?: number;
}

/** Everything the window shows about hosting on this computer. */
export interface HostingStatus {
  running: boolean;
  phase: HostingPhase;
  workspaceName?: string;
  /** The running workspace's entry in the list of hosted workspaces. */
  folder?: string;
  port?: number;
  /** The running server's instance id, new on every start and also in its network announcement. */
  instanceId?: string;
  dataDir?: string;
  lanUrls?: string[];
  warning?: string;
  /** Closing the window can keep hosting through the system tray. */
  backgroundAvailable: boolean;
  /** A public address, while Cloudflare Tunnel is opening or open. */
  openToAll?: { phase: "opening" } | { phase: "open"; url: string };
  /** Why the last attempt to open the public address failed or ended. */
  openToAllError?: string;
  /** Whether this computer has what a public link needs. */
  tunnelAvailable?: boolean;
  /** While cloudflared is missing or installing, how it is or would be installed. */
  cloudflaredInstall?: CloudflaredInstall;
  /** A configured address that stays the same each time the link is opened. */
  publicAddress?: string;
  /** What the public address setting holds, valid or not, for editing. */
  publicAddressSetting?: string;
  /** The environment set the address, so this app cannot change it. */
  publicAddressLocked?: boolean;
  /** OwnBase runs the connector for it, rather than something else. */
  publicAddressManaged?: boolean;
  /** Why a configured stable address cannot be used, and what to correct. */
  publicAddressError?: string;
  /** Who may join the running workspace. */
  accessPolicy?: AccessPolicy;
  /** The running workspace is the one chosen to start when OwnBase opens. */
  startsOnLaunch?: boolean;
  /**
   * What did not happen when OwnBase opened: the workspace chosen to start
   * with it did not start, or started without reopening its stable address.
   * Kept until that part recovers or the host dismisses it.
   */
  launchError?: string;
  launchErrorPart?: "hosting" | "public-address";
  /** The folder of the workspace `launchError` is about, when it is about one. */
  launchErrorFolder?: string;
  /** How many people are connected to the running workspace now. */
  connected?: number;
  /**
   * A restored copy started only to look inside: nothing queued is sent, no
   * app is called, and only this computer can reach it.
   */
  isolated?: boolean;
  /** The running workspace reopens its stable public address when it starts with OwnBase. */
  reopensPublicOnLaunch?: boolean;
  /** The running workspace's icon version, or null when it has none. */
  iconVersion?: string | null;
}

/**
 * What starts hosting: `folder` for a workspace already hosted on this
 * computer, or `workspaceName` for a new one. A name never finds an old one.
 */
export type HostingStart = ({ folder: string } | { workspaceName: string }) & {
  port?: number;
  /** Puts a restored workspace back in use, rather than starting it only to look inside. */
  activate?: boolean;
};

/** The workspace a start left running. */
export interface StartedWorkspace {
  folder: string;
  workspaceName: string;
  port: number;
}

/** What someone can do about a scheduled backup that did not finish. */
export type BackupFailureKind =
  /** Its folder cannot be reached: a drive or share not connected, or removed. */
  | "destination"
  /** There is not enough room there. */
  | "space"
  /** The workspace's own folder is missing or holds another workspace. */
  | "source"
  /** The backup was made, but older ones there could not be removed. */
  | "cleanup"
  | "other";

/** A workspace backed up by itself: where, how often, and how many are kept. */
export interface AutoBackup {
  destination: string;
  everyDays: 1 | 7;
  keep: number;
  /** When this schedule last made a backup into its folder, if it has. */
  lastAt?: number;
  /** Why its last try did not finish, until one does. */
  failure?: { kind: BackupFailureKind };
}

/** One workspace hosted on this computer, as the window lists it. */
export interface HostedWorkspace {
  folder: string;
  name: string;
  port: number;
  lastHostedAt: number;
  /** When a backup of it last finished, or null if none has on this computer. */
  lastBackupAt: number | null;
  running: boolean;
  /** Its folder is gone, so it cannot start. */
  missing: boolean;
  /** Chosen to start when OwnBase opens. */
  startsOnLaunch: boolean;
  autoBackup: AutoBackup | null;
  /** Why its last scheduled backup did not finish, until one does. */
  autoBackupError: string | null;
  /** Restored from a backup and not yet put back in use. */
  restored: boolean;
  /** Its icon's version, read from its own database whether it runs or not, or null when it has none. */
  iconVersion: string | null;
}

/** Every workspace hosted on this computer, most recent first. */
export interface HostedWorkspaces {
  workspaces: HostedWorkspace[];
  /** Folders holding a workspace that could not be read. */
  unreadable: string[];
}

/** The workspace this computer hosted most recently, named as a start names it. */
export type LastHosted = StartedWorkspace;

/** One backup of a hosted workspace in its backup folder. */
export interface HostedBackup {
  /** The backup's folder name, which `restoreOver` takes. */
  name: string;
  /** When it was made, in milliseconds. */
  at: number;
  /** How much it holds, or null when it did not pass the check. */
  bytes: number | null;
  /** It failed the check a restore makes, so it cannot be restored. */
  damaged: boolean;
}

/** What a restored backup sets off once it is put back in use. */
export interface RestoreInventory {
  /** Where its apps are sent events, commands and button clicks. */
  appAddresses: { origin: string; uses: string[] }[];
  /** Messages waiting to be posted, and when the earliest is due. */
  scheduled: { waiting: number; earliestAt: number | null };
  /** App events accepted but not yet delivered. */
  undeliveredEvents: number;
  /** Sign-ins it accepts, including any ended after the backup was taken. */
  sessions: number;
}

/** A backup restored as a workspace hosted here, not started. */
export interface RestoredWorkspace {
  folder: string;
  name: string;
  inventory: RestoreInventory | null;
}

/** An earlier copy restored over a hosted workspace; what it held is kept in `setAside`. */
export interface RestoredOver extends RestoredWorkspace {
  setAside: string | null;
}

/**
 * The TURN relay calls hosted on this computer are given, without its secret.
 * `error` says why it is not working, when something has said so.
 */
export type CallRelaySetting =
  | { kind: "none"; error?: string }
  | { kind: "cloudflare"; keyId: string; error?: string }
  | { kind: "custom"; urls: string[]; username: string; error?: string };

/** A relay to save or test. A secret left out keeps the saved one for the same key or username. */
export type CallRelayDraft =
  | { kind: "none" }
  | { kind: "cloudflare"; keyId: string; apiToken?: string }
  | { kind: "custom"; urls: string[]; username: string; credential?: string };

/** A relay server as a call is given it. */
export interface RelayServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** A screen or window the desktop app can share in a huddle. */
export interface ShareableSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** A picture of it as a data URL, or "" while there is none yet. */
  thumbnail: string;
  /** The icon of the app that owns a window as a data URL, or "" for a screen or an app without one. */
  icon: string;
}

/** A microphone as the system lists it, for the app to open itself. */
export interface SystemMicrophoneDevice {
  id: string;
  name: string;
}

export interface SystemMicrophones {
  defaultId: string | null;
  microphones: SystemMicrophoneDevice[];
}

/** A workspace server found on the local network. */
export interface DiscoveredServer {
  name: string;
  /** An address a link can carry: IPv4, a hostname, or IPv6 without brackets. */
  host: string;
  port: number;
  serverVersion: string;
  instanceId?: string;
  /** The version of its icon; absent when it has none. */
  iconVersion?: string;
}

/**
 * Running a workspace server inside the desktop app: every call the window
 * makes about hosting. The window's platform offers these, and the desktop
 * app's bridge carries each one on the channel `hosting:` followed by its
 * path, such as `hosting:relay:get`. Its status is read once and then
 * followed through the app's pushes; nothing else returns it.
 */
export interface DesktopHosting {
  status: () => Promise<HostingStatus>;
  start: (request: HostingStart) => Promise<StartedWorkspace>;
  stop: () => Promise<void>;
  /** Publishes the running workspace at a public address, and says who may join through it. */
  openToAll: (accessPolicy: AccessPolicy) => Promise<void>;
  endOpenToAll: () => Promise<void>;
  /** Changes who may join while the server is running; turning guests off signs them out. */
  setAccessPolicy: (accessPolicy: AccessPolicy) => Promise<void>;
  /**
   * Saves an address something else already carries to this workspace, or
   * clears it with "" to go back to a temporary one. Rejects what cannot be
   * published, so the setting never holds an address that will not work.
   */
  setPublicAddress: (address: string) => Promise<void>;
  /**
   * Installs cloudflared, which a public link needs, and resolves once it
   * can be used. Rejects, saying why and what to do, when it could not be.
   */
  installCloudflared: () => Promise<void>;
  /**
   * The TURN relay for calls between networks that will not connect
   * directly: the one saved, saving another, and the relay servers a draft
   * gives a call, to check they give a route before anyone needs them.
   */
  relay: {
    get: () => Promise<CallRelaySetting>;
    set: (draft: CallRelayDraft) => Promise<CallRelaySetting>;
    test: (draft: CallRelayDraft) => Promise<RelayServer[]>;
  };
  /** The workspace this computer hosted last, if it remembers. */
  lastHosted: () => Promise<LastHosted | null>;
  list: () => Promise<HostedWorkspaces>;
  /**
   * Asks where to save a backup of a hosted workspace, running or not, and
   * makes it there. Null when no folder was chosen.
   */
  backup: (folder: string) => Promise<{ path: string; at: number } | null>;
  /** Takes a workspace whose folder is gone out of the list. */
  forget: (folder: string) => Promise<void>;
  /**
   * Renames a hosted workspace, running or not, without moving its folder.
   * Resolves to the name it now has.
   */
  rename: (folder: string, name: string) => Promise<{ folder: string; name: string }>;
  openFolder: (folder: string) => Promise<void>;
  /**
   * A hosted workspace's icon as a data URL, read from its own database
   * whether it runs or not, without starting it. Null when it has none.
   */
  icon: (folder: string) => Promise<string | null>;
  /** Chooses the workspace, by its folder, to start whenever OwnBase opens, or none. */
  setStartOnLaunch: (folder: string | null) => Promise<void>;
  /** Whether the running workspace also reopens its stable public address when it starts with OwnBase. */
  setReopenPublicOnLaunch: (reopen: boolean) => Promise<void>;
  /** Stops showing what did not happen when OwnBase opened. */
  dismissLaunchError: () => Promise<void>;
  /** Changes the port a stopped workspace starts on. */
  setPort: (folder: string, port: number) => Promise<void>;
  /**
   * Backs a workspace up by itself, every day or week, keeping the newest
   * `keep`. With `chooseFolder`, the system asks where; resolves to
   * undefined when no folder was chosen. Null turns it off.
   */
  setAutoBackup: (
    folder: string,
    schedule: { everyDays: 1 | 7; keep: number } | null,
    chooseFolder: boolean,
  ) => Promise<AutoBackup | null | undefined>;
  /** Makes every scheduled backup that is due now, a failed one included (OPS-02). */
  retryBackups: () => Promise<void>;
  /** Whether the OS opens OwnBase when someone signs in. */
  openAtLogin: {
    get: () => Promise<boolean>;
    set: (open: boolean) => Promise<boolean>;
  };
  /**
   * Asks for a backup's folder and restores it as a workspace hosted here,
   * without starting it. Null when no folder was chosen.
   */
  restore: () => Promise<RestoredWorkspace | null>;
  /** The backups of a hosted workspace in its backup folder, newest first, each checked. */
  backups: (folder: string) => Promise<HostedBackup[]>;
  /**
   * Restores an earlier copy over a stopped hosted workspace: `backup`
   * names one from `backups`, or null asks for a backup's folder. What it
   * holds now is moved aside (`setAside`), and the copy is held until it
   * is put back in use. Null when no folder was chosen.
   */
  restoreOver: (folder: string, backup: string | null) => Promise<RestoredOver | null>;
}

/**
 * How this copy of the app gets a new version: `install` downloads and
 * installs it (Windows), `notify` says one is out and where to get it (the
 * Mac app, until it has a real signature, which macOS needs to replace an
 * app), and `none` never looks (a build not made by the Release workflow).
 */
export type UpdateMode = "install" | "notify" | "none";

/** Where looking for, and getting, a new version has got. */
export interface UpdateStatus {
  mode: UpdateMode;
  /** This copy's version. */
  version: string;
  /** "Update automatically": looks for new versions and, on Windows, downloads them. */
  automatic: boolean;
  phase: "idle" | "checking" | "downloading" | "ready" | "available" | "failed";
  /** The new version found, being downloaded, or ready to install. */
  newVersion?: string;
  /** How much of the download is done, from 0 to 100. */
  progress?: number;
  /** When it last looked, in milliseconds since 1970. */
  checkedAt?: number;
  /** What went wrong the last time it looked, for the person reading it. */
  error?: string;
  /** The notice in the window is due: shown at most once a day, until put off. */
  offer: boolean;
}

/** What the window asks, in its own dialog, before a restart disconnects people. */
export interface RestartQuestion {
  title: string;
  detail: string;
  button: string;
}

/** What pressing "Restart to update" did. */
export type UpdateRestart =
  | { restarting: true }
  /**
   * Nothing happened, and why: a call is on (`reason`), or the restart
   * disconnects people and the window asks first (`question`), then calls
   * `restart(true)` when the answer is yes.
   */
  | { restarting: false; reason?: string; question?: RestartQuestion };

/** The app's own updates, desktop only. */
export interface DesktopUpdates {
  status: () => Promise<UpdateStatus>;
  setAutomatic: (on: boolean) => Promise<UpdateStatus>;
  /** Looks now, whatever the setting, as the person asked. */
  check: () => Promise<UpdateStatus>;
  /**
   * Installs the downloaded version and opens it, after saving everything, as
   * quitting does. `confirmed` says the person already answered the question
   * an earlier call returned.
   */
  restart: (confirmed?: boolean) => Promise<UpdateRestart>;
  /** Whether the tray asked for a restart before this window was listening; asked once. */
  takeRestartAsk: () => Promise<boolean>;
  /** Puts the notice off until tomorrow, or until a newer version is ready. */
  later: () => Promise<void>;
  /** Tells the app whether a call is on, which an update never interrupts. */
  reportCall: (on: boolean) => Promise<void>;
  /** Opens the download page in the browser, where the Mac app gets a new version. */
  openDownloadPage: () => Promise<void>;
}
