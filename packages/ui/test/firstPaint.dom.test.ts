import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_PAINT_KEY } from "../src/lib/appearance.js";

/**
 * `first-paint.js`, which each app's page runs from <head> before anything is
 * drawn: the theme kept by appearance.ts, on the document at once.
 */
const apps = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps");
const scripts = {
  web: resolve(apps, "web/public/first-paint.js"),
  desktop: resolve(apps, "desktop/src/renderer/public/first-paint.js"),
};
const pages = {
  web: resolve(apps, "web/index.html"),
  desktop: resolve(apps, "desktop/src/renderer/index.html"),
};
const source = readFileSync(scripts.web, "utf8");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.removeItem(FIRST_PAINT_KEY);
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-density");
  for (const bar of document.head.querySelectorAll('meta[name="theme-color"]')) bar.remove();
});

/** Runs the script on this document, as the page's <head> does, and says what it left. */
function firstPaint(kept?: string) {
  if (kept !== undefined) localStorage.setItem(FIRST_PAINT_KEY, kept);
  for (const old of document.head.querySelectorAll('meta[name="theme-color"]')) old.remove();
  const bar = document.createElement("meta");
  bar.name = "theme-color";
  bar.content = "#111115";
  document.head.append(bar);
  new Function(source)();
  const root = document.documentElement;
  return {
    theme: root.getAttribute("data-theme"),
    density: root.getAttribute("data-density"),
    bar: bar.content,
  };
}

describe("the page's first paint", () => {
  it("is the same script in both apps", () => {
    expect(readFileSync(scripts.desktop, "utf8")).toBe(source);
  });

  it("runs in each page's head, before the app and after the bar colour it changes", () => {
    for (const page of Object.values(pages)) {
      const html = readFileSync(page, "utf8");
      const head = html.slice(0, html.indexOf("</head>"));
      // A classic script, so it runs before the page is drawn rather than after it is parsed.
      expect(head).toContain('<script src="/first-paint.js"></script>');
      expect(head.indexOf('name="theme-color"')).toBeLessThan(head.indexOf("first-paint.js"));
      expect(html.indexOf("first-paint.js")).toBeLessThan(html.indexOf('type="module"'));
    }
  });

  it("puts the kept theme and density on the page", () => {
    expect(firstPaint(JSON.stringify({ theme: "light", density: "compact" }))).toEqual({
      theme: "light",
      density: "compact",
      bar: "#e9e9ec",
    });
  });

  it("keeps Onyx's bar for Onyx", () => {
    expect(firstPaint(JSON.stringify({ theme: "dark", density: "comfortable" }))).toEqual({
      theme: "dark",
      density: "comfortable",
      bar: "#111115",
    });
  });

  it("follows the device when nothing is kept, so a light device is not painted Onyx first", () => {
    expect(firstPaint()).toMatchObject({ theme: "system", density: "comfortable" });
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query === "(prefers-color-scheme: light)" })),
    );
    expect(firstPaint().bar).toBe("#e9e9ec");
  });

  it("follows the device, without throwing, when what is kept cannot be read", () => {
    expect(firstPaint("{not json")).toMatchObject({ theme: "system", density: "comfortable" });
    expect(firstPaint(JSON.stringify({ theme: "sepia", density: 3 }))).toMatchObject({
      theme: "system",
      density: "comfortable",
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(firstPaint()).toMatchObject({ theme: "system", density: "comfortable" });
  });
});
