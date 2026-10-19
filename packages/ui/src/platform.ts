import type {
  DraftChanges,
  OutboxChanges,
  RecordChanges,
  StoredOutbox,
} from "@slackoss/client-core";
import type { AccessPolicy } from "@slackoss/protocol";
import { deviceStore } from "./lib/deviceStore.js";
import { parseDeepLink } from "./lib/deeplink.js";

/** A workspace server found on the local network via mDNS. */
export interface DiscoveredServer {
  name: string;
  /** An address a link can carry: IPv4, a hostname, or IPv6 without brackets. */
  host: string;
  port: number;
  serverVersion: string;
  /** The announcing server's instance id; absent from servers that do not send it. */
  instanceId?: string;
  /** The version of its icon; absent when it has none, or does not say. */
  iconVersion?: string;
}

export interface SavedServer {
  url: string;
  token: string;
  workspaceName: string;
  handle: string;
  lastUsedAt: number;
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

/** What a restored backup brings with it once it is put back in use. */
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

/** The workspace this computer hosted most recently. */
export interface LastHosted {
  /** Absent from an app older than the list of hosted workspaces. */
  folder?: string;
  workspaceName: string;
  port: number;
}

/** A workspace backed up by itself: where, how often, and how many are kept. */
export interface AutoBackup {
  destination: string;
  everyDays: 1 | 7;
  keep: number;
  /** When this schedule last made a backup into its folder, if it has. */
  lastAt?: number;
  /**
   * Why its last try did not finish, until one does. `cleanup`: the backup
   * was made, but older ones there could not be removed.
   */
  failure?: { kind: string };
}

/** Every workspace hosted on this computer, most recent first. */
export interface HostedWorkspaces {
  workspaces: {
    folder: string;
    name: string;
    port: number;
    lastHostedAt: number;
    /** When a backup of it last finished, or null if none has on this computer. */
    lastBackupAt: number | null;
    running: boolean;
    /** Its folder is gone, so it cannot start. */
    missing: boolean;
    /** Chosen to start when Tandem opens. Absent from apps that cannot. */
    startsOnLaunch?: boolean;
    /** Backed up by itself on a schedule. Absent from apps that cannot. */
    autoBackup?: AutoBackup | null;
    /** Why its last scheduled backup did not finish, until one does. */
    autoBackupError?: string | null;
    /** Restored from a backup and not yet put back in use. */
    restored?: boolean;
    /**
     * Its icon's version, read from its own database whether it runs or not,
     * or null when it has none. Absent from apps older than workspace icons.
     */
    iconVersion?: string | null;
  }[];
  /** Folders holding a workspace that could not be read. */
  unreadable: string[];
}

export interface HostingStatus {
  running: boolean;
  phase?: "stopped" | "starting" | "running" | "stopping";
  workspaceName?: string;
  /** The running workspace's entry in the list of hosted workspaces. */
  folder?: string;
  port?: number;
  /** The running server's instance id, which its network announcement also carries. */
  instanceId?: string;
  dataDir?: string;
  lanUrls?: string[];
  warning?: string;
  /** Whether closing the window can keep hosting through the system tray. */
  backgroundAvailable?: boolean;
  /** A public address, while Cloudflare Tunnel is opening or open. */
  openToAll?: { phase: "opening" } | { phase: "open"; url: string };
  /** Why the last attempt to open the public address failed or ended. */
  openToAllError?: string;
  /** Whether cloudflared is installed where the desktop app can find it. */
  tunnelAvailable?: boolean;
  /** A configured address that stays the same each time the link is opened. */
  publicAddress?: string;
  /** What the public address setting holds, valid or not, for editing. */
  publicAddressSetting?: string;
  /** Whether the environment set the address, so this app cannot change it. */
  publicAddressLocked?: boolean;
  /** Whether Tandem runs the connector for it, rather than something else. */
  publicAddressManaged?: boolean;
  /** Safe setup instructions when the stable address configuration cannot be used. */
  publicAddressError?: string;
  /** Whether new accounts need an invite code. */
  inviteOnly?: boolean;
  /** Who may join; absent from an app that predates guest access. */
  accessPolicy?: AccessPolicy;
  /** The running workspace is the one chosen to start when Tandem opens. */
  startsOnLaunch?: boolean;
  /**
   * What did not happen when Tandem opened: the workspace chosen to start
   * with it did not start, or started without reopening its stable address.
   * Kept until that part recovers or the host dismisses it.
   */
  launchError?: string;
  /** Whether `launchError` is about hosting itself or only its public address. */
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
  /** The running workspace reopens its stable public address when it starts with Tandem. */
  reopensPublicOnLaunch?: boolean;
  /** The running workspace's icon version, or null when it has none. */
  iconVersion?: string | null;
}

/**
 * What the surrounding shell (Electron app, browser) provides to the UI.
 * Everything optional degrades gracefully — the web client has no LAN
 * discovery or hosting.
 */
export interface Platform {
  /** "desktop" gets the frameless titlebar spacing; "web" does not. */
  kind: "desktop" | "web";
  /** Desktop close first captures current input, then awaits every account-scoped persistence owner. */
  onPrepareClose?: (
    phase: "capture" | "persist",
    prepare: () => void | Promise<void>,
  ) => () => void;
  storage: {
    /** Strict reads must reject unreadable data instead of treating it as absent. */
    get: <T>(key: string, options?: { strict?: boolean }) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<void>;
    /**
     * Stores `value` under `key` only if nothing is stored there, in one step
     * no other window's write can come between, and gives back what is stored
     * now: `value`, or what another window stored first (F01, GL-01). Without
     * it, initializing is a read and a separate write.
     */
    initialize?: (key: string, value: unknown) => Promise<unknown>;
    /**
     * Merges one window's outbox changes into what is stored under `key`, in
     * one step no other window's write can come between, and gives back the
     * outbox now stored. `enveloped` says the value is kept as
     * `{ version: 1, value }`. Merges asked for one after another are made,
     * and answered, in that order. Without it, a window merges within its own
     * queue only; see `mergeWorkspaceOutbox`.
     */
    mergeOutbox?: (
      key: string,
      changes: OutboxChanges,
      enveloped: boolean,
    ) => Promise<StoredOutbox>;
    /**
     * Calls back with what is stored under an outbox key each time another
     * window changes it. Returns unsubscribe.
     */
    watchOutbox?: (key: string, cb: (stored: unknown) => void) => () => void;
    /** As `mergeOutbox`, for the drafts under `key`: each changed draft alone. */
    mergeDrafts?: (
      key: string,
      changes: DraftChanges,
      enveloped: boolean,
    ) => Promise<Record<string, string>>;
    /** As `watchOutbox`, for a drafts key. */
    watchDrafts?: (key: string, cb: (stored: unknown) => void) => () => void;
    /**
     * Sets the named values of the record under `key`, each alone, in one
     * step no other window's write can come between, and gives back the
     * record now stored; null removes a name (F02). Without it, a window
     * writes its whole record and can erase another window's change.
     */
    mergeRecord?: (key: string, changes: RecordChanges) => Promise<Record<string, string>>;
    /** As `watchOutbox`, for a record key. */
    watchRecord?: (key: string, cb: (stored: unknown) => void) => () => void;
  };
  /**
   * `tag` names what the notification is about. Windows of one browser that
   * show the same tag show one notification, so each window of an account
   * can tell about the same message without it appearing twice (IMP-03).
   */
  notify: (title: string, body: string, onClick?: () => void, options?: { tag?: string }) => void;
  /** Hand a scoped download URL to the browser/OS; completion is managed there. */
  downloadFile?: (url: string) => Promise<void>;
  /**
   * The screens and windows this computer can share, for the app's own
   * picker. Desktop only: a browser shows its own when a huddle asks.
   */
  screenShare?: {
    /**
     * Every screen, and every window showing something, each with a picture
     * taken now, which can take seconds. `quick` answers at once from the
     * last such list, less what has closed since, or with null when there has
     * been none.
     */
    sources: (options?: { quick?: boolean }) => Promise<ShareableSource[] | null>;
    /**
     * Shares this one when the huddle next asks for a screen. Rejects, saying
     * why, when it has gone since it was listed.
     */
    choose: (id: string) => Promise<void>;
  };
  /** Subscribe to LAN server discovery. Returns unsubscribe. Desktop only. */
  discoverLan?: (cb: (servers: DiscoveredServer[]) => void) => () => void;
  /**
   * Links to join a workspace or open a message: tandem:// ones (the
   * previous slackoss:// form still reads) in the desktop app, and the
   * address a browser was opened at.
   */
  deepLinks?: {
    /** A link that launched the app, consumed once. */
    consumePending: () => Promise<string | null>;
    /** Links arriving while the app is already running. */
    subscribe: (cb: (url: string) => void) => () => void;
  };
  /** "Open to LAN" — run a workspace server inside this app. Desktop only. */
  hosting?: {
    status: () => Promise<HostingStatus>;
    subscribe?: (cb: (status: HostingStatus) => void) => () => void;
    start: (opts: HostingStart) => Promise<HostingStatus>;
    stop: () => Promise<void>;
    /** Publish/unpublish the hosted workspace at a public address. */
    /** `accessPolicy`, where given, decides who may join instead of `inviteOnly`. */
    openToAll?: (opts: {
      inviteOnly: boolean;
      accessPolicy?: AccessPolicy;
    }) => Promise<HostingStatus>;
    endOpenToAll?: () => Promise<HostingStatus>;
    /** Change whether new accounts need an invite while the server is running. */
    setInviteOnly?: (inviteOnly: boolean) => Promise<HostingStatus>;
    /** Change who may join while the server is running; turning guests off signs them out. */
    setAccessPolicy?: (policy: AccessPolicy) => Promise<HostingStatus>;
    /**
     * Save an address something else already carries to this workspace, or
     * clear it with "" to go back to a temporary one. Rejects what cannot be
     * published, so the setting never holds an address that will not work.
     */
    setPublicAddress?: (address: string) => Promise<HostingStatus>;
    /**
     * The TURN relay for calls between networks that will not connect
     * directly: the one saved, saving another, and the relay servers a draft
     * gives a call, to check they give a route before anyone needs them.
     */
    relay?: {
      get: () => Promise<CallRelaySetting>;
      set: (draft: CallRelayDraft) => Promise<CallRelaySetting>;
      test: (draft: CallRelayDraft) => Promise<RTCIceServer[]>;
    };
    /** The workspace this computer hosted last, if it remembers. */
    lastHosted?: () => Promise<LastHosted | null>;
    /** Every workspace hosted on this computer. Absent from apps older than the list. */
    list?: () => Promise<HostedWorkspaces>;
    /**
     * Asks where to save a backup of a hosted workspace, running or not, and
     * makes it there. Null when no folder was chosen.
     */
    backup?: (folder: string) => Promise<{ path: string; at: number } | null>;
    /** Takes a workspace whose folder is gone out of the list. */
    forget?: (folder: string) => Promise<void>;
    /**
     * Renames a hosted workspace, running or not, without moving its folder.
     * Rejects, saying why, a name of more than 80 characters, none, or one
     * with control characters. Resolves to the name it now has.
     */
    rename?: (folder: string, name: string) => Promise<{ folder: string; name: string }>;
    /** Shows a hosted workspace's folder in the system's file manager. */
    openFolder?: (folder: string) => Promise<void>;
    /**
     * A hosted workspace's icon as a data URL, read from its own database
     * whether it runs or not, without starting it. Null when it has none.
     */
    icon?: (folder: string) => Promise<string | null>;
    /**
     * Chooses the workspace, by its folder, to start whenever Tandem
     * opens, or none. Rejects, saying why, a workspace not in the list.
     */
    setStartOnLaunch?: (folder: string | null) => Promise<void>;
    /**
     * Whether the running workspace also reopens its stable public address
     * when it starts with Tandem. Rejects, saying why, without a stable
     * address or while nothing is running.
     */
    setReopenPublicOnLaunch?: (reopen: boolean) => Promise<boolean>;
    /** Stops showing what did not happen when Tandem opened. */
    dismissLaunchError?: () => Promise<void>;
    /**
     * Changes the port a stopped workspace starts on. Rejects, saying why,
     * a port outside 1 to 65535 or a workspace that is running.
     */
    setPort?: (folder: string, port: number) => Promise<{ folder: string; port: number }>;
    /**
     * Backs a workspace up by itself, every day or week, keeping the newest
     * `keep`. With `chooseFolder`, the system asks where; resolves to
     * undefined when no folder was chosen. Null turns it off.
     */
    setAutoBackup?: (
      folder: string,
      schedule: { everyDays: 1 | 7; keep: number } | null,
      chooseFolder: boolean,
    ) => Promise<AutoBackup | null | undefined>;
    /**
     * Makes every scheduled backup that is due now, a failed one included,
     * and resolves when they have finished or failed again (OPS-02).
     */
    retryBackups?: () => Promise<void>;
    /**
     * Whether the OS opens Tandem when someone signs in to this computer.
     * `get` resolves to null where it cannot, such as a copy run from source.
     */
    openAtLogin?: {
      get: () => Promise<boolean | null>;
      set: (open: boolean) => Promise<boolean>;
    };
    /**
     * Asks for a backup's folder and restores it as a workspace hosted here,
     * without starting it. Null when no folder was chosen.
     */
    restore?: () => Promise<{
      folder: string;
      name: string;
      inventory?: RestoreInventory | null;
    } | null>;
  };
}

/** Browser fallback platform — used by the web client and in dev. */
export function webPlatform(): Platform {
  const device = deviceStore();
  return {
    kind: "web",
    downloadFile: async (url) => {
      // A failed redemption must not replace the workspace page. Downloads
      // from an attachment response are handed to the browser's download UI.
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.title = "File download";
      frame.referrerPolicy = "no-referrer";
      frame.src = url;
      document.body.append(frame);
      setTimeout(() => frame.remove(), 300_000);
    },
    // One merge at a time for every tab of this site, in IndexedDB where the
    // browser has it (F01); see `deviceStore`.
    storage: {
      get: async <T>(key: string, options?: { strict?: boolean }) => {
        try {
          const raw = await device.read(key);
          return raw === null ? null : (JSON.parse(raw) as T);
        } catch (error) {
          if (options?.strict) throw error;
          return null;
        }
      },
      set: async (key, value) => {
        await device.apply(key, { kind: "set", value });
      },
      initialize: (key, value) => device.apply(key, { kind: "initialize", value }),
      mergeOutbox: (key, changes, enveloped) =>
        device.apply(key, { kind: "outbox", changes, enveloped }) as Promise<StoredOutbox>,
      watchOutbox: (key, cb) => device.watch(key, cb),
      mergeDrafts: (key, changes, enveloped) =>
        device.apply(key, { kind: "drafts", changes, enveloped }) as Promise<
          Record<string, string>
        >,
      watchDrafts: (key, cb) => device.watch(key, cb),
      mergeRecord: (key, changes) =>
        device.apply(key, { kind: "record", changes }) as Promise<Record<string, string>>,
      watchRecord: (key, cb) => device.watch(key, cb),
    },
    notify: (title, body, onClick, options) => {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      const note = new Notification(title, { body, tag: options?.tag });
      if (onClick) {
        note.onclick = (event) => {
          event.preventDefault();
          window.focus();
          onClick();
          note.close();
        };
      }
    },
    deepLinks: {
      consumePending: async () => takeLinkFromAddress(),
      subscribe: (cb) => {
        // A link pasted into the address bar of a page already open changes
        // only the fragment, which loads nothing.
        const onHashChange = () => {
          const link = takeLinkFromAddress();
          if (link) cb(link);
        };
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
      },
    },
  };
}

/**
 * The link this page was opened at, such as <server>/#/join/<code>. It is taken
 * out of the address once read, so a reload does not act on it again and an
 * invite code does not stay in the address bar or the history.
 */
function takeLinkFromAddress(): string | null {
  const { href, pathname, search } = window.location;
  if (!parseDeepLink(href)) return null;
  history.replaceState(history.state, "", pathname + search);
  return href;
}
