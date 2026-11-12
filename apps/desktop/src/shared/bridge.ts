/**
 * Every call the window makes to the main process, and every event the main
 * process pushes to it: the one place each is named and typed. The main
 * process registers a handler for each call from here, the preload exposes
 * them all through one generic `invoke` and `on`, and the window's platform
 * is typed from the same declarations.
 */
import type {
  DesktopCapabilities,
  DesktopFailure,
  DesktopHosting,
  DesktopUpdates,
  DiscoveredServer,
  HostingStatus,
  ShareableSource,
  SystemMicrophones,
  UpdateStatus,
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

/** Each call of `T` as the channel `<prefix>:<its path>`, answering what the call resolves to. */
type ChannelsOf<T, Prefix extends string> = {
  [K in keyof T & string]: T[K] extends (...args: infer A) => Promise<infer R>
    ? { [C in `${Prefix}:${K}`]: (...args: A) => R }
    : ChannelsOf<T[K], `${Prefix}:${K}`>;
}[keyof T & string];

type Merged<U> = (U extends unknown ? (each: U) => void : never) extends (all: infer M) => void
  ? M
  : never;

/** The hosting calls, declared once in protocol's `DesktopHosting`. */
export type HostingCalls = Merged<ChannelsOf<DesktopHosting, "hosting">>;

/** The update calls, declared once in protocol's `DesktopUpdates`. */
export type UpdateCalls = Merged<ChannelsOf<DesktopUpdates, "updates">>;

export interface Calls extends HostingCalls, UpdateCalls {
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
}

export interface Events {
  "lan:servers": DiscoveredServer[];
  "hosting:changed": HostingStatus;
  deeplink: string;
  "window:prepareClose": number;
  "updates:changed": UpdateStatus;
  /** The tray's "Restart to update", for the window to ask or explain. */
  "updates:restartAsked": null;
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

/**
 * Every call, listed so the preload can refuse anything else and typed so
 * none is left out or made up, with whether it is answered while OwnBase
 * quits. Then nothing new may start, so a hosting call is answered only if
 * it reads or stops; every other call is answered as usual.
 */
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
  "hosting:start": false,
  "hosting:stop": true,
  "hosting:openToAll": false,
  "hosting:endOpenToAll": true,
  "hosting:setAccessPolicy": false,
  "hosting:setPublicAddress": false,
  "hosting:installCloudflared": false,
  "hosting:lastHosted": true,
  "hosting:list": true,
  "hosting:backup": false,
  "hosting:forget": false,
  "hosting:rename": false,
  "hosting:openFolder": false,
  "hosting:icon": true,
  "hosting:setStartOnLaunch": false,
  "hosting:setReopenPublicOnLaunch": false,
  "hosting:dismissLaunchError": true,
  "hosting:setPort": false,
  "hosting:setAutoBackup": false,
  "hosting:retryBackups": false,
  "hosting:restore": false,
  "hosting:backups": true,
  "hosting:restoreOver": false,
  "hosting:relay:get": true,
  "hosting:relay:set": false,
  "hosting:relay:test": false,
  "hosting:openAtLogin:get": true,
  "hosting:openAtLogin:set": false,
  "updates:status": true,
  "updates:setAutomatic": true,
  "updates:check": false,
  "updates:restart": false,
  "updates:takeRestartAsk": true,
  "updates:later": true,
  "updates:reportCall": true,
  "updates:openDownloadPage": true,
} satisfies Record<Channel, boolean>;

const EVENT_LIST = {
  "lan:servers": true,
  "hosting:changed": true,
  deeplink: true,
  "window:prepareClose": true,
  "updates:changed": true,
  "updates:restartAsked": true,
} satisfies Record<EventName, true>;

export const CHANNELS = Object.keys(CALL_LIST) as Channel[];

export function answeredWhileQuitting(channel: Channel): boolean {
  return CALL_LIST[channel];
}
export const EVENTS = Object.keys(EVENT_LIST) as EventName[];

/** The channel the main process sends an opened microphone's port to the preload on. */
export const MICROPHONE_PORT_CHANNEL = "microphone:port";

/**
 * A port cannot cross Electron's context bridge, so the preload posts each
 * microphone's port to the page's own window as a message of this type.
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
    updates: "none",
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
      updates: read.updates === "install" || read.updates === "notify" ? read.updates : "none",
    };
  } catch {
    return none;
  }
}
