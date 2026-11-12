import { describe, expect, it } from "vitest";
import { applyRecordChanges, isRecordChanges } from "../src/records.js";

/** One window's changed names merged into a record every window shares (F02). */
describe("record merges", () => {
  it("changes only the names given, and null removes one", () => {
    const stored = { "http://a U1": "none", "http://a U2": "sender" };
    expect(applyRecordChanges(stored, { "http://a U2": "full", "http://a U3": "none" })).toEqual({
      "http://a U1": "none",
      "http://a U2": "full",
      "http://a U3": "none",
    });
    expect(applyRecordChanges(stored, { "http://a U1": null })).toEqual({
      "http://a U2": "sender",
    });
  });

  it("replaces a stored value that is not a record, and keeps good entries beside a bad one", () => {
    for (const damaged of ["text", 7, ["none"], { "http://a U1": 3 }])
      expect(applyRecordChanges(damaged, { "http://a U1": "none" })).toEqual({
        "http://a U1": "none",
      });
    expect(
      applyRecordChanges(
        { "http://a U1": "none", "http://a U2": 123 },
        { "http://a U3": "sender" },
      ),
    ).toEqual({ "http://a U1": "none", "http://a U3": "sender" });
  });

  it("accepts only bounded text changes", () => {
    expect(isRecordChanges({ a: "none", b: null })).toBe(true);
    expect(isRecordChanges(null)).toBe(false);
    expect(isRecordChanges(["none"])).toBe(false);
    expect(isRecordChanges({ a: 3 })).toBe(false);
    expect(isRecordChanges({ a: "x".repeat(2_000) })).toBe(false);
    expect(
      isRecordChanges(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [i, "x"]))),
    ).toBe(false);
  });
});
