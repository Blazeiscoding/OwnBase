import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";

interface Preferences {
  enterSends: boolean;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  /** The saved choice is there but could not be read; `retry` reads it again. */
  unread: boolean;
  /** Resolves true once the choice is kept. */
  setEnterSends: (value: boolean) => Promise<boolean>;
  retry: () => Promise<void>;
}

const KEY = "composer-preferences";
const stores = new WeakMap<Platform, ReturnType<typeof createPreferences>>();

function createPreferences(platform: Platform) {
  const store = createStore<Preferences>(() => ({
    // Until storage answers, Enter is a new line rather than an accidental send.
    enterSends: false,
    loaded: false,
    saving: false,
    error: null,
    unread: false,
    setEnterSends: async (enterSends) => {
      if (!store.getState().loaded || store.getState().saving) return false;
      store.setState({ saving: true, error: null });
      try {
        await platform.storage.set(KEY, { enterSends });
        store.setState({ enterSends, unread: false });
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
        unread: false,
      });
    } catch {
      store.setState({
        enterSends: false,
        loaded: true,
        unread: true,
        error: "Could not load your preference. Enter inserts a new line until you choose again.",
      });
    }
  }
  store.setState({ retry: load });
  void load();
  return store;
}

/** Shared by every composer on this device, using the browser or desktop storage adapter. */
export function useComposerPreferences() {
  const platform = usePlatform();
  let store = stores.get(platform);
  if (!store) {
    store = createPreferences(platform);
    stores.set(platform, store);
  }
  return useStore(store);
}
