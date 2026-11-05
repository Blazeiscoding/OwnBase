import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FOCUSED_VIEW_KEY,
  clearFocusedView,
  focusedElsewhere,
  inOneWindow,
  writeFocusedView,
} from "../src/lib/focusedView.js";

/** Where the focused window of a browser looks, as its other windows read it. */
const account = "http://127.0.0.1:9 U_SAM";
const view = {
  account,
  channelId: "C_GENERAL",
  threadRootId: null,
  channelVisible: true,
  threadVisible: true,
};

/** Web Locks as a browser grants them: one holder per name, `ifAvailable` answered at once. */
function fakeLocks(): LockManager {
  const held = new Set<string>();
  return {
    request: async (
      name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => Promise<void>,
    ) => {
      // A browser grants a lock later, never inside the call that asks.
      await Promise.resolve();
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name, mode: "exclusive" } as Lock);
      } finally {
        held.delete(name);
      }
    },
    query: async () => ({}),
  } as unknown as LockManager;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => localStorage.removeItem(FOCUSED_VIEW_KEY));

describe("the focused window's record", () => {
  it("is read by other windows of the same account only, while fresh", () => {
    const now = Date.now();
    writeFocusedView(view, "W_OTHER", now);
    expect(focusedElsewhere(account, "W_THIS", now)).toMatchObject({ channelId: "C_GENERAL" });
    expect(focusedElsewhere(account, "W_OTHER", now)).toBeNull();
    expect(focusedElsewhere("http://127.0.0.1:9 U_PRIYA", "W_THIS", now)).toBeNull();
    expect(focusedElsewhere(null, "W_THIS", now)).toBeNull();
    // Left by a window that closed without saying.
    expect(focusedElsewhere(account, "W_THIS", now + 5 * 60_000)).toBeNull();
  });

  it("is taken back only by the window that wrote it", () => {
    writeFocusedView(view, "W_OTHER");
    clearFocusedView("W_THIS");
    expect(localStorage.getItem(FOCUSED_VIEW_KEY)).not.toBeNull();
    clearFocusedView("W_OTHER");
    expect(localStorage.getItem(FOCUSED_VIEW_KEY)).toBeNull();
  });

  it("reads nothing from a record that is not one", () => {
    localStorage.setItem(FOCUSED_VIEW_KEY, "{not json");
    expect(focusedElsewhere(account, "W_THIS")).toBeNull();
    localStorage.setItem(FOCUSED_VIEW_KEY, JSON.stringify({ window: 3 }));
    expect(focusedElsewhere(account, "W_THIS")).toBeNull();
  });
});

describe("doing something in one window", () => {
  it("does it in one of several windows in the background, and stops it", async () => {
    const locks = fakeLocks();
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    const first = inOneWindow(account, "ring", start, locks);
    const second = inOneWindow(account, "ring", start, locks);
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
    second();
    first();
    await settle();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("leaves it to another window of the account that has focus", async () => {
    writeFocusedView(view, "W_OTHER");
    const start = vi.fn(() => () => {});
    inOneWindow(account, "ring", start, fakeLocks())();
    await settle();
    expect(start).not.toHaveBeenCalled();
  });

  it("does it in every window where the browser has no locks (plain http)", () => {
    const start = vi.fn(() => () => {});
    inOneWindow(account, "ring", start, undefined);
    inOneWindow(account, "ring", start, undefined);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("never starts what was stopped before its turn came", async () => {
    const start = vi.fn(() => () => {});
    inOneWindow(account, "ring", start, fakeLocks())();
    await settle();
    expect(start).not.toHaveBeenCalled();
  });
});
