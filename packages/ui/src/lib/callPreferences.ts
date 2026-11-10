import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  SCREEN_SHARE_QUALITY,
  type MicrophoneSettings,
  type ScreenShareQuality,
  type WorkspaceClient,
} from "@ownbase/client-core";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";
import { noiseFilter } from "./noiseFilter.js";
import { qualityOf } from "./screenShareQuality.js";
import { systemMicrophoneOpener } from "./systemMicrophone.js";

/**
 * The devices a huddle uses and how it cleans up the microphone's sound,
 * from Voice & video settings. Anything missing is the system's default.
 */
export interface CallDevices {
  microphoneId?: string;
  cameraId?: string;
  speakerId?: string;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  /** Strong noise suppression in place of the browser's own; see MicrophoneSettings. */
  noiseFilter?: boolean;
  autoGainControl?: boolean;
}

/** How a screen is shared from this device: what was last chosen, for the next share. */
export interface ScreenShareChoice {
  quality: ScreenShareQuality;
  /** Whether the desktop app sends the screen's sound with it. */
  sound: boolean;
}

const SHARE_AS_SENT: ScreenShareChoice = { quality: SCREEN_SHARE_QUALITY, sound: true };

/** What is kept on this device, all under one key. */
interface Kept {
  /** Join huddles with the microphone off (CALL-01). */
  joinMuted: boolean;
  devices: CallDevices;
  /**
   * Whether this device has been asked which microphone and camera to use,
   * or chose one in settings, so a join no longer asks.
   */
  devicesChecked: boolean;
  /** Absent until a share is set up here: the defaults. */
  screenShare?: ScreenShareChoice;
}

interface Preferences extends Omit<Kept, "screenShare"> {
  screenShare: ScreenShareChoice;
  /** A join is waiting for that answer; the workspace shows the question. */
  checkingDevices: boolean;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  unreadable: boolean;
  /** Resolves true once the choice is kept. */
  setJoinMuted: (value: boolean) => Promise<boolean>;
  /**
   * Saves device choices; a key set to undefined goes back to the default.
   * Resolves true once they are kept.
   */
  setDevices: (patch: CallDevices) => Promise<boolean>;
  retryLoad: () => Promise<void>;
  /**
   * Every join waits for device preferences; unknown preferences keep the
   * mic off. The first join with a choice of devices asks which first.
   */
  joinHuddle: (
    client: WorkspaceClient,
    channelId: string,
    stillWanted?: () => boolean,
  ) => Promise<void>;
  /**
   * Answers the question: the devices to join with, kept for every later
   * call, or null to join nothing and ask again next time.
   */
  finishDeviceCheck: (choice: Pick<CallDevices, "microphoneId" | "cameraId"> | null) => void;
  /**
   * Keeps how the next share goes. It applies at once, for this session even
   * if it could not be kept.
   */
  setScreenShare: (patch: Partial<ScreenShareChoice>) => void;
}

const KEY = "call-preferences";
/** Where the screen-share choice was kept before it joined the rest; moved on first read. */
const OLD_QUALITY_KEY = "screen-share-quality";
const OLD_SOUND_KEY = "screen-share-sound";
const stores = new WeakMap<Platform, ReturnType<typeof createPreferences>>();

/**
 * Only what was chosen: ids that are names, switches that are on or off.
 * Anything else is dropped rather than making the whole preference
 * unreadable, which would also forget whether to join muted.
 */
function devicesOf(saved: Record<string, unknown>): CallDevices {
  const devices: Record<string, string | boolean> = {};
  for (const key of ["microphoneId", "cameraId", "speakerId"]) {
    const value = saved[key];
    if (typeof value === "string" && value) devices[key] = value;
  }
  for (const key of ["echoCancellation", "noiseSuppression", "noiseFilter", "autoGainControl"]) {
    const value = saved[key];
    if (typeof value === "boolean") devices[key] = value;
  }
  return devices as CallDevices;
}

function shareOf(saved: unknown): ScreenShareChoice | undefined {
  if (!saved || typeof saved !== "object") return undefined;
  const { quality, sound } = saved as Record<string, unknown>;
  return { quality: qualityOf(quality), sound: sound !== false };
}

const recordOf = ({ joinMuted, devices, devicesChecked, screenShare }: Kept) => ({
  joinMuted,
  ...devices,
  ...(devicesChecked ? { devicesChecked } : {}),
  ...(screenShare ? { screenShare } : {}),
});

/** The microphone a huddle opens, as the session takes it. */
export function microphoneOf({
  microphoneId,
  cameraId: _camera,
  speakerId: _speaker,
  ...processing
}: CallDevices): MicrophoneSettings {
  return microphoneId ? { deviceId: microphoneId, ...processing } : processing;
}

function createPreferences(platform: Platform) {
  let initialization: Promise<void>;
  let loadVersion = 0;
  /** Gives a join waiting on the device question its answer. */
  let answer: ((choice: CallDevices | null) => void) | null = null;
  /** What storage holds, as far as this window knows: each write is it with one change. */
  let kept: Kept = { joinMuted: true, devices: {}, devicesChecked: false };
  let writes: Promise<unknown> = Promise.resolve();
  let shareChosen = false;
  /** Writes one change over what is kept, one write at a time, so none undoes another. */
  const keep = (patch: Partial<Kept>): Promise<void> => {
    const writing = writes.then(async () => {
      const next = { ...kept, ...patch };
      await platform.storage.set(KEY, recordOf(next));
      kept = next;
    });
    writes = writing.catch(() => {});
    return writing;
  };
  const write = (patch: Omit<Kept, "screenShare">): Promise<boolean> => {
    // Another choice is being kept, so this one is not.
    if (store.getState().saving) return initialization.then(() => false);
    // An explicit acknowledged choice supersedes every older preference read.
    const version = ++loadVersion;
    const known = store.getState().loaded;
    store.setState({ saving: true, error: null });
    const writing = keep(patch)
      .then(() => {
        if (version === loadVersion) store.setState({ ...patch, loaded: true, unreadable: false });
        return true;
      })
      .catch(() => {
        if (version === loadVersion)
          store.setState({
            loaded: true,
            unreadable: !known || store.getState().unreadable,
            error: "Could not save this setting. Try again.",
          });
        return false;
      })
      .finally(() => store.setState({ saving: false }));
    initialization = writing.then(() => {});
    return writing;
  };
  /**
   * Whether to ask which microphone and camera to use before this join: once
   * per device, while nothing is chosen, and only where the browser lists
   * more than one of either. A browser that keeps devices' names back lists
   * none, so it is asked on the first join after it gives them.
   */
  async function needsDeviceCheck(): Promise<boolean> {
    const { devicesChecked, devices, unreadable } = store.getState();
    if (devicesChecked || unreadable || devices.microphoneId || devices.cameraId) return false;
    // Fetched by a join that may ask, not by every visit: listing devices
    // brings the rest of what opens them along.
    return import("./mediaDevices.js").then(
      ({ hasDeviceChoice }) => hasDeviceChoice(),
      () => false,
    );
  }
  function askForDevices(): Promise<CallDevices | null> {
    // A join already waiting gives way to this one.
    answer?.(null);
    store.setState({ checkingDevices: true });
    return new Promise((resolve) => (answer = resolve));
  }
  const store: StoreApi<Preferences> = createStore<Preferences>(() => ({
    joinMuted: true,
    devices: {},
    devicesChecked: false,
    screenShare: SHARE_AS_SENT,
    checkingDevices: false,
    loaded: false,
    saving: false,
    error: null,
    unreadable: false,
    setJoinMuted: (joinMuted) => {
      const { devices, devicesChecked } = store.getState();
      return write({ joinMuted, devices, devicesChecked });
    },
    setDevices: (patch) => {
      const { joinMuted, devices, devicesChecked } = store.getState();
      // Choosing a microphone or camera in settings answers the question too.
      const chose = "microphoneId" in patch || "cameraId" in patch;
      return write({
        joinMuted,
        devices: devicesOf({ ...devices, ...patch }),
        devicesChecked: devicesChecked || chose,
      });
    },
    retryLoad: () => (store.getState().saving ? initialization : (initialization = load())),
    joinHuddle: async (client, channelId, stillWanted = () => true) => {
      // Wait for the latest choice, even if the read a Retry replaced stays hung.
      while (!store.getState().loaded || store.getState().saving) {
        await new Promise<void>((resolve) => {
          const unsubscribe = store.subscribe(() => {
            unsubscribe();
            resolve();
          });
        });
      }
      const gone = () =>
        !stillWanted() ||
        client.state.status === "closed" ||
        client.state.status === "auth_failed" ||
        client.state.status === "password_change_required";
      if (gone()) return;
      const choice = (await needsDeviceCheck()) ? await askForDevices() : {};
      // Listing the devices and the answer both take a while.
      if (!choice || gone()) return;
      const { joinMuted, devices: saved } = store.getState();
      // Joins with the answer even if keeping it failed.
      const devices = devicesOf({ ...saved, ...choice });
      const microphone = microphoneOf(devices);
      await client.joinHuddle(channelId, {
        muted: joinMuted,
        ...(Object.keys(microphone).length > 0 ? { microphone } : {}),
        ...(devices.cameraId ? { cameraId: devices.cameraId } : {}),
        noiseFilter,
        systemMicrophone: systemMicrophoneOpener(platform),
      });
    },
    finishDeviceCheck: (choice) => {
      const waiting = answer;
      answer = null;
      store.setState({ checkingDevices: false });
      if (choice) {
        const { joinMuted, devices } = store.getState();
        void write({
          joinMuted,
          devices: devicesOf({ ...devices, ...choice }),
          devicesChecked: true,
        });
      }
      waiting?.(choice);
    },
    setScreenShare: (patch) => {
      shareChosen = true;
      const screenShare = { ...store.getState().screenShare, ...patch };
      store.setState({ screenShare });
      // Not over what could not be read: that would also lose the device choices.
      void initialization
        .then(() => (store.getState().unreadable ? undefined : keep({ screenShare })))
        .catch(() => {});
    },
  }));
  function load(): Promise<void> {
    const version = ++loadVersion;
    store.setState({
      joinMuted: true,
      devices: {},
      devicesChecked: false,
      loaded: false,
      error: null,
    });
    return Promise.resolve()
      .then(() => platform.storage.get<unknown>(KEY, { strict: true }))
      .then(async (saved) => {
        if (version !== loadVersion) return;
        if (
          saved !== null &&
          (typeof saved !== "object" ||
            Array.isArray(saved) ||
            typeof (saved as { joinMuted?: unknown }).joinMuted !== "boolean")
        )
          throw new Error("Unreadable call preferences");
        const record = (saved ?? {}) as Record<string, unknown>;
        kept = {
          joinMuted: record.joinMuted === true,
          devices: devicesOf(record),
          devicesChecked: record.devicesChecked === true,
          screenShare: shareOf(record.screenShare),
        };
        store.setState({
          ...kept,
          screenShare: kept.screenShare ?? store.getState().screenShare,
          loaded: true,
          unreadable: false,
        });
        if (!kept.screenShare) await moveScreenShare().catch(() => {});
      })
      .catch(() => {
        if (version !== loadVersion) return;
        store.setState({
          joinMuted: true,
          devices: {},
          loaded: true,
          unreadable: true,
          error:
            "Could not load your call preferences. Until they load, huddles start with your microphone off.",
        });
      });
  }
  /** Brings a share choice kept under its old keys across, once. */
  async function moveScreenShare() {
    const [quality, sound] = await Promise.all([
      platform.storage.get<unknown>(OLD_QUALITY_KEY).catch(() => null),
      platform.storage.get<unknown>(OLD_SOUND_KEY).catch(() => null),
    ]);
    if (quality === null && sound === null) return;
    // A share set up meanwhile is newer.
    if (!shareChosen) {
      const screenShare = shareOf({ quality, sound })!;
      store.setState({ screenShare });
      await keep({ screenShare });
    }
    await Promise.all([
      platform.storage.set(OLD_QUALITY_KEY, null),
      platform.storage.set(OLD_SOUND_KEY, null),
    ]);
  }
  initialization = load();
  return store;
}

/** How huddles start on this device, for every workspace, from the platform's storage. */
export function useCallPreferences() {
  const platform = usePlatform();
  let store = stores.get(platform);
  if (!store) {
    store = createPreferences(platform);
    stores.set(platform, store);
  }
  return useStore(store);
}
