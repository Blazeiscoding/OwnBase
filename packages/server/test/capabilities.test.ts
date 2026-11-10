import { describe, expect, it } from "vitest";
import { CapabilityMap } from "../src/core/capabilities.js";

/**
 * The short-lived capabilities handed to apps (INT-01): each lives its time,
 * and however many are made, no more than the ceiling are alive at once.
 */
type Entry = { expiresAt: number; n: number };
const entry = (n: number, expiresAt: number): Entry => ({ n, expiresAt });

describe("capabilities handed to apps", () => {
  it("holds each until it expires, and not after", () => {
    const map = new CapabilityMap<Entry>(10);
    map.set("a", entry(1, 1_000), 0);
    expect(map.get("a", 1_000)).toEqual(entry(1, 1_000));
    expect(map.get("a", 1_001)).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it("clears those that expired as new ones are made", () => {
    const map = new CapabilityMap<Entry>(10);
    for (let i = 0; i < 5; i++) map.set(`old${i}`, entry(i, 100 + i), i);
    map.set("new", entry(9, 2_000), 1_000);
    expect(map.size).toBe(1);
    expect(map.get("new", 1_000)?.n).toBe(9);
  });

  it("keeps no more than the ceiling, letting the oldest go first", () => {
    const map = new CapabilityMap<Entry>(3);
    for (let i = 0; i < 5; i++) map.set(`k${i}`, entry(i, 10_000 + i), i);
    expect(map.size).toBe(3);
    expect(map.get("k0", 5)).toBeUndefined();
    expect(map.get("k1", 5)).toBeUndefined();
    expect([2, 3, 4].map((i) => map.get(`k${i}`, 5)?.n)).toEqual([2, 3, 4]);
  });

  it("counts one made again as the newest", () => {
    const map = new CapabilityMap<Entry>(2);
    map.set("a", entry(1, 10_000), 0);
    map.set("b", entry(2, 10_000), 1);
    map.set("a", entry(3, 10_001), 2);
    map.set("c", entry(4, 10_002), 3);
    expect(map.get("b", 4)).toBeUndefined();
    expect(map.get("a", 4)?.n).toBe(3);
    expect(map.get("c", 4)?.n).toBe(4);
  });

  it("forgets one deleted", () => {
    const map = new CapabilityMap<Entry>(2);
    map.set("a", entry(1, 10_000), 0);
    map.delete("a");
    expect(map.get("a", 1)).toBeUndefined();
    expect(map.size).toBe(0);
  });
});
