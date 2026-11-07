import { describe, expect, it } from "vitest";
import { WINDOW_COLOURS, themeOfAppearance, windowColours } from "../src/main/windowTheme.js";

describe("the window's colours", () => {
  it("follow a theme chosen on this device, whatever the system prefers", () => {
    expect(windowColours("light", true)).toBe(WINDOW_COLOURS.light);
    expect(windowColours("dark", false)).toBe(WINDOW_COLOURS.dark);
  });

  it("follow the system for its own choice", () => {
    expect(windowColours("system", true)).toBe(WINDOW_COLOURS.dark);
    expect(windowColours("system", false)).toBe(WINDOW_COLOURS.light);
  });
});

describe("the theme in an appearance the page saved before telling the window", () => {
  it("is read as the page reads it", () => {
    expect(themeOfAppearance({ theme: "light", density: "compact" })).toBe("light");
    expect(themeOfAppearance({ theme: "dark" })).toBe("dark");
    expect(themeOfAppearance({ theme: "contrast" })).toBe("dark");
    for (const saved of [{ theme: "system" }, null, undefined, "light", { theme: "sepia" }])
      expect(themeOfAppearance(saved)).toBe("system");
  });
});
