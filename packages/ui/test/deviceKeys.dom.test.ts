import { describe, expect, it } from "vitest";
import { COLLAPSED_SECTIONS_KEY } from "../src/components/Sidebar.js";
import { FIRST_PAINT_KEY } from "../src/lib/appearance.js";
import { CHANGE_KEY, JOURNAL_PREFIX, LEGACY_PREFIX, OWNER_KEY } from "../src/lib/deviceStore.js";

/**
 * Keys written straight to localStorage stay out of the device store's own
 * names there (P2b). The store keeps "appearance" as "ownbase:appearance"
 * without IndexedDB, so a first-paint copy under that name would overwrite
 * the choice it copies.
 */
describe("localStorage keys outside the device store", () => {
  it.each([
    ["the first-paint copy", FIRST_PAINT_KEY],
    ["folded sidebar sections", COLLAPSED_SECTIONS_KEY],
  ])("keeps %s apart from the store's names", (_, key) => {
    expect(key.startsWith(LEGACY_PREFIX)).toBe(false);
    expect(key.startsWith(JOURNAL_PREFIX)).toBe(false);
    expect([OWNER_KEY, CHANGE_KEY]).not.toContain(key);
  });
});
