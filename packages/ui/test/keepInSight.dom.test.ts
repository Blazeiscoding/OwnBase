import { describe, expect, it } from "vitest";
import { keepInSight } from "../src/lib/keepInSight.js";

/** A list 300 px tall scrolled to `scrollTop`, with a 34 px row `at` px from its top. */
function list(scrollTop: number, at: number) {
  const scroller = document.createElement("div");
  scroller.className = "list";
  const row = document.createElement("li");
  scroller.append(row);
  Object.defineProperty(scroller, "clientHeight", { value: 300, configurable: true });
  Object.defineProperty(row, "offsetHeight", { value: 34 });
  scroller.scrollTop = scrollTop;
  scroller.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  row.getBoundingClientRect = () => ({ top: 100 + at - scroller.scrollTop }) as DOMRect;
  return { scroller, row };
}

describe("keepInSight", () => {
  it("scrolls down just far enough for a row below the list, with room under it", () => {
    const { scroller, row } = list(0, 1500);
    keepInSight(row, ".list");
    expect(scroller.scrollTop).toBe(1500 + 34 + 8 - 300);
  });

  it("scrolls up to a row above the list, with room over it", () => {
    const { scroller, row } = list(1000, 400);
    keepInSight(row, ".list");
    expect(scroller.scrollTop).toBe(392);
  });

  it("leaves a list alone when the row is in sight, or the list is not shown", () => {
    const shown = list(100, 200);
    keepInSight(shown.row, ".list");
    expect(shown.scroller.scrollTop).toBe(100);
    const hidden = list(0, 1500);
    Object.defineProperty(hidden.scroller, "clientHeight", { value: 0 });
    keepInSight(hidden.row, ".list");
    expect(hidden.scroller.scrollTop).toBe(0);
  });
});
