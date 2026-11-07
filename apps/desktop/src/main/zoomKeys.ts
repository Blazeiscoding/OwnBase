/**
 * Zooming the window from the keyboard, as a browser does: Ctrl and = or +
 * (on the main keys or the number pad) to zoom in, Ctrl and - to zoom out, and
 * Ctrl and 0 back to the usual size; Cmd on a Mac. Electron's own menu only
 * zooms in for Ctrl+Shift+=, which is not what anyone presses.
 */

export type ZoomStep = "in" | "out" | "reset";

/** The parts of Electron's before-input-event input read here. */
export interface KeyInput {
  type: string;
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
}

/** The setting the zoom is kept under, so the next launch opens at the same size. */
export const ZOOM_KEY = "zoomLevel";

/** Chromium's zoom levels: each step is 20% more or less, as in a browser. */
const STEP = 0.5;
export const ZOOM_LIMITS = { min: -3, max: 5 } as const;

export function zoomStep(input: KeyInput, platform: NodeJS.Platform): ZoomStep | null {
  if (input.type !== "keyDown" || input.alt) return null;
  if (!(platform === "darwin" ? input.meta : input.control)) return null;
  if (input.code === "NumpadAdd" || input.key === "=" || input.key === "+") return "in";
  if (input.code === "NumpadSubtract" || input.key === "-" || input.key === "_") return "out";
  if (input.code === "Digit0" || input.code === "Numpad0") return "reset";
  return null;
}

export function nextZoomLevel(current: number, step: ZoomStep): number {
  if (step === "reset") return 0;
  const next = current + (step === "in" ? STEP : -STEP);
  return Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, next));
}

/** A saved zoom level, or the usual size for anything else. */
export function savedZoomLevel(value: unknown): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= ZOOM_LIMITS.min &&
    value <= ZOOM_LIMITS.max
    ? value
    : 0;
}
