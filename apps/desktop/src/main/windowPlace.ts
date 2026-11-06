/**
 * Where the window was: its size and place on the screen, and whether it
 * filled the screen, kept in settings so the next launch opens it there.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowPlace {
  bounds: Rect;
  maximized: boolean;
}

/** The setting the place is kept under. */
export const WINDOW_PLACE_KEY = "windowPlace";

export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 820 } as const;
export const MIN_WINDOW_SIZE = { width: 760, height: 480 } as const;

/** How much of the title bar must be on a screen for the window to be reachable there. */
const REACHABLE = { width: 120, height: 20, titleBar: 40 } as const;

const isWhole = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e6;

function readPlace(saved: unknown): WindowPlace | null {
  if (typeof saved !== "object" || saved === null) return null;
  const { bounds, maximized } = saved as { bounds?: unknown; maximized?: unknown };
  if (typeof bounds !== "object" || bounds === null) return null;
  const { x, y, width, height } = bounds as Record<string, unknown>;
  if (![x, y, width, height].every(isWhole)) return null;
  if ((width as number) <= 0 || (height as number) <= 0) return null;
  return {
    bounds: {
      x: Math.round(x as number),
      y: Math.round(y as number),
      width: Math.round(width as number),
      height: Math.round(height as number),
    },
    maximized: maximized === true,
  };
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/** What to keep: the size and place the window has when it is not maximized. */
export function placeToSave(normalBounds: Rect, maximized: boolean): WindowPlace {
  return {
    bounds: {
      x: Math.round(normalBounds.x),
      y: Math.round(normalBounds.y),
      width: Math.round(normalBounds.width),
      height: Math.round(normalBounds.height),
    },
    maximized,
  };
}

/**
 * Where to open the window, given what was saved and the work areas of the
 * screens there are now, the main screen first. The saved place is used when
 * enough of its title bar is on one of them to drag it by, moved and shrunk to
 * fit that screen; otherwise, as when the screen it was on is unplugged, the
 * window opens centred (no x and y) at a size the main screen can show.
 */
export function placeToOpen(
  saved: unknown,
  workAreas: readonly Rect[],
): { bounds: { x?: number; y?: number; width: number; height: number }; maximized: boolean } {
  const place = readPlace(saved);
  const fitTo = (size: { width: number; height: number }, area: Rect | undefined) => ({
    width: clamp(size.width, MIN_WINDOW_SIZE.width, area?.width ?? size.width),
    height: clamp(size.height, MIN_WINDOW_SIZE.height, area?.height ?? size.height),
  });
  if (!place) return { bounds: fitTo(DEFAULT_WINDOW_SIZE, workAreas[0]), maximized: false };
  const { bounds } = place;
  const titleBar = { ...bounds, height: REACHABLE.titleBar };
  const screen = workAreas.find((area) => {
    const shared = overlap(titleBar, area);
    return (
      shared.width >= Math.min(REACHABLE.width, bounds.width) && shared.height >= REACHABLE.height
    );
  });
  if (!screen) return { bounds: fitTo(bounds, workAreas[0]), maximized: place.maximized };
  const size = fitTo(bounds, screen);
  return {
    bounds: {
      x: clamp(bounds.x, screen.x, screen.x + screen.width - size.width),
      y: clamp(bounds.y, screen.y, screen.y + screen.height - size.height),
      ...size,
    },
    maximized: place.maximized,
  };
}
