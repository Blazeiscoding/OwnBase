import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { MicrophoneSettings, WorkspaceClient } from "@slackoss/client-core";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";
import { noiseFilter } from "./noiseFilter.js";

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

interface Preferences {
  /** Join huddles with the microphone off (CALL-01). */
  joinMuted: boolean;
  devices: CallDevices;
  /**
   * Whether this device has been asked which microphone and camera to use,
   * or chose one in settings, so a join no longer asks.
   */
  devicesChecked: boolean;
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
}

const KEY = "call-preferences";
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
  const write = (
    joinMuted: boolean,
    devices: CallDevices,
    devicesChecked: boolean,
  ): Promise<boolean> => {
    // Another choice is being kept, so this one is not.
    if (store.getState().saving) return initialization.then(() => false);
    // An explicit acknowledged choice supersedes every older preference read.
    const version = ++loadVersion;
    const known = store.getState().loaded;
    store.setState({ saving: true, error: null });
    const writing = Promise.resolve()
      .then(() =>
        platform.storage.set(KEY, {
          joinMuted,
          ...devices,
          ...(devicesChecked ? { devicesChecked } : {}),
        }),
      )
      .then(() => {
        if (version === loadVersion)
          store.setState({ joinMuted, devices, devicesChecked, loaded: true, unreadable: false });
        return true;
      })
      .catch(() => {
        if (version === loadVersion)
          store.setState({
            loaded: true,
            unreadable: !known || store.getState().unreadable,
            error: "Could not save this preference. Please try again.",
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
    checkingDevices: false,
    loaded: false,
    saving: false,
    error: null,
    unreadable: false,
    setJoinMuted: (joinMuted) => {
      const { devices, devicesChecked } = store.getState();
      return write(joinMuted, devices, devicesChecked);
    },
    setDevices: (patch) => {
      const { joinMuted, devices, devicesChecked } = store.getState();
      // Choosing a microphone or camera in settings answers the question too.
      const chose = "microphoneId" in patch || "cameraId" in patch;
      return write(joinMuted, devicesOf({ ...devices, ...patch }), devicesChecked || chose);
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
      });
    },
    finishDeviceCheck: (choice) => {
      const waiting = answer;
      answer = null;
      store.setState({ checkingDevices: false });
      if (choice) {
        const { joinMuted, devices } = store.getState();
        void write(joinMuted, devicesOf({ ...devices, ...choice }), true);
      }
      waiting?.(choice);
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
      .then((saved) => {
        if (version !== loadVersion) return;
        if (
          saved !== null &&
          (typeof saved !== "object" ||
            Array.isArray(saved) ||
            typeof (saved as { joinMuted?: unknown }).joinMuted !== "boolean")
        )
          throw new Error("Unreadable call preferences");
        store.setState({
          joinMuted: saved !== null && (saved as { joinMuted: boolean }).joinMuted,
          devices: saved === null ? {} : devicesOf(saved as Record<string, unknown>),
          devicesChecked: (saved as { devicesChecked?: unknown } | null)?.devicesChecked === true,
          loaded: true,
          unreadable: false,
        });
      })
      .catch(() => {
        if (version !== loadVersion) return;
        store.setState({
          joinMuted: true,
          devices: {},
          loaded: true,
          unreadable: true,
          error: "Could not load your preference. Huddles start with the microphone off.",
        });
      });
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
