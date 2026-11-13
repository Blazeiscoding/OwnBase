import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";
import { perDevice } from "./perDevice.js";
import { useMediaQuery } from "./useMediaQuery.js";

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

/**
 * A copy of the choice in localStorage, which a page can read before it is
 * painted: `first-paint.js` in each app's public folder puts it on the
 * document from `<head>`, so a page whose chosen theme is not the device's
 * does not show the other one first. The choice itself stays in the
 * platform's storage; the copy follows it.
 *
 * Kept in localStorage itself, outside the device store and its "ownbase:"
 * names, where the choice is kept as "appearance".
 */
export const FIRST_PAINT_KEY = "ownbase-first-paint";

function firstPaintCopy(): { theme: Theme; density: Density } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(FIRST_PAINT_KEY) ?? "null") as {
      theme?: unknown;
      density?: unknown;
    } | null;
    if (!saved) return null;
    return {
      theme: (THEMES as readonly unknown[]).includes(saved.theme)
        ? (saved.theme as Theme)
        : "system",
      density: (DENSITIES as readonly unknown[]).includes(saved.density)
        ? (saved.density as Density)
        : "comfortable",
    };
  } catch {
    return null;
  }
}

function keepFirstPaintCopy(theme: Theme, density: Density): void {
  try {
    localStorage.setItem(FIRST_PAINT_KEY, JSON.stringify({ theme, density }));
  } catch {
    // Without it the next page paints the device's theme first, as before.
  }
}

function createAppearance(platform: Platform) {
  const copy = firstPaintCopy();
  const store = createStore<Appearance>(() => ({
    // A device starts where its owner already said they want to be: the copy
    // the page was first painted with, until the saved choice is read.
    theme: copy?.theme ?? "system",
    density: copy?.density ?? "comfortable",
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
          error: "Could not save how OwnBase looks on this device. Please try again.",
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

const appearanceOf = perDevice(createAppearance);

/** How OwnBase looks on this device, across workspaces. */
export function useAppearance() {
  return useStore(appearanceOf(usePlatform()));
}

/** The deep colour of Onyx and of White: the browser's own bars, and the desktop window. */
const BAR_COLOURS = { dark: "#111115", light: "#e9e9ec" } as const;

/**
 * Puts the chosen theme and density on the document, where theme.css reads
 * them, and keeps the copy the next page is first painted with. Mounted once,
 * at the top of the app, so every screen follows.
 */
export function useApplyAppearance(): void {
  const platform = usePlatform();
  const { theme, density, loaded } = useAppearance();
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.density = density;
    // Only what was read or chosen: before that, the store holds the copy itself.
    if (loaded) keepFirstPaintCopy(theme, density);
  }, [theme, density, loaded]);
  // The desktop window's own frame and title bar, painted before the page is.
  useEffect(() => {
    if (loaded) platform.setWindowTheme?.(theme);
  }, [platform, theme, loaded]);
  // The browser's bars around the page (a phone's, an installed app's) in the same theme.
  const shown = useShownTheme();
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = BAR_COLOURS[shown];
  }, [shown]);
}

/**
 * The theme on screen. "System" is Onyx unless the device asks for light, as
 * theme.css and first-paint.js read it: a device that states no preference
 * gets Onyx.
 */
export function useShownTheme(): "dark" | "light" {
  const { theme } = useAppearance();
  const prefersLight = useMediaQuery("(prefers-color-scheme: light)");
  return theme === "system" ? (prefersLight ? "light" : "dark") : theme;
}
