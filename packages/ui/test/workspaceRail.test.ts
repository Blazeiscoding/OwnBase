import { describe, expect, it } from "vitest";
import { railOrder, railTarget } from "../src/lib/workspaceRail.js";

/**
 * The rail keeps each workspace in one place, so moving between them does not
 * reshuffle it, and Ctrl/Cmd+number always means the same one.
 */
const saved = (workspaceName: string, handle = "sam", url = `http://${workspaceName}.test`) => ({
  url,
  workspaceName,
  handle,
});

describe("the rail's order", () => {
  it("is by name, whichever was used last", () => {
    const used = [saved("Rocket Team"), saved("apple co"), saved("Design Guild")];
    expect(railOrder(used).map((s) => s.workspaceName)).toEqual([
      "apple co",
      "Design Guild",
      "Rocket Team",
    ]);
    // Opening one moves it to the front of what the device stores; not on the rail.
    expect(railOrder([used[2]!, used[0]!, used[1]!])).toEqual(railOrder(used));
  });

  it("tells two sign-ins to one name apart by account, then address", () => {
    const order = railOrder([
      saved("Rocket Team", "sam", "http://b.test"),
      saved("Rocket Team", "alex", "http://c.test"),
      saved("Rocket Team", "sam", "http://a.test"),
    ]);
    expect(order.map((s) => `${s.handle} ${s.url}`)).toEqual([
      "alex http://c.test",
      "sam http://a.test",
      "sam http://b.test",
    ]);
  });
});

describe("Ctrl/Cmd+number", () => {
  const others = ["first", "third", "fourth"];

  it("counts this workspace in its place", () => {
    expect(railTarget(others, 1, 1)).toBe("first");
    expect(railTarget(others, 1, 2)).toBe("here");
    expect(railTarget(others, 1, 3)).toBe("third");
    expect(railTarget(others, 1, 4)).toBe("fourth");
  });

  it("goes nowhere past the last one", () => {
    expect(railTarget(others, 1, 5)).toBeNull();
    expect(railTarget([], 0, 2)).toBeNull();
  });
});
