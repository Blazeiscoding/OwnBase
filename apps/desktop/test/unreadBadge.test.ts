import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnreadIndicator, type UnreadSurfaces } from "../src/main/unreadBadge.js";

function surfaces(platform: NodeJS.Platform = "win32") {
  const overlay: (string | null)[] = [];
  const descriptions: string[] = [];
  const dock: string[] = [];
  const tray: boolean[] = [];
  const s: UnreadSurfaces = {
    platform,
    overlay: (file, description) => {
      overlay.push(file);
      descriptions.push(description);
    },
    dock: (text) => dock.push(text),
    tray: (unread) => tray.push(unread),
  };
  return { s, overlay, descriptions, dock, tray };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("what waits, on the taskbar button and the tray", () => {
  it("puts the count's circle on the taskbar button, and a dot on the tray", () => {
    const { s, overlay, descriptions, tray } = surfaces();
    new UnreadIndicator(s).set({ count: 3, dot: false });
    expect(overlay).toEqual(["badge-3.png"]);
    expect(descriptions).toEqual(["3 unread mentions"]);
    expect(tray).toEqual([true]);
  });

  it("says 9+ past nine, and a dot for unread without a mention", () => {
    const { s, overlay, descriptions } = surfaces();
    const indicator = new UnreadIndicator(s);
    for (const count of [9, 10, 12]) {
      indicator.set({ count, dot: false });
      vi.advanceTimersByTime(250);
    }
    indicator.set({ count: 0, dot: true });
    vi.advanceTimersByTime(250);
    expect(overlay).toEqual(["badge-9.png", "badge-9plus.png", "badge-9plus.png", "badge-dot.png"]);
    expect(descriptions).toEqual([
      "9 unread mentions",
      "10 unread mentions",
      "12 unread mentions",
      "Unread messages",
    ]);
  });

  it("has a picture in the app for every overlay it puts up", () => {
    const { s, overlay } = surfaces();
    const indicator = new UnreadIndicator(s);
    for (let count = 0; count <= 100; count++) {
      indicator.set({ count, dot: count % 2 === 0 });
      vi.advanceTimersByTime(250);
    }
    const shown = new Set(overlay.filter((file): file is string => file !== null));
    expect(shown.size).toBe(11);
    for (const file of shown)
      expect(existsSync(new URL(`../build/${file}`, import.meta.url)), file).toBe(true);
  });

  it("takes the overlay off and gives the tray its own icon back at zero", () => {
    const { s, overlay, tray } = surfaces();
    const indicator = new UnreadIndicator(s);
    indicator.set({ count: 1, dot: false });
    vi.advanceTimersByTime(250);
    indicator.set({ count: 0, dot: false });
    vi.advanceTimersByTime(250);
    expect(overlay).toEqual(["badge-1.png", null]);
    expect(tray).toEqual([true, false]);
  });

  it("updates once in 250 ms however fast the counts change, ending on the last", () => {
    const { s, overlay } = surfaces();
    const indicator = new UnreadIndicator(s);
    indicator.set({ count: 1, dot: false });
    indicator.set({ count: 2, dot: false });
    indicator.set({ count: 3, dot: false });
    expect(overlay).toEqual(["badge-1.png"]);
    vi.advanceTimersByTime(250);
    expect(overlay).toEqual(["badge-1.png", "badge-3.png"]);
    // The same again changes nothing.
    indicator.set({ count: 3, dot: false });
    vi.advanceTimersByTime(1000);
    expect(overlay).toHaveLength(2);
  });

  it("clears everything when the app quits, at once", () => {
    const { s, overlay, tray } = surfaces();
    const indicator = new UnreadIndicator(s);
    indicator.set({ count: 2, dot: false });
    indicator.set({ count: 5, dot: false });
    indicator.clear();
    expect(overlay.at(-1)).toBeNull();
    expect(tray.at(-1)).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(overlay.at(-1)).toBeNull();
  });

  it("puts it back on a window made again, as after closing to the tray", () => {
    const { s, overlay } = surfaces();
    const indicator = new UnreadIndicator(s);
    indicator.set({ count: 4, dot: false });
    indicator.reapply();
    expect(overlay).toEqual(["badge-4.png", "badge-4.png"]);
  });
});

describe("on a Mac", () => {
  it("badges the dock with the count or a dot, and touches no taskbar overlay", () => {
    const { s, overlay, dock } = surfaces("darwin");
    const indicator = new UnreadIndicator(s);
    indicator.set({ count: 3, dot: false });
    vi.advanceTimersByTime(250);
    indicator.set({ count: 0, dot: true });
    vi.advanceTimersByTime(250);
    indicator.set({ count: 0, dot: false });
    vi.advanceTimersByTime(250);
    expect(dock).toEqual(["3", "•", ""]);
    expect(overlay).toEqual([]);
  });
});

describe("what the page may send", () => {
  it("is read as numbers, and anything else as nothing", async () => {
    const { readUnread } = await import("../src/main/unreadBadge.js");
    expect(readUnread({ count: 3, dot: false })).toEqual({ count: 3, dot: false });
    expect(readUnread({ count: -1, dot: "yes" })).toEqual({ count: 0, dot: false });
    expect(readUnread({ count: 2.5, dot: true })).toEqual({ count: 2, dot: true });
    expect(readUnread(null)).toEqual({ count: 0, dot: false });
  });
});
