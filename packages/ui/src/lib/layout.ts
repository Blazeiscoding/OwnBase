/**
 * What theme.css lays out and moves by, for scripts that must follow it: the
 * same media queries as its @media rules, and the same motion as its tokens.
 * test/layout.test.ts holds the two to each other.
 */

/** A phone held upright: the bottom bar shows, and the sidebar is a drawer. */
export const PHONE_QUERY = "(max-width: 760px)";
/** The sidebar is a drawer: a phone, or a window too short for it, as a phone on its side. */
export const DRAWER_QUERY = "(max-width: 760px), (max-height: 480px)";
/** The sidebar beside the conversation: no drawer. */
export const WIDE_QUERY = "(min-width: 761px) and (min-height: 481px)";
/** A side panel covers the conversation rather than sitting beside it. */
export const NARROW_QUERY = "(max-width: 1023px)";
/** A screen nothing hovers over, a touchscreen: a long press stands in for a hover. */
export const TOUCH_QUERY = "(hover: none)";
/** A phone without a pointer: menus open as sheets. */
export const SHEET_QUERY = "(hover: none) and (max-width: 760px)";

/** Whether `query` matches now; false where there is no window to ask. */
export function screenMatches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
}

/** Whether the sidebar is a drawer now. */
export function drawerLayout(): boolean {
  return typeof window.matchMedia === "function" && !window.matchMedia(WIDE_QUERY).matches;
}

/** theme.css's --duration-fast, in milliseconds: a page, a tab, a dialog opening. */
export const DURATION_FAST_MS = 250;
/** theme.css's --ease-smooth: quick to start and long to settle. */
export const EASE_SMOOTH = "cubic-bezier(0.22, 1, 0.36, 1)";
