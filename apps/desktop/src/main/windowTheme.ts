import type { WindowTheme } from "../shared/bridge.js";

/**
 * The window's own colours: what it shows before the page paints, and the
 * title bar overlay that the system's window buttons are drawn on. Each is the
 * deep colour (and dim ink) of the theme the page is in, from
 * packages/ui/src/theme.css, so a window in White is not framed in Onyx.
 */
export const WINDOW_COLOURS = {
  dark: { background: "#111115", symbols: "#b9bac0" },
  light: { background: "#e9e9ec", symbols: "#4e4f57" },
} as const;

export type WindowColours = (typeof WINDOW_COLOURS)[keyof typeof WINDOW_COLOURS];

export function isWindowTheme(value: unknown): value is WindowTheme {
  return value === "system" || value === "dark" || value === "light";
}

/** The colours for the page's theme: White and Onyx as chosen, the system's otherwise. */
export function windowColours(theme: WindowTheme, systemDark: boolean): WindowColours {
  const dark = theme === "dark" || (theme !== "light" && systemDark);
  return WINDOW_COLOURS[dark ? "dark" : "light"];
}

/**
 * The theme in the appearance the page saved (`{ theme, density }`), read as
 * the page reads it, for a first start before the page has told the window
 * its theme: the old high-contrast theme as Onyx, anything else unknown as
 * the system's choice.
 */
export function themeOfAppearance(saved: unknown): WindowTheme {
  const theme =
    typeof saved === "object" && saved !== null ? (saved as { theme?: unknown }).theme : null;
  if (theme === "contrast") return "dark";
  return isWindowTheme(theme) ? theme : "system";
}
