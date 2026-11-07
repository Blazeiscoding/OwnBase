import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW_SIZE, placeToOpen, placeToSave } from "../src/main/windowPlace.js";

const main = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 2560, height: 1400 };

describe("where the window opens", () => {
  it("opens where it was left, at the size it had", () => {
    const saved = placeToSave({ x: 100, y: 80, width: 1000, height: 700 }, false);
    expect(placeToOpen(saved, [main])).toEqual({
      bounds: { x: 100, y: 80, width: 1000, height: 700 },
      maximized: false,
    });
  });

  it("opens maximized when it was, over the place it had before", () => {
    const saved = placeToSave({ x: 2000, y: 50, width: 1200, height: 900 }, true);
    expect(placeToOpen(saved, [main, right])).toEqual({
      bounds: { x: 2000, y: 50, width: 1200, height: 900 },
      maximized: true,
    });
  });

  it("opens centred on the main screen when its screen is gone", () => {
    const saved = placeToSave({ x: 2000, y: 50, width: 1200, height: 900 }, false);
    expect(placeToOpen(saved, [main])).toEqual({
      bounds: { width: 1200, height: 900 },
      maximized: false,
    });
  });

  it("is pulled back onto the screen its title bar is on, and shrunk to fit it", () => {
    const saved = placeToSave({ x: 1700, y: -10, width: 2400, height: 1300 }, false);
    expect(placeToOpen(saved, [main])).toEqual({
      bounds: { x: 0, y: 0, width: 1920, height: 1040 },
      maximized: false,
    });
  });

  it("does not open where only a sliver of its title bar could be grabbed", () => {
    const saved = placeToSave({ x: 1850, y: 100, width: 1000, height: 700 }, false);
    expect(placeToOpen(saved, [main]).bounds).toEqual({ width: 1000, height: 700 });
  });

  it("opens at the usual size when nothing usable was saved", () => {
    for (const saved of [
      null,
      "big",
      { bounds: { x: 1, y: 2, width: "wide", height: 700 } },
      { bounds: { x: 1, y: 2, width: 0, height: 700 } },
      { bounds: { x: Number.NaN, y: 2, width: 900, height: 700 } },
    ])
      expect(placeToOpen(saved, [main])).toEqual({
        bounds: { ...DEFAULT_WINDOW_SIZE },
        maximized: false,
      });
  });

  it("never opens smaller than the window may be, nor larger than a small screen", () => {
    const small = { x: 0, y: 0, width: 1024, height: 700 };
    expect(placeToOpen(null, [small]).bounds).toEqual({ width: 1024, height: 700 });
    const tiny = placeToSave({ x: 10, y: 10, width: 200, height: 100 }, false);
    expect(placeToOpen(tiny, [main]).bounds).toEqual({ x: 10, y: 10, width: 760, height: 480 });
  });
});
