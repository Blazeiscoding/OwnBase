import type { DeviceStorage, StoredOutbox } from "@ownbase/client-core";
import type { AccessPolicy } from "@ownbase/protocol";
import type {
  AutoBackup,
  CallRelayDraft,
  CallRelaySetting,
  DesktopErrorCode,
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
import { deviceStore } from "./lib/deviceStore.js";
import type { SavedServer, SignInChange } from "@ownbase/client-core/savedSignIns";
import { parseDeepLink } from "./lib/deeplink.js";
import { workerNotifications, type WorkerNotifications } from "./lib/workerNotifications.js";

export type {
  AutoBackup,
  CallRelayDraft,
  CallRelaySetting,
  DiscoveredServer,
  HostedBackup,
  HostedWorkspace,
  HostedWorkspaces,
  HostingStart,
  HostingStatus,
  LastHosted,
  RestoreInventory,
  ShareableSource,
  StartedWorkspace,
  SystemMicrophoneDevice,
} from "@ownbase/protocol/desktop";

/**
 * Why a platform call failed, where the platform names it: the desktop app
 * gives each failure a code, which is what the UI acts on, never its words.
 */
export function failureCode(reason: unknown): DesktopErrorCode | undefined {
  const code = (reason as { code?: unknown } | null)?.code;
  return typeof code === "string" ? (code as DesktopErrorCode) : undefined;
}

export function failureMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

export type { SavedServer } from "@ownbase/client-core/savedSignIns";

/** One the app opened itself; see `Platform.systemMicrophone`. */
export interface OpenedSystemMicrophone {
  /** Its sound: mono Float32Arrays at `sampleRate`, then `{ ended }` if the device goes. */
  port: MessagePort;
  sampleRate: number;
  name: string;
  close: () => void;
}

/**
 * What the surrounding shell (Electron app, browser) provides to the UI.
 * Everything optional is absent where the shell cannot do it: the web client
 * has no LAN discovery or hosting.
 */
export interface Platform {
  /** "desktop" gets the frameless titlebar spacing; "web" does not. */
  kind: "desktop" | "web";
  /** Desktop close first captures current input, then awaits every account-scoped persistence owner. */
  onPrepareClose?: (
    phase: "capture" | "persist",
    prepare: () => void | Promise<void>,
  ) => () => void;
  storage: DeviceStorage & {
    /**
     * Makes one change to the saved sign-ins under `key` (`changeSavedServers`)
     * in one step no other tab's write can come between, and gives back the
     * sign-ins now stored: null when what is stored cannot be read, which is
     * left as it is. Without it, a change is a read and a separate write, kept
     * apart from other windows' only where the browser has `navigator.locks`.
     */
    changeSignIns?: (key: string, change: SignInChange) => Promise<SavedServer[] | null>;
  };
  /**
   * `tag` names what the notification is about. Windows of one browser that
   * show the same tag show one notification, so each window of an account
   * can tell about the same message without it appearing twice (IMP-03).
   */
  notify: (title: string, body: string, onClick?: () => void, options?: { tag?: string }) => void;
  /** Hand a scoped download URL to the browser/OS; completion is managed there. */
  downloadFile?: (url: string) => Promise<void>;
  /** Paints the desktop window's own frame and title bar in the page's theme. */
  setWindowTheme?: (theme: "system" | "dark" | "light") => void;
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
     * Shares this one when the huddle next asks for a screen, with its sound
     * when `sound` is given and this computer can share it. Rejects, saying
     * why, when it has gone since it was listed.
     */
    choose: (id: string, options?: { sound?: boolean }) => Promise<void>;
    /**
     * Whether this computer can share a screen's sound, with the app's own
     * left out, so the picker offers it.
     */
    sound: boolean;
  };
  /**
   * Microphones the app opens itself, the way other apps on this computer
   * open them, rather than through the browser. Desktop on Windows only,
   * where the browser opens a microphone raw, which leaves out the sound
   * effects set up in Windows.
   */
  systemMicrophone?: {
    /** Every microphone the system has, and its default; none where the app cannot open them. */
    list: () => Promise<SystemMicrophones>;
    /** Opens one by the system's id for it. Rejects, saying why, when it will not start. */
    open: (id: string) => Promise<OpenedSystemMicrophone>;
  };
  /** Subscribe to LAN server discovery. Returns unsubscribe. Desktop only. */
  discoverLan?: (cb: (servers: DiscoveredServer[]) => void) => () => void;
  /**
   * Links to join a workspace or open a message: ownbase:// ones in the
   * desktop app, and the address a browser was opened at.
   */
  deepLinks?: {
    consumePending: () => Promise<string | null>;
    /** Links arriving while the app is already running. */
    subscribe: (cb: (url: string) => void) => () => void;
  };
  /**
   * Running a workspace server inside this app. Desktop only. Its status is
   * read once and then followed through `subscribe`; nothing else returns it.
   */
  hosting?: {
    status: () => Promise<HostingStatus>;
    subscribe: (cb: (status: HostingStatus) => void) => () => void;
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
    /** Whether the OS opens OwnBase when someone signs in; null where it cannot. */
    openAtLogin: {
      get: () => Promise<boolean>;
      set: (open: boolean) => Promise<boolean>;
    } | null;
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
  };
}

/** Browser fallback platform — used by the web client and in dev. */
export function webPlatform(): Platform {
  const device = deviceStore();
  let workers: WorkerNotifications | undefined;
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
      trustAddress: (key, address) =>
        device.apply(key, { kind: "trust", address }) as Promise<string[] | null>,
      changeSignIns: (key, change) =>
        device.apply(key, { kind: "signIns", change }) as Promise<SavedServer[] | null>,
    },
    notify: (title, body, onClick, options) => {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      let note: Notification;
      try {
        note = new Notification(title, { body, tag: options?.tag });
      } catch {
        // Android's Chrome shows only what a service worker asks for.
        if (navigator.serviceWorker) {
          workers ??= workerNotifications(navigator.serviceWorker);
          void workers.show(title, body, onClick, options?.tag);
        }
        return;
      }
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
