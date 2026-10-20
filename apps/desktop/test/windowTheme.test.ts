import { describe, expect, it } from "vitest";
import { WINDOW_COLOURS, windowColours } from "../src/main/windowTheme.js";

describe("the window's colours", () => {
  it("follow a theme chosen on this device, whatever the system prefers", () => {
    expect(windowColours({ theme: "light", density: "compact" }, true)).toBe(WINDOW_COLOURS.light);
    expect(windowColours({ theme: "dark", density: "comfortable" }, false)).toBe(
      WINDOW_COLOURS.dark,
    );
  });

  it("put the old high-contrast theme on Onyx, as the renderer does", () => {
    expect(windowColours({ theme: "contrast" }, false)).toBe(WINDOW_COLOURS.dark);
  });

  it("follow the system for its own choice, nothing saved, or anything else", () => {
    for (const saved of [{ theme: "system" }, null, undefined, "light", { theme: "sepia" }]) {
      expect(windowColours(saved, true)).toBe(WINDOW_COLOURS.dark);
      expect(windowColours(saved, false)).toBe(WINDOW_COLOURS.light);
    }
  });
});
