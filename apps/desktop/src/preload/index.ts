import { contextBridge, ipcRenderer } from "electron";
import { screenSoundSupported } from "../main/screenShare.js";

export interface OwnBaseBridge {
  downloadFile: (url: string) => Promise<void>;
  storageGet: (key: string, options?: { strict?: boolean }) => Promise<unknown>;
  storageSet: (key: string, value: unknown) => Promise<void>;
  storageMergeOutbox: (key: string, changes: unknown, enveloped: boolean) => Promise<unknown>;
  onOutboxChanged: (cb: (key: string, stored: unknown) => void) => () => void;
  storageMergeDrafts: (key: string, changes: unknown, enveloped: boolean) => Promise<unknown>;
  onDraftsChanged: (cb: (key: string, stored: unknown) => void) => () => void;
  storageMergeRecord: (key: string, changes: unknown) => Promise<unknown>;
  storageInitialize: (key: string, value: unknown) => Promise<unknown>;
  storageTrustAddress: (key: string, address: string) => Promise<unknown>;
  onRecordChanged: (cb: (key: string, stored: unknown) => void) => () => void;
  lanSnapshot: () => Promise<unknown[]>;
  onLanServers: (cb: (servers: unknown[]) => void) => () => void;
  hostingStatus: () => Promise<unknown>;
  hostingLastHosted: () => Promise<unknown>;
  hostingList: () => Promise<unknown>;
  hostingBackup: (folder: string) => Promise<unknown>;
  hostingForget: (folder: string) => Promise<void>;
  hostingRename: (folder: string, name: string) => Promise<unknown>;
  hostingOpenFolder: (folder: string) => Promise<void>;
  hostingIcon: (folder: string) => Promise<unknown>;
  hostingSetStartOnLaunch: (folder: string | null) => Promise<unknown>;
  hostingSetReopenPublicOnLaunch: (reopen: boolean) => Promise<unknown>;
  hostingDismissLaunchError: () => Promise<unknown>;
  hostingSetPort: (folder: string, port: number) => Promise<unknown>;
  hostingSetAutoBackup: (
    folder: string,
    schedule: { everyDays: number; keep: number } | null,
    chooseFolder: boolean,
  ) => Promise<unknown>;
  hostingRunDueBackups: () => Promise<void>;
  hostingOpenAtLogin: () => Promise<unknown>;
  hostingSetOpenAtLogin: (open: boolean) => Promise<unknown>;
  hostingRestore: () => Promise<unknown>;
  hostingBackups: (folder: string) => Promise<unknown>;
  hostingRestoreOver: (folder: string, backup: string | null) => Promise<unknown>;
  hostingStart: (
    opts:
      | { workspaceName: string; port?: number }
      | { folder: string; port?: number; activate?: boolean },
  ) => Promise<unknown>;
  hostingStop: () => Promise<void>;
  hostingOpenToAll: (opts: {
    inviteOnly: boolean;
    accessPolicy?: "invite_only" | "account_required" | "guest_allowed";
  }) => Promise<unknown>;
  hostingEndOpenToAll: () => Promise<unknown>;
  hostingSetInviteOnly: (inviteOnly: boolean) => Promise<unknown>;
  hostingSetAccessPolicy: (
    policy: "invite_only" | "account_required" | "guest_allowed",
  ) => Promise<unknown>;
  hostingSetPublicAddress: (address: string) => Promise<unknown>;
  hostingRelay: () => Promise<unknown>;
  hostingSetRelay: (draft: unknown) => Promise<unknown>;
  hostingTestRelay: (draft: unknown) => Promise<unknown>;
  onHostingStatus: (cb: (status: unknown) => void) => () => void;
  /** An ownbase:// link that launched the app, if any. */
  consumeDeepLink: () => Promise<string | null>;
  onDeepLink: (cb: (url: string) => void) => () => void;
  /** Shows the window again, restored and in front. */
  revealWindow: () => Promise<void>;
  /** Tells the main process where the page is, for recovery to return to. */
  rememberPlace: (url: string, state: unknown) => Promise<void>;
  /** The history entry a recovered page starts from, if this load is one. */
  takePlace: () => Promise<unknown>;
  onPrepareClose: (cb: (id: number) => void) => () => void;
  preparedClose: (id: number, saved: boolean) => Promise<void>;
  /** Every screen and window that can be shared, with a picture of each; `quick` from the last list. */
  screenSources: (quick: boolean) => Promise<unknown[] | null>;
  /** Shares this screen or window at the next getDisplayMedia request, with its sound if `sound`. */
  chooseScreen: (id: string, sound: boolean) => Promise<void>;
  /** Whether a share can send the screen's sound here, as the main process decides it too. */
  screenSound: boolean;
}

const bridge: OwnBaseBridge = {
  downloadFile: (url) => ipcRenderer.invoke("file:download", url),
  storageGet: (key, options) => ipcRenderer.invoke("storage:get", key, options),
  storageSet: (key, value) => ipcRenderer.invoke("storage:set", key, value),
  storageInitialize: (key, value) => ipcRenderer.invoke("storage:initialize", key, value),
  storageTrustAddress: (key, address) => ipcRenderer.invoke("storage:trustAddress", key, address),
  storageMergeOutbox: (key, changes, enveloped) =>
    ipcRenderer.invoke("storage:mergeOutbox", key, changes, enveloped),
  onOutboxChanged: (cb) => {
    const listener = (_e: unknown, key: string, stored: unknown) => cb(key, stored);
    ipcRenderer.on("storage:outboxChanged", listener);
    return () => ipcRenderer.removeListener("storage:outboxChanged", listener);
  },
  storageMergeDrafts: (key, changes, enveloped) =>
    ipcRenderer.invoke("storage:mergeDrafts", key, changes, enveloped),
  onDraftsChanged: (cb) => {
    const listener = (_e: unknown, key: string, stored: unknown) => cb(key, stored);
    ipcRenderer.on("storage:draftsChanged", listener);
    return () => ipcRenderer.removeListener("storage:draftsChanged", listener);
  },
  storageMergeRecord: (key, changes) => ipcRenderer.invoke("storage:mergeRecord", key, changes),
  onRecordChanged: (cb) => {
    const listener = (_e: unknown, key: string, stored: unknown) => cb(key, stored);
    ipcRenderer.on("storage:recordChanged", listener);
    return () => ipcRenderer.removeListener("storage:recordChanged", listener);
  },
  lanSnapshot: () => ipcRenderer.invoke("lan:snapshot"),
  onLanServers: (cb) => {
    const listener = (_e: unknown, servers: unknown[]) => cb(servers);
    ipcRenderer.on("lan:servers", listener);
    return () => ipcRenderer.removeListener("lan:servers", listener);
  },
  hostingStatus: () => ipcRenderer.invoke("hosting:status"),
  hostingLastHosted: () => ipcRenderer.invoke("hosting:lastHosted"),
  hostingList: () => ipcRenderer.invoke("hosting:list"),
  hostingBackup: (folder) => ipcRenderer.invoke("hosting:backup", folder),
  hostingForget: (folder) => ipcRenderer.invoke("hosting:forget", folder),
  hostingRename: (folder, name) => ipcRenderer.invoke("hosting:rename", { folder, name }),
  hostingOpenFolder: (folder) => ipcRenderer.invoke("hosting:openFolder", folder),
  hostingIcon: (folder) => ipcRenderer.invoke("hosting:icon", folder),
  hostingSetStartOnLaunch: (folder) => ipcRenderer.invoke("hosting:setStartOnLaunch", folder),
  hostingSetReopenPublicOnLaunch: (reopen) =>
    ipcRenderer.invoke("hosting:setReopenPublicOnLaunch", reopen),
  hostingDismissLaunchError: () => ipcRenderer.invoke("hosting:dismissLaunchError"),
  hostingSetPort: (folder, port) => ipcRenderer.invoke("hosting:setPort", { folder, port }),
  hostingSetAutoBackup: (folder, schedule, chooseFolder) =>
    ipcRenderer.invoke("hosting:setAutoBackup", folder, schedule, chooseFolder),
  hostingRunDueBackups: () => ipcRenderer.invoke("hosting:runDueBackups"),
  hostingOpenAtLogin: () => ipcRenderer.invoke("hosting:openAtLogin"),
  hostingSetOpenAtLogin: (open) => ipcRenderer.invoke("hosting:setOpenAtLogin", open),
  hostingRestore: () => ipcRenderer.invoke("hosting:restore"),
  hostingBackups: (folder) => ipcRenderer.invoke("hosting:backups", folder),
  hostingRestoreOver: (folder, backup) => ipcRenderer.invoke("hosting:restoreOver", folder, backup),
  hostingStart: (opts) => ipcRenderer.invoke("hosting:start", opts),
  hostingStop: () => ipcRenderer.invoke("hosting:stop"),
  hostingOpenToAll: (opts) => ipcRenderer.invoke("hosting:openToAll", opts),
  hostingEndOpenToAll: () => ipcRenderer.invoke("hosting:endOpenToAll"),
  hostingSetInviteOnly: (inviteOnly) => ipcRenderer.invoke("hosting:setInviteOnly", inviteOnly),
  hostingSetAccessPolicy: (policy) => ipcRenderer.invoke("hosting:setAccessPolicy", policy),
  hostingSetPublicAddress: (address) => ipcRenderer.invoke("hosting:setPublicAddress", address),
  hostingRelay: () => ipcRenderer.invoke("hosting:relay"),
  hostingSetRelay: (draft) => ipcRenderer.invoke("hosting:setRelay", draft),
  hostingTestRelay: (draft) => ipcRenderer.invoke("hosting:testRelay", draft),
  onHostingStatus: (cb) => {
    const listener = (_e: unknown, status: unknown) => cb(status);
    ipcRenderer.on("hosting:changed", listener);
    return () => ipcRenderer.removeListener("hosting:changed", listener);
  },
  consumeDeepLink: () => ipcRenderer.invoke("deeplink:consume"),
  onDeepLink: (cb) => {
    const listener = (_e: unknown, url: string) => cb(url);
    ipcRenderer.on("deeplink", listener);
    return () => ipcRenderer.removeListener("deeplink", listener);
  },
  revealWindow: () => ipcRenderer.invoke("window:reveal"),
  rememberPlace: (url, state) => ipcRenderer.invoke("window:rememberPlace", url, state),
  takePlace: () => ipcRenderer.invoke("window:takePlace"),
  onPrepareClose: (cb) => {
    const listener = (_event: unknown, id: number) => cb(id);
    ipcRenderer.on("window:prepareClose", listener);
    return () => ipcRenderer.removeListener("window:prepareClose", listener);
  },
  preparedClose: (id, saved) => ipcRenderer.invoke("window:preparedClose", id, saved),
  screenSources: (quick) => ipcRenderer.invoke("screen:sources", quick),
  chooseScreen: (id, sound) => ipcRenderer.invoke("screen:choose", id, sound),
  screenSound: screenSoundSupported(process.platform, process.getSystemVersion()),
};

contextBridge.exposeInMainWorld("ownbase", bridge);
