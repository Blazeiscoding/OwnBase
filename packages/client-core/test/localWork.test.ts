import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalLedger, readDraftTimes } from "../src/localWork.js";

describe("draft times kept on the device", () => {
  it("are read keeping only what reads as a time", () => {
    expect(readDraftTimes({ C1: 5, C2: "6", C3: Number.NaN, C4: null })).toEqual({ C1: 5 });
    for (const unreadable of [null, undefined, [5], "5", 5])
      expect(readDraftTimes(unreadable)).toEqual({});
  });
});

describe("a send waiting to be kept on the device", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("has nothing to wait for while nothing keeps work on the device", () => {
    expect(new LocalLedger().whenKept("n1")).toBeNull();
  });

  it("hears what became of it, once", async () => {
    const ledger = new LocalLedger();
    ledger.keep();
    const kept = ledger.whenKept("n1");
    expect(ledger.waitingNonces()).toEqual(["n1"]);
    ledger.settle("n1", "stored");
    ledger.settle("n1", "unsaved");
    await expect(kept).resolves.toBe("stored");
    expect(ledger.waitingNonces()).toEqual([]);
  });

  it("is told it was not kept when the last keeper stops, or when it waited too long", async () => {
    const ledger = new LocalLedger();
    const stop = ledger.keep();
    const orphaned = ledger.whenKept("n1");
    stop();
    await expect(orphaned).resolves.toBe("unsaved");

    ledger.keep();
    const slow = ledger.whenKept("n2", 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(slow).resolves.toBe("unsaved");
  });
});
