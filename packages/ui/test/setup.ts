import "@testing-library/jest-dom/vitest";
import { cleanup, configure, getConfig } from "@testing-library/react";
import { afterEach } from "vitest";
import { loadTooltipBubble } from "../src/components/Tooltip.js";

// A findBy or waitFor ends as soon as what it looks for is on the page. Outside
// act, React draws that in one task of its scheduler and may run the effects of
// that drawing in the next, and a busy machine can fire the timer that ends the
// wait in between: the test then acts before an effect has, say, added the
// listener it needs or moved focus. React's scheduler posts its tasks with
// setImmediate, so one more turn of that queue lets the task already waiting
// run first. The function is taken before any test fakes timers, as React's is.
const realSetImmediate = globalThis.setImmediate;
const { asyncWrapper } = getConfig();
configure({
  // Five seconds rather than one: a wait ends as soon as what it looks for is
  // there, and a busy machine took longer than one second to draw some of it.
  asyncUtilTimeout: 5_000,
  asyncWrapper: (wait) =>
    asyncWrapper(async () => {
      const result = await wait();
      await new Promise((resolve) => realSetImmediate(resolve));
      return result;
    }),
});

// A hint's floating text comes in a chunk of its own, which an open workspace
// fetches at once. Have it from the start here too, so a hint opens in the same
// tick as in the app; tooltip.dom.test.tsx covers one opened before it arrives.
await loadTooltipBubble();

// Testing Library unmounts after each test by itself only when vitest's globals
// are on, and they are not.
afterEach(() => cleanup());

// jsdom does no layout, so every element reports no boxes, and code that skips
// what is not rendered (focus traps, for one) would skip everything. Stand in
// with the part of the answer that does not need layout: an element is rendered
// unless it, or something around it, is hidden or not displayed. That is
// narrower than a browser's answer, and a test that depends on real geometry
// belongs in the browser suite.
Element.prototype.getClientRects = function (this: Element) {
  for (let node: Element | null = this; node; node = node.parentElement) {
    if (
      !node.isConnected ||
      node.hasAttribute("hidden") ||
      getComputedStyle(node).display === "none"
    ) {
      return [] as unknown as DOMRectList;
    }
  }
  return [new DOMRect(0, 0, 1, 1)] as unknown as DOMRectList;
};
