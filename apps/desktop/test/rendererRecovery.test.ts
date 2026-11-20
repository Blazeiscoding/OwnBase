import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlaceCheckpoint,
  RendererRecovery,
  isRendererLoadFailure,
} from "../src/main/rendererRecovery.js";
import { rendererUrlTrust } from "../src/main/ipcBoundary.js";

/** When the window's page dies or fails to load (REV-09). */
describe("recovering the window's page", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reloads three times in a minute, then asks instead of reloading forever", () => {
    const recovery = new RendererRecovery();
    const steps = Array.from({ length: 5 }, () => {
      vi.advanceTimersByTime(1_000);
      return recovery.failed();
    });
    expect(steps).toEqual(["reload", "reload", "reload", "ask", "ask"]);
  });

  it("counts only the last minute's failures, so a page that fails now and then always comes back", () => {
    const recovery = new RendererRecovery();
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(30_000);
      expect(recovery.failed()).toBe("reload");
    }
  });

  it("starts counting again when someone chooses to try again", () => {
    const recovery = new RendererRecovery();
    for (let i = 0; i < 4; i++) recovery.failed();
    expect(recovery.failed()).toBe("ask");
    recovery.reset();
    expect(recovery.failed()).toBe("reload");
  });

  it("recovers from the page failing to load, not from a frame or a replaced navigation", () => {
    expect(isRendererLoadFailure(-6, true)).toBe(true); // ERR_FILE_NOT_FOUND
    expect(isRendererLoadFailure(-102, true)).toBe(true); // ERR_CONNECTION_REFUSED (dev server)
    expect(isRendererLoadFailure(-3, true)).toBe(false); // ERR_ABORTED
    expect(isRendererLoadFailure(-6, false)).toBe(false);
  });
});

/** Where the page was, for recovery to return to (F08). */
describe("the page's place across a recovery", () => {
  const PAGE = "file:///opt/OwnBase/resources/app.asar/out/renderer/index.html";
  const trusted = rendererUrlTrust(PAGE);
  const saved = {
    ownbase: { server: "http://10.0.0.5:8543", channelId: "C1", threadRootId: null, view: "saved" },
  };

  it("hands the last place back once, to the page a recovery loads", () => {
    const place = new PlaceCheckpoint(trusted);
    expect(place.remember(`${PAGE}#/c/C1/p/saved`, saved)).toBe(true);
    expect(place.take()).toBe(null);
    expect(place.recover()).toBe(`${PAGE}#/c/C1/p/saved`);
    expect(place.take()).toEqual(saved);
    expect(place.take()).toBe(null);
    // Try again after the dialog returns to the same place.
    expect(place.recover()).toBe(`${PAGE}#/c/C1/p/saved`);
    expect(place.take()).toEqual(saved);
  });

  it("starts from nowhere once asked to open from the start", () => {
    const place = new PlaceCheckpoint(trusted);
    place.remember(`${PAGE}#/c/C1/p/saved`, saved);
    place.recover();
    place.forget();
    expect(place.take()).toBe(null);
    expect(place.recover()).toBe(null);
  });

  it("knows no place before the page reports one", () => {
    const place = new PlaceCheckpoint(trusted);
    expect(place.recover()).toBe(null);
    expect(place.take()).toBe(null);
  });

  it("takes only the app's own page, and only a small plain value", () => {
    const place = new PlaceCheckpoint(trusted);
    expect(place.remember("about:blank", saved)).toBe(false);
    expect(place.remember("https://example.com/", saved)).toBe(false);
    expect(place.remember(42, saved)).toBe(false);
    expect(place.remember(PAGE, { big: "x".repeat(33 * 1024) })).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(place.remember(PAGE, cycle)).toBe(false);
    expect(place.recover()).toBe(null);
    // Up to 32 KiB is small enough.
    expect(place.remember(PAGE, { big: "x".repeat(32 * 1024 - 20) })).toBe(true);
  });
});
