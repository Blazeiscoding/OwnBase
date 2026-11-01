import { describe, expect, it } from "vitest";
import { matchTier } from "../src/lib/switcherRank.js";
import { RECENT_LIMIT, withRecent } from "../src/lib/recentConversations.js";

describe("how well a name matches", () => {
  it("ranks whole, start, word start, anywhere, none", () => {
    expect(matchTier("design", "design")).toBe(0);
    expect(matchTier("design-review", "design")).toBe(1);
    expect(matchTier("ux-design", "design")).toBe(2);
    expect(matchTier("Priya Natarajan", "nat")).toBe(2);
    expect(matchTier("redesign", "design")).toBe(3);
    expect(matchTier("leads", "design")).toBe(-1);
    // A later occurrence at a word start counts, not only the first.
    expect(matchTier("abab ab", "ab")).toBe(1);
    expect(matchTier("xab ab", "ab")).toBe(2);
    expect(matchTier("Ünïcode Wörd", "wö")).toBe(2);
  });
});

describe("conversations open lately", () => {
  it("keeps the newest first, each once, and only so many", () => {
    expect(withRecent(["A", "B", "C"], "B")).toEqual(["B", "A", "C"]);
    const many = Array.from({ length: RECENT_LIMIT }, (_, i) => `C${i}`);
    expect(withRecent(many, "NEW")).toHaveLength(RECENT_LIMIT);
    expect(withRecent(many, "NEW")[0]).toBe("NEW");
  });
});
