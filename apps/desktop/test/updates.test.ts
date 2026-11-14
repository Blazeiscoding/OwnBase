import { describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "@ownbase/protocol/desktop";
import {
  CHECK_EVERY_MS,
  DAY_MS,
  HOUR_MS,
  IN_CALL,
  UPDATES_KEY,
  Updates,
  checkDue,
  compareVersions,
  isOffered,
  offerDue,
  restartAnswer,
  type UpdateDeps,
} from "../src/main/updates.js";

const due = (over: Partial<Parameters<typeof checkDue>[0]> = {}) =>
  checkDue({
    mode: "install",
    automatic: true,
    asked: false,
    checkedAt: null,
    ready: false,
    now: 10 * DAY_MS,
    ...over,
  });

describe("checkDue", () => {
  it("never looks in a build the Release workflow did not make", () => {
    expect(due({ mode: "none" })).toBe(false);
    expect(due({ mode: "none", asked: true })).toBe(false);
  });

  it("looks at start, then every four hours", () => {
    const now = 10 * DAY_MS;
    expect(due({ checkedAt: null })).toBe(true);
    expect(due({ checkedAt: now - CHECK_EVERY_MS + 1 })).toBe(false);
    expect(due({ checkedAt: now - CHECK_EVERY_MS })).toBe(true);
    expect(CHECK_EVERY_MS).toBe(4 * HOUR_MS);
  });

  it("waits a day once a version is downloaded", () => {
    const now = 10 * DAY_MS;
    expect(due({ ready: true, checkedAt: now - CHECK_EVERY_MS })).toBe(false);
    expect(due({ ready: true, checkedAt: now - DAY_MS })).toBe(true);
  });

  it("does not look with the setting off, unless the person asks", () => {
    expect(due({ automatic: false })).toBe(false);
    expect(due({ automatic: false, asked: true })).toBe(true);
  });

  it("looks on the Mac too, to say a version is out", () => {
    expect(due({ mode: "notify" })).toBe(true);
  });
});

describe("offerDue", () => {
  const now = 10 * DAY_MS;
  it("offers a version the first time it is ready", () => {
    expect(offerDue({ newVersion: "0.1.0-beta.34", lastOffer: null, now })).toBe(true);
    expect(offerDue({ newVersion: null, lastOffer: null, now })).toBe(false);
  });

  it("keeps offering the same version until it is put off", () => {
    const lastOffer = { version: "0.1.0-beta.34", at: now - HOUR_MS, putOff: false };
    expect(offerDue({ newVersion: "0.1.0-beta.34", lastOffer, now })).toBe(true);
  });

  it("brings a version put off back the next day", () => {
    const lastOffer = { version: "0.1.0-beta.34", at: now - HOUR_MS, putOff: true };
    expect(offerDue({ newVersion: "0.1.0-beta.34", lastOffer, now })).toBe(false);
    expect(offerDue({ newVersion: "0.1.0-beta.34", lastOffer, now: now + DAY_MS })).toBe(true);
  });

  it("offers at most one version a day", () => {
    const lastOffer = { version: "0.1.0-beta.34", at: now - HOUR_MS, putOff: false };
    expect(offerDue({ newVersion: "0.1.0-beta.35", lastOffer, now })).toBe(false);
    expect(offerDue({ newVersion: "0.1.0-beta.35", lastOffer, now: now + DAY_MS })).toBe(true);
  });
});

describe("restartAnswer", () => {
  it("refuses during a call, saying why", () => {
    const answer = restartAnswer({ inCall: true, hosting: { running: true } });
    expect(answer).toEqual({ kind: "refuse", reason: IN_CALL });
  });

  it("asks first while hosting, naming the workspace", () => {
    const answer = restartAnswer({
      inCall: false,
      hosting: { running: true, workspaceName: "Acme", startsOnLaunch: true },
    });
    expect(answer.kind).toBe("ask");
    if (answer.kind !== "ask") return;
    expect(answer.question.title).toContain("Acme");
    expect(answer.question.detail).toContain("for a moment");
    const notAgain = restartAnswer({
      inCall: false,
      hosting: { running: true, workspaceName: "Acme", startsOnLaunch: false },
    });
    expect(notAgain.kind === "ask" && notAgain.question.detail).toContain("start hosting it again");
  });

  it("restarts when nothing is in the way", () => {
    expect(restartAnswer({ inCall: false, hosting: { running: false } })).toEqual({
      kind: "restart",
    });
  });
});

describe("versions", () => {
  it("orders pre-releases by number, and before the release", () => {
    expect(compareVersions("0.1.0-beta.2", "0.1.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("0.1.0-beta.10", "0.1.0")).toBeLessThan(0);
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("v0.1.0-beta.3", "0.1.0-beta.3")).toBe(0);
    expect(compareVersions("not one", "0.1.0")).toBeNull();
  });

  it("offers only a newer version", () => {
    expect(isOffered("0.1.0-beta.10", "0.1.0-beta.8")).toBe(true);
    expect(isOffered("0.1.0-beta.10", "0.1.0-beta.10")).toBe(false);
    expect(isOffered("0.1.0-beta.9", "0.1.0-beta.10")).toBe(false);
    expect(isOffered("nightly", "0.1.0-beta.8")).toBe(false);
  });

  it("offers a pre-release only to a copy that is one", () => {
    expect(isOffered("0.1.1", "0.1.0")).toBe(true);
    expect(isOffered("0.2.0-beta.1", "0.1.0")).toBe(false);
    expect(isOffered("0.2.0-beta.1", "0.1.0-beta.5")).toBe(true);
  });

  it("offers the 0.2.0 alphas to a 0.1.0 beta", () => {
    expect(isOffered("0.2.0-alpha.1", "0.1.0-beta.39")).toBe(true);
  });
});

/** A controller over fakes: settings in memory, a clock that only moves when told. */
function setUp(over: Partial<UpdateDeps> = {}, kept?: unknown) {
  let now = 10 * DAY_MS;
  const stored = new Map<string, unknown>(kept === undefined ? [] : [[UPDATES_KEY, kept]]);
  const statuses: UpdateStatus[] = [];
  const feed = {
    check: vi.fn(async (): Promise<string | null> => "0.1.0-beta.34"),
    download: vi.fn(async (progress: (percent: number) => void) => {
      progress(50);
    }),
    installOnQuit: vi.fn(),
  };
  const deps: UpdateDeps = {
    mode: "install",
    version: "0.1.0-beta.33",
    now: () => now,
    settings: {
      get: async (key) => stored.get(key),
      set: async (key, value) => void stored.set(key, value),
    },
    feed,
    hosting: () => ({ running: false }),
    install: vi.fn(),
    onChange: (status) => statuses.push(status),
    ...over,
  };
  const updates = new Updates(deps);
  return {
    updates,
    feed,
    deps,
    stored,
    statuses,
    advance: (ms: number) => void (now += ms),
  };
}

describe("Updates", () => {
  it("makes no request for updates with the setting off", async () => {
    const latest = vi.fn(async () => "0.1.0-beta.40");
    const { updates, feed } = setUp({}, { automatic: false });
    await updates.load();
    await updates.tick();
    expect(feed.check).not.toHaveBeenCalled();
    expect(feed.installOnQuit).toHaveBeenLastCalledWith(false);
    const mac = setUp({ mode: "notify", feed: undefined, latest }, { automatic: false });
    await mac.updates.load();
    await mac.updates.tick();
    expect(latest).not.toHaveBeenCalled();
  });

  it("makes none in a build that does not update", async () => {
    const { updates, feed } = setUp({ mode: "none" });
    await updates.load();
    await updates.tick();
    await updates.check();
    expect(feed.check).not.toHaveBeenCalled();
  });

  it("downloads a new version in the background and offers it", async () => {
    const { updates, feed, statuses } = setUp();
    await updates.load();
    await updates.tick();
    expect(feed.download).toHaveBeenCalledTimes(1);
    expect(statuses.some((s) => s.phase === "downloading" && s.progress === 50)).toBe(true);
    expect(updates.status()).toMatchObject({
      phase: "ready",
      newVersion: "0.1.0-beta.34",
      offer: true,
    });
  });

  it("looks again only when it is time to", async () => {
    const { updates, feed, advance } = setUp();
    feed.check.mockResolvedValue(null);
    await updates.load();
    await updates.tick();
    await updates.tick();
    expect(feed.check).toHaveBeenCalledTimes(1);
    advance(CHECK_EVERY_MS);
    await updates.tick();
    expect(feed.check).toHaveBeenCalledTimes(2);
  });

  it("puts the notice off until the next day", async () => {
    const { updates, advance } = setUp();
    await updates.load();
    await updates.tick();
    await updates.later();
    expect(updates.status().offer).toBe(false);
    advance(DAY_MS);
    expect(updates.status().offer).toBe(true);
  });

  it("keeps a newer version found the same day for the next", async () => {
    const { updates, feed, advance } = setUp();
    await updates.load();
    await updates.tick();
    expect(updates.status().offer).toBe(true);
    // The first offer is saved as it is made.
    await Promise.resolve();
    feed.check.mockResolvedValue("0.1.0-beta.35");
    advance(CHECK_EVERY_MS);
    await updates.check();
    expect(updates.status()).toMatchObject({ newVersion: "0.1.0-beta.35", offer: false });
    advance(DAY_MS);
    expect(updates.status().offer).toBe(true);
  });

  it("refuses to restart during a call, and installs nothing", async () => {
    const { updates, deps } = setUp();
    await updates.load();
    await updates.tick();
    updates.reportCall(true);
    expect(await updates.restart()).toEqual({ restarting: false, reason: IN_CALL });
    expect(deps.install).not.toHaveBeenCalled();
    updates.reportCall(false);
    expect(await updates.restart()).toEqual({ restarting: true });
    expect(deps.install).toHaveBeenCalledTimes(1);
  });

  it("hands the window the question before disconnecting a hosted workspace", async () => {
    const { updates, deps } = setUp({
      hosting: () => ({ running: true, workspaceName: "Acme" }),
    });
    await updates.load();
    await updates.tick();
    const answer = await updates.restart();
    expect(answer).toMatchObject({ restarting: false, question: { button: "Restart to update" } });
    expect(!answer.restarting && answer.question?.title).toContain("Acme");
    expect(deps.install).not.toHaveBeenCalled();
    // Answered yes in the window's dialog, it restarts.
    expect(await updates.restart(true)).toEqual({ restarting: true });
    expect(deps.install).toHaveBeenCalledTimes(1);
  });

  it("does not restart into a call that started while it asked", async () => {
    const { updates, deps } = setUp({ hosting: () => ({ running: true }) });
    await updates.load();
    await updates.tick();
    expect((await updates.restart()).restarting).toBe(false);
    updates.reportCall(true);
    expect(await updates.restart(true)).toEqual({ restarting: false, reason: IN_CALL });
    expect(deps.install).not.toHaveBeenCalled();
  });

  it("has nothing to restart for before a version is ready", async () => {
    const { updates, deps } = setUp();
    await updates.load();
    expect((await updates.restart()).restarting).toBe(false);
    expect(deps.install).not.toHaveBeenCalled();
  });

  it("says when it could not look, and waits before looking again", async () => {
    const { updates, feed } = setUp({ log: () => {} });
    feed.check.mockRejectedValue(new Error("offline"));
    await updates.load();
    await updates.tick();
    expect(updates.status()).toMatchObject({ phase: "failed" });
    expect(updates.status().error).toMatch(/tries again/);
    await updates.tick();
    expect(feed.check).toHaveBeenCalledTimes(1);
  });

  it("tells the Mac app a version is out, without downloading", async () => {
    const latest = vi.fn(async () => "0.1.0-beta.34");
    const { updates } = setUp({ mode: "notify", feed: undefined, latest });
    await updates.load();
    await updates.tick();
    expect(updates.status()).toMatchObject({
      phase: "available",
      newVersion: "0.1.0-beta.34",
      offer: true,
    });
    expect((await updates.restart()).restarting).toBe(false);
  });

  it("keeps the setting, and turning it back on looks at once", async () => {
    const { updates, feed, stored } = setUp({}, { automatic: false });
    await updates.load();
    await updates.setAutomatic(true);
    await vi.waitFor(() => expect(feed.check).toHaveBeenCalledTimes(1));
    expect(stored.get(UPDATES_KEY)).toMatchObject({ automatic: true });
    expect(feed.installOnQuit).toHaveBeenLastCalledWith(true);
  });
});
