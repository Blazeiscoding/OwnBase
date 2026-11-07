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

/** What a person is told when a port they chose is not one. */
export const PORT_RULE = "Choose a port from 1 to 65535.";

/** A port as typed, or null when it is not one. */
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
  /** The app is quitting, so it starts nothing new. */
  | "quitting"
  /** The list of hosted workspaces was saved by a newer version. */
  | "registry-newer"
  /** The list of hosted workspaces has a version this one cannot read. */
  | "registry-unsupported"
  /** The list of hosted workspaces is damaged. */
  | "registry-damaged"
  /** A public link waits for the workspace's owner account. */
  | "owner-account-missing"
  /** A call relay was refused for one of its fields. */
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

/** The workspace this computer hosted most recently. */
export interface LastHosted {
  folder: string;
  workspaceName: string;
  port: number;
}

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

/** Every microphone the system has, and its default. */
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
  /** The announcing server's instance id. */
  instanceId?: string;
  /** The version of its icon; absent when it has none. */
  iconVersion?: string;
}
