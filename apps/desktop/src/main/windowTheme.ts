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

/**
 * The colours for the appearance the renderer saved (its "appearance"
 * setting, `{ theme, density }`), read as the renderer reads it: White and
 * Onyx as chosen, the old high-contrast theme as Onyx, and anything else,
 * nothing saved included, as the system's choice.
 */
export function windowColours(saved: unknown, systemDark: boolean): WindowColours {
  const theme =
    typeof saved === "object" && saved !== null ? (saved as { theme?: unknown }).theme : null;
  const dark = theme === "dark" || theme === "contrast" || (theme !== "light" && systemDark);
  return WINDOW_COLOURS[dark ? "dark" : "light"];
}
