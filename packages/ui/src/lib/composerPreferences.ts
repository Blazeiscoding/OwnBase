import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";
import { perDevice } from "./perDevice.js";

interface Preferences {
  enterSends: boolean;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  /** The saved choice is there but could not be read; `retry` reads it again. */
  unreadable: boolean;
  /** Resolves true once the choice is kept. */
  setEnterSends: (value: boolean) => Promise<boolean>;
  retry: () => Promise<void>;
}

const KEY = "composer-preferences";

function createPreferences(platform: Platform) {
  const store = createStore<Preferences>(() => ({
    // Until storage answers, Enter is a new line rather than an accidental send.
    enterSends: false,
    loaded: false,
    saving: false,
    error: null,
    unreadable: false,
    setEnterSends: async (enterSends) => {
      if (!store.getState().loaded || store.getState().saving) return false;
      store.setState({ saving: true, error: null });
      try {
        await platform.storage.set(KEY, { enterSends });
        store.setState({ enterSends, unreadable: false });
        return true;
      } catch {
        store.setState({ error: "Could not save this preference. Please try again." });
        return false;
      } finally {
        store.setState({ saving: false });
      }
    },
    retry: async () => {},
  }));
  /**
   * A choice that cannot be read is not a choice never made. Read as absent,
   * a saved "new line" became the first-use default, and Enter sent a message
   * still being written (Q04). So the read is strict, what it gives back is
   * checked, and until it can be read Enter stays a new line.
   */
  async function load() {
    try {
      const saved = await platform.storage.get<{ enterSends?: unknown }>(KEY, { strict: true });
      const choice = saved?.enterSends;
      if (saved !== null && typeof choice !== "boolean") throw new Error("unreadable");
      store.setState({
        enterSends: typeof choice === "boolean" ? choice : true,
        loaded: true,
        error: null,
        unreadable: false,
      });
    } catch {
      store.setState({
        enterSends: false,
        loaded: true,
        unreadable: true,
        error:
          "Could not load your choice for Enter. Enter starts a new line until you choose again.",
      });
    }
  }
  store.setState({ retry: load });
  void load();
  return store;
}

const preferencesOf = perDevice(createPreferences);

/** Shared by every composer on this device, using the browser or desktop storage adapter. */
export function useComposerPreferences() {
  return useStore(preferencesOf(usePlatform()));
}
