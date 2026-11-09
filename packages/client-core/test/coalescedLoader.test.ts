import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoalescedLoader } from "../src/coalescedLoader.js";

/** One load at a time, one more waiting at most, and a burst of reasons is one load (REV-05). */
function harness(delayMs = 250) {
  const loads: { signal: AbortSignal; finish: () => void }[] = [];
  const loader = new CoalescedLoader(
    (signal) =>
      new Promise<void>((resolve) => {
        loads.push({ signal, finish: resolve });
      }),
    delayMs,
  );
  return { loader, loads };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a coalesced loader", () => {
  it("makes a burst of reasons to look again into one load, after a moment", async () => {
    const { loader, loads } = harness();
    for (let i = 0; i < 10; i++) loader.soon();
    expect(loads).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(loads).toHaveLength(1);
  });

  it("lets a running load finish, then loads once more for everything said meanwhile", async () => {
    const { loader, loads } = harness();
    loader.now();
    for (let i = 0; i < 10; i++) loader.soon();
    expect(loads).toHaveLength(1);
    expect(loads[0]!.signal.aborted).toBe(false);
    loads[0]!.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveLength(2);
    loads[1]!.finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loads).toHaveLength(2);
  });

  it("drops what is in flight when asked for something else, and what waited goes with it", async () => {
    const { loader, loads } = harness();
    loader.now();
    loader.soon();
    loader.now();
    expect(loads[0]!.signal.aborted).toBe(true);
    loads[0]!.finish();
    loads[1]!.finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loads).toHaveLength(2);
  });

  it("drops a waiting load when asked for something now", async () => {
    const { loader, loads } = harness();
    loader.soon();
    loader.now();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loads).toHaveLength(1);
  });

  it("stops what runs and what waits, and loads again when next asked", async () => {
    const { loader, loads } = harness();
    loader.now();
    loader.soon();
    loader.stop();
    expect(loads[0]!.signal.aborted).toBe(true);
    loads[0]!.finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loads).toHaveLength(1);
    loader.soon();
    await vi.advanceTimersByTimeAsync(250);
    expect(loads).toHaveLength(2);
  });

  it("goes on after a load fails", async () => {
    const failing = new CoalescedLoader(() => Promise.reject(new Error("offline")), 10);
    failing.now();
    await vi.advanceTimersByTimeAsync(0);
    failing.soon();
    await vi.advanceTimersByTimeAsync(10);
  });
});
