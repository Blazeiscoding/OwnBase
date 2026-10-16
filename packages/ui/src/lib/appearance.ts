import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";

/**
 * Onyx ("dark") and White ("light"); "system" follows what the device
 * prefers, and is where a device starts. More themes are to come; the
 * high-contrast one that was here folds into Onyx until then.
 */
export const THEMES = ["system", "dark", "light"] as const;
export type Theme = (typeof THEMES)[number];
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

interface Appearance {
  theme: Theme;
  density: Density;
  loaded: boolean;
  error: string | null;
  /** Resolves true once the choice is kept, false when it could not be and was put back. */
  set: (change: Partial<Pick<Appearance, "theme" | "density">>) => Promise<boolean>;
}

const KEY = "appearance";
const stores = new WeakMap<Platform, ReturnType<typeof createAppearance>>();

function createAppearance(platform: Platform) {
  const store = createStore<Appearance>(() => ({
    // A device starts where its owner already said they want to be.
    theme: "system",
    density: "comfortable",
    loaded: false,
    error: null,
    set: async (change) => {
      const before = store.getState();
      const next = {
        theme: change.theme ?? before.theme,
        density: change.density ?? before.density,
      };
      // Shown at once, so choosing feels like choosing; put back if it cannot be kept.
      store.setState({ ...next, error: null });
      try {
        await platform.storage.set(KEY, next);
        return true;
      } catch {
        store.setState({
          theme: before.theme,
          density: before.density,
          error: "Could not save how Tandem looks on this device. Please try again.",
        });
        return false;
      }
    },
  }));
  void platform.storage
    .get<{ theme?: unknown; density?: unknown }>(KEY)
    .then((saved) => {
      store.setState({
        theme: (THEMES as readonly unknown[]).includes(saved?.theme)
          ? (saved!.theme as Theme)
          : // The high-contrast theme folded into Onyx; with nothing saved, or a
            // theme that no longer exists, follow the device.
            saved?.theme === "contrast"
            ? "dark"
            : "system",
        density: (DENSITIES as readonly unknown[]).includes(saved?.density)
          ? (saved!.density as Density)
          : "comfortable",
        loaded: true,
      });
    })
    .catch(() => store.setState({ loaded: true }));
  return store;
}

/** How Tandem looks on this device, across workspaces. */
export function useAppearance() {
  const platform = usePlatform();
  let store = stores.get(platform);
  if (!store) {
    store = createAppearance(platform);
    stores.set(platform, store);
  }
  return useStore(store);
}

/**
 * Puts the chosen theme and density on the document, where theme.css reads
 * them. Mounted once, at the top of the app, so every screen follows.
 */
export function useApplyAppearance(): void {
  const { theme, density } = useAppearance();
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.density = density;
  }, [theme, density]);
}
