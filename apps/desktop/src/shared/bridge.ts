/**
 * Every call the window makes to the main process, and every event the main
 * process pushes to it: the one place each is named and typed. The main
 * process registers a handler for each call from here, the preload exposes
 * them all through one generic `invoke` and `on`, and the window's platform
 * is typed from the same declarations.
 */
import type { AccessPolicy } from "@ownbase/protocol";
import type {
  AutoBackup,
  CallRelayDraft,
  CallRelaySetting,
  DesktopCapabilities,
  DesktopFailure,
  DiscoveredServer,
  HostedBackup,
  HostedWorkspaces,
  HostingStart,
  HostingStatus,
  LastHosted,
  RelayServer,
  RestoredOver,
  RestoredWorkspace,
  ShareableSource,
  StartedWorkspace,
  SystemMicrophones,
} from "@ownbase/protocol/desktop";
import type { DraftChanges } from "@ownbase/client-core/drafts";
import type { OutboxChanges, StoredOutbox } from "@ownbase/client-core/outbox";
import type { RecordChanges } from "@ownbase/client-core/records";

/** The themes the window's own frame can be painted in. */
export type WindowTheme = "system" | "dark" | "light";

/** A microphone the main process opened, as the window is told of it. */
export interface OpenedMicrophone {
  session: number;
  sampleRate: number;
  name: string;
}

/** Each call, as the window makes it and what it resolves to. */
export interface Calls {
  "file:download": (url: string) => void;
  "storage:get": (key: string, options?: { strict?: boolean }) => unknown;
  "storage:set": (key: string, value: unknown) => void;
  "storage:initialize": (key: string, value: unknown) => unknown;
  "storage:trustAddress": (key: string, address: string) => string[] | null;
  "storage:mergeOutbox": (key: string, changes: OutboxChanges, enveloped: boolean) => StoredOutbox;
  "storage:mergeDrafts": (
    key: string,
    changes: DraftChanges,
    enveloped: boolean,
  ) => Record<string, string>;
  "storage:mergeRecord": (key: string, changes: RecordChanges) => Record<string, string>;
  "lan:snapshot": () => DiscoveredServer[];
  "deeplink:consume": () => string | null;
  "window:reveal": () => void;
  "window:rememberPlace": (url: string, state: unknown) => void;
  "window:takePlace": () => unknown;
  "window:preparedClose": (id: number, saved: boolean) => void;
  "window:setTheme": (theme: WindowTheme) => void;
  "screen:sources": (options?: { quick?: boolean }) => ShareableSource[] | null;
  "screen:choose": (id: string, options?: { sound?: boolean }) => void;
  "microphone:list": () => SystemMicrophones;
  "microphone:open": (id: string) => OpenedMicrophone;
  "microphone:close": (session: number) => void;
  "hosting:status": () => HostingStatus;
  "hosting:start": (request: HostingStart) => StartedWorkspace;
  "hosting:stop": () => void;
  "hosting:openToAll": (accessPolicy: AccessPolicy) => void;
  "hosting:endOpenToAll": () => void;
  "hosting:setAccessPolicy": (accessPolicy: AccessPolicy) => void;
  "hosting:setPublicAddress": (address: string) => void;
  "hosting:installCloudflared": () => void;
  "hosting:lastHosted": () => LastHosted | null;
  "hosting:list": () => HostedWorkspaces;
  "hosting:backup": (folder: string) => { path: string; at: number } | null;
  "hosting:forget": (folder: string) => void;
  "hosting:rename": (folder: string, name: string) => { folder: string; name: string };
  "hosting:openFolder": (folder: string) => void;
  "hosting:icon": (folder: string) => string | null;
  "hosting:setStartOnLaunch": (folder: string | null) => void;
  "hosting:setReopenPublicOnLaunch": (reopen: boolean) => void;
  "hosting:dismissLaunchError": () => void;
  "hosting:setPort": (folder: string, port: number) => void;
  "hosting:setAutoBackup": (
    folder: string,
    schedule: { everyDays: 1 | 7; keep: number } | null,
    chooseFolder: boolean,
  ) => AutoBackup | null | undefined;
  "hosting:retryBackups": () => void;
  "hosting:restore": () => RestoredWorkspace | null;
  "hosting:backups": (folder: string) => HostedBackup[];
  "hosting:restoreOver": (folder: string, backup: string | null) => RestoredOver | null;
  "hosting:relay:get": () => CallRelaySetting;
  "hosting:relay:set": (draft: CallRelayDraft) => CallRelaySetting;
  "hosting:relay:test": (draft: CallRelayDraft) => RelayServer[];
  "hosting:openAtLogin:get": () => boolean;
  "hosting:openAtLogin:set": (open: boolean) => boolean;
}

/** Each event the main process pushes, and what it carries. */
export interface Events {
  "lan:servers": DiscoveredServer[];
  "hosting:changed": HostingStatus;
  deeplink: string;
  "window:prepareClose": number;
}

export type Channel = keyof Calls;
export type EventName = keyof Events;
export type Args<C extends Channel> = Parameters<Calls[C]>;
export type Result<C extends Channel> = ReturnType<Calls[C]>;

/** How every call is answered: what it resolves to, or why it failed. */
export type Reply<C extends Channel> =
  { ok: true; value: Result<C> } | { ok: false; error: DesktopFailure };

/** What the preload puts on `window.ownbase`. */
export interface OwnBaseBridge {
  invoke<C extends Channel>(channel: C, ...args: Args<C>): Promise<Reply<C>>;
  on<E extends EventName>(event: E, listener: (payload: Events[E]) => void): () => void;
  capabilities: DesktopCapabilities;
}

/** Listed so the preload can refuse anything else; typed so none is left out or made up. */
const CALL_LIST = {
  "file:download": true,
  "storage:get": true,
  "storage:set": true,
  "storage:initialize": true,
  "storage:trustAddress": true,
  "storage:mergeOutbox": true,
  "storage:mergeDrafts": true,
  "storage:mergeRecord": true,
  "lan:snapshot": true,
  "deeplink:consume": true,
  "window:reveal": true,
  "window:rememberPlace": true,
  "window:takePlace": true,
  "window:preparedClose": true,
  "window:setTheme": true,
  "screen:sources": true,
  "screen:choose": true,
  "microphone:list": true,
  "microphone:open": true,
  "microphone:close": true,
  "hosting:status": true,
  "hosting:start": true,
  "hosting:stop": true,
  "hosting:openToAll": true,
  "hosting:endOpenToAll": true,
  "hosting:setAccessPolicy": true,
  "hosting:setPublicAddress": true,
  "hosting:installCloudflared": true,
  "hosting:lastHosted": true,
  "hosting:list": true,
  "hosting:backup": true,
  "hosting:forget": true,
  "hosting:rename": true,
  "hosting:openFolder": true,
  "hosting:icon": true,
  "hosting:setStartOnLaunch": true,
  "hosting:setReopenPublicOnLaunch": true,
  "hosting:dismissLaunchError": true,
  "hosting:setPort": true,
  "hosting:setAutoBackup": true,
  "hosting:retryBackups": true,
  "hosting:restore": true,
  "hosting:backups": true,
  "hosting:restoreOver": true,
  "hosting:relay:get": true,
  "hosting:relay:set": true,
  "hosting:relay:test": true,
  "hosting:openAtLogin:get": true,
  "hosting:openAtLogin:set": true,
} satisfies Record<Channel, true>;

const EVENT_LIST = {
  "lan:servers": true,
  "hosting:changed": true,
  deeplink: true,
  "window:prepareClose": true,
} satisfies Record<EventName, true>;

export const CHANNELS = Object.keys(CALL_LIST) as Channel[];
export const EVENTS = Object.keys(EVENT_LIST) as EventName[];

/**
 * The channel an opened microphone's port arrives on. A port cannot cross
 * Electron's context bridge, so the preload posts it to the page's own window
 * as a message of this type.
 */
export const MICROPHONE_PORT = "ownbase:microphone-port";

/** How the main process hands the window its capabilities: an argument the preload reads. */
const CAPABILITIES_ARG = "--ownbase-capabilities=";

export function capabilitiesArgument(capabilities: DesktopCapabilities): string {
  return CAPABILITIES_ARG + JSON.stringify(capabilities);
}

/** The capabilities in a window's arguments; none where they cannot be read. */
export function readCapabilities(argv: readonly string[]): DesktopCapabilities {
  const none: DesktopCapabilities = {
    readerLocale: null,
    screenSound: false,
    systemMicrophone: false,
    openAtLogin: false,
  };
  const arg = argv.find((value) => value.startsWith(CAPABILITIES_ARG));
  if (!arg) return none;
  try {
    const read = JSON.parse(arg.slice(CAPABILITIES_ARG.length)) as Record<string, unknown>;
    return {
      readerLocale: typeof read.readerLocale === "string" ? read.readerLocale : null,
      screenSound: read.screenSound === true,
      systemMicrophone: read.systemMicrophone === true,
      openAtLogin: read.openAtLogin === true,
    };
  } catch {
    return none;
  }
}
