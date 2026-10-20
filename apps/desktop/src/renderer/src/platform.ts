import type {
  DraftChanges,
  OutboxChanges,
  RecordChanges,
  StoredOutbox,
} from "@slackoss/client-core";
import type { AccessPolicy } from "@slackoss/protocol";
import type {
  AutoBackup,
  CallRelayDraft,
  CallRelaySetting,
  DiscoveredServer,
  HostedBackup,
  HostedWorkspaces,
  HostingStart,
  HostingStatus,
  LastHosted,
  Platform,
  RestoreInventory,
  ShareableSource,
} from "@slackoss/ui";

interface SlackossBridge {
  downloadFile: (url: string) => Promise<void>;
  storageGet: (key: string, options?: { strict?: boolean }) => Promise<unknown>;
  storageSet: (key: string, value: unknown) => Promise<void>;
  storageMergeOutbox: (
    key: string,
    changes: OutboxChanges,
    enveloped: boolean,
  ) => Promise<StoredOutbox>;
  onOutboxChanged: (cb: (key: string, stored: unknown) => void) => () => void;
  storageMergeDrafts: (
    key: string,
    changes: DraftChanges,
    enveloped: boolean,
  ) => Promise<Record<string, string>>;
  onDraftsChanged: (cb: (key: string, stored: unknown) => void) => () => void;
  storageMergeRecord: (key: string, changes: RecordChanges) => Promise<Record<string, string>>;
  storageInitialize: (key: string, value: unknown) => Promise<unknown>;
  storageTrustAddress: (key: string, address: string) => Promise<string[] | null>;
  onRecordChanged: (cb: (key: string, stored: unknown) => void) => () => void;
  lanSnapshot: () => Promise<DiscoveredServer[]>;
  onLanServers: (cb: (servers: DiscoveredServer[]) => void) => () => void;
  hostingStatus: () => Promise<HostingStatus>;
  hostingStart: (opts: HostingStart) => Promise<HostingStatus>;
  hostingLastHosted: () => Promise<LastHosted | null>;
  hostingList: () => Promise<HostedWorkspaces>;
  hostingBackup: (folder: string) => Promise<{ path: string; at: number } | null>;
  hostingForget: (folder: string) => Promise<void>;
  hostingRename: (folder: string, name: string) => Promise<{ folder: string; name: string }>;
  hostingOpenFolder: (folder: string) => Promise<void>;
  hostingIcon: (folder: string) => Promise<string | null>;
  hostingSetStartOnLaunch: (folder: string | null) => Promise<string | null>;
  hostingSetReopenPublicOnLaunch: (reopen: boolean) => Promise<boolean>;
  hostingDismissLaunchError: () => Promise<unknown>;
  hostingSetPort: (folder: string, port: number) => Promise<{ folder: string; port: number }>;
  hostingSetAutoBackup: (
    folder: string,
    schedule: { everyDays: 1 | 7; keep: number } | null,
    chooseFolder: boolean,
  ) => Promise<AutoBackup | null | undefined>;
  hostingRunDueBackups: () => Promise<void>;
  hostingOpenAtLogin: () => Promise<boolean | null>;
  hostingSetOpenAtLogin: (open: boolean) => Promise<boolean>;
  hostingRestore: () => Promise<{
    folder: string;
    name: string;
    inventory?: RestoreInventory | null;
  } | null>;
  hostingBackups: (folder: string) => Promise<HostedBackup[]>;
  hostingRestoreOver: (
    folder: string,
    backup: string | null,
  ) => Promise<{
    folder: string;
    name: string;
    setAside: string | null;
    inventory?: RestoreInventory | null;
  } | null>;
  hostingStop: () => Promise<void>;
  hostingOpenToAll: (opts: {
    inviteOnly: boolean;
    accessPolicy?: AccessPolicy;
  }) => Promise<HostingStatus>;
  hostingEndOpenToAll: () => Promise<HostingStatus>;
  hostingSetInviteOnly: (inviteOnly: boolean) => Promise<HostingStatus>;
  hostingSetAccessPolicy: (policy: AccessPolicy) => Promise<HostingStatus>;
  hostingSetPublicAddress: (address: string) => Promise<HostingStatus>;
  hostingRelay: () => Promise<CallRelaySetting>;
  hostingSetRelay: (draft: CallRelayDraft) => Promise<CallRelaySetting>;
  hostingTestRelay: (draft: CallRelayDraft) => Promise<RTCIceServer[]>;
  onHostingStatus: (cb: (status: HostingStatus) => void) => () => void;
  consumeDeepLink: () => Promise<string | null>;
  onDeepLink: (cb: (url: string) => void) => () => void;
  revealWindow: () => Promise<void>;
  rememberPlace: (url: string, state: unknown) => Promise<void>;
  takePlace: () => Promise<unknown>;
  onPrepareClose: (cb: (id: number) => void) => () => void;
  preparedClose: (id: number, saved: boolean) => Promise<void>;
  screenSources: (quick: boolean) => Promise<ShareableSource[] | null>;
  chooseScreen: (id: string) => Promise<void>;
}

declare global {
  interface Window {
    slackoss: SlackossBridge;
  }
}

/**
 * Electron prefixes a rejected handler's message with the channel it came
 * from. Where the main process wrote the message for the person reading it,
 * that prefix is noise, so it is removed before the UI ever sees it.
 */
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/;
function plainly<T>(call: Promise<T>): Promise<T> {
  return call.catch((reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    throw new Error(message.replace(IPC_PREFIX, "") || message);
  });
}

export function electronPlatform(): Platform {
  const bridge = window.slackoss;
  const preparing = {
    capture: new Set<() => void | Promise<void>>(),
    persist: new Set<() => void | Promise<void>>(),
  };
  bridge.onPrepareClose?.((id) => {
    void (async () => {
      let saved = false;
      try {
        for (const capture of [...preparing.capture]) await capture();
        await Promise.all([...preparing.persist].map((persist) => persist()));
        saved = true;
      } catch {
        // Failure is handed back to the native close decision; it must not silently quit.
      }
      await bridge.preparedClose(id, saved).catch(() => {});
    })();
  });
  return {
    kind: "desktop",
    onPrepareClose: (phase, prepare) => {
      preparing[phase].add(prepare);
      return () => {
        preparing[phase].delete(prepare);
      };
    },
    downloadFile: (url) => bridge.downloadFile(url),
    storage: {
      get: async <T>(key: string, options?: { strict?: boolean }) =>
        (await bridge.storageGet(key, options)) as T | null,
      set: (key, value) => bridge.storageSet(key, value),
      initialize: (key, value) => bridge.storageInitialize(key, value),
      trustAddress: (key, address) => bridge.storageTrustAddress(key, address),
      // Merged in the main process, where every window's writes wait their turn.
      mergeOutbox: (key, changes, enveloped) => bridge.storageMergeOutbox(key, changes, enveloped),
      watchOutbox: (key, cb) =>
        bridge.onOutboxChanged((changed, stored) => {
          if (changed === key) cb(stored);
        }),
      mergeDrafts: (key, changes, enveloped) => bridge.storageMergeDrafts(key, changes, enveloped),
      watchDrafts: (key, cb) =>
        bridge.onDraftsChanged((changed, stored) => {
          if (changed === key) cb(stored);
        }),
      mergeRecord: (key, changes) => bridge.storageMergeRecord(key, changes),
      watchRecord: (key, cb) =>
        bridge.onRecordChanged((changed, stored) => {
          if (changed === key) cb(stored);
        }),
    },
    notify: (title, body, onClick, options) => {
      const note = new Notification(title, { body, silent: false, tag: options?.tag });
      if (onClick) {
        note.onclick = (event) => {
          event.preventDefault();
          // The renderer cannot raise a window that is minimized or closed to
          // the tray; the main process can.
          void bridge.revealWindow();
          onClick();
          note.close();
        };
      }
    },
    screenShare: {
      sources: (options) => bridge.screenSources(options?.quick === true),
      // Says, in the picker's words, when what was chosen has gone.
      choose: (id) => plainly(bridge.chooseScreen(id)),
    },
    discoverLan: (cb) => {
      void bridge.lanSnapshot().then(cb);
      return bridge.onLanServers(cb);
    },
    deepLinks: {
      consumePending: () => bridge.consumeDeepLink(),
      subscribe: (cb) => bridge.onDeepLink(cb),
    },
    hosting: {
      status: () => bridge.hostingStatus(),
      // Its refusals are the controller's own words, and the window shows them.
      start: (opts) => plainly(bridge.hostingStart(opts)),
      setPort: (folder, port) => plainly(bridge.hostingSetPort(folder, port)),
      setAutoBackup: (folder, schedule, chooseFolder) =>
        plainly(bridge.hostingSetAutoBackup(folder, schedule, chooseFolder)),
      retryBackups: () => bridge.hostingRunDueBackups(),
      lastHosted: () => bridge.hostingLastHosted(),
      list: () => bridge.hostingList(),
      backup: (folder) => plainly(bridge.hostingBackup(folder)),
      forget: (folder) => plainly(bridge.hostingForget(folder)),
      rename: (folder, name) => plainly(bridge.hostingRename(folder, name)),
      openFolder: (folder) => plainly(bridge.hostingOpenFolder(folder)),
      icon: (folder) => bridge.hostingIcon(folder),
      setReopenPublicOnLaunch: (reopen) => plainly(bridge.hostingSetReopenPublicOnLaunch(reopen)),
      dismissLaunchError: async () => {
        await plainly(bridge.hostingDismissLaunchError());
      },
      setStartOnLaunch: async (folder) => {
        await plainly(bridge.hostingSetStartOnLaunch(folder));
      },
      openAtLogin: {
        get: () => bridge.hostingOpenAtLogin(),
        set: (open) => plainly(bridge.hostingSetOpenAtLogin(open)),
      },
      restore: () => plainly(bridge.hostingRestore()),
      backups: (folder) => plainly(bridge.hostingBackups(folder)),
      restoreOver: (folder, backup) => plainly(bridge.hostingRestoreOver(folder, backup)),
      stop: () => bridge.hostingStop(),
      openToAll: (opts) => plainly(bridge.hostingOpenToAll(opts)),
      endOpenToAll: () => bridge.hostingEndOpenToAll(),
      setInviteOnly: (inviteOnly) => bridge.hostingSetInviteOnly(inviteOnly),
      setAccessPolicy: (policy) => bridge.hostingSetAccessPolicy(policy),
      setPublicAddress: (address) => plainly(bridge.hostingSetPublicAddress(address)),
      relay: {
        get: () => bridge.hostingRelay(),
        set: (draft) => plainly(bridge.hostingSetRelay(draft)),
        test: (draft) => plainly(bridge.hostingTestRelay(draft)),
      },
      subscribe: (cb) => bridge.onHostingStatus(cb),
    },
  };
}

/**
 * Keeps the main process told where this page is, so a page that crashes or
 * fails to load comes back to the same place, side panel, thread, dialog and
 * reading position included (F08). The history entry holds all of that, and
 * a reload keeps the address but not the entry. Reports are gathered for a
 * moment, since reading position changes as someone scrolls.
 */
export async function followPlace(
  bridge: Pick<SlackossBridge, "rememberPlace" | "takePlace">,
  delayMs = 250,
): Promise<void> {
  // A recovered page starts from the entry it had; the app checks that entry
  // belongs to the workspace it opens before using it.
  const recovered = await bridge.takePlace().catch(() => null);
  if (recovered && window.history.state == null)
    window.history.replaceState(recovered, "", window.location.href);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const report = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void bridge.rememberPlace(window.location.href, window.history.state).catch(() => {});
    }, delayMs);
  };
  for (const method of ["pushState", "replaceState"] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (...args: Parameters<History["pushState"]>) => {
      original(...args);
      report();
    };
  }
  window.addEventListener("popstate", report);
  window.addEventListener("hashchange", report);
  report();
}
