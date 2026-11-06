import { describe, expect, it } from "vitest";
import {
  ZOOM_LIMITS,
  nextZoomLevel,
  savedZoomLevel,
  zoomStep,
  type KeyInput,
} from "../src/main/zoomKeys.js";

const key = (key: string, code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  type: "keyDown",
  key,
  code,
  control: true,
  meta: false,
  alt: false,
  ...mods,
});

describe("zoom keys", () => {
  it("zoom in for Ctrl and =, with or without Shift, and the number pad's +", () => {
    expect(zoomStep(key("=", "Equal"), "win32")).toBe("in");
    expect(zoomStep(key("+", "Equal"), "win32")).toBe("in");
    expect(zoomStep(key("+", "NumpadAdd"), "linux")).toBe("in");
  });

  it("zoom out for Ctrl and -, and back to the usual size for Ctrl and 0", () => {
    expect(zoomStep(key("-", "Minus"), "win32")).toBe("out");
    expect(zoomStep(key("-", "NumpadSubtract"), "win32")).toBe("out");
    expect(zoomStep(key("0", "Digit0"), "win32")).toBe("reset");
    expect(zoomStep(key("0", "Numpad0"), "win32")).toBe("reset");
  });

  it("use Cmd on a Mac, and leave every other key alone", () => {
    expect(zoomStep(key("=", "Equal", { control: false, meta: true }), "darwin")).toBe("in");
    expect(zoomStep(key("=", "Equal"), "darwin")).toBeNull();
    expect(zoomStep(key("=", "Equal", { control: false }), "win32")).toBeNull();
    expect(zoomStep(key("=", "Equal", { alt: true }), "win32")).toBeNull();
    expect(zoomStep(key("=", "Equal", { type: "keyUp" }), "win32")).toBeNull();
    expect(zoomStep(key("1", "Digit1"), "win32")).toBeNull();
    expect(zoomStep(key("k", "KeyK"), "win32")).toBeNull();
  });

  it("step 20% at a time, within a browser's limits", () => {
    expect(nextZoomLevel(0, "in")).toBe(0.5);
    expect(nextZoomLevel(0.5, "out")).toBe(0);
    expect(nextZoomLevel(2, "reset")).toBe(0);
    expect(nextZoomLevel(ZOOM_LIMITS.max, "in")).toBe(ZOOM_LIMITS.max);
    expect(nextZoomLevel(ZOOM_LIMITS.min, "out")).toBe(ZOOM_LIMITS.min);
  });

  it("open at the zoom kept, or the usual size for anything unusable", () => {
    expect(savedZoomLevel(1.5)).toBe(1.5);
    for (const value of [null, "2", Number.NaN, 99, -99]) expect(savedZoomLevel(value)).toBe(0);
  });
});
