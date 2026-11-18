import { describe, expect, it } from "vitest";
import { unreadBadge } from "../src/lib/unreadBadge.js";

describe("what the app's icon shows", () => {
  it("is the open workspace's mentions", () => {
    expect(unreadBadge({ mentions: 3, unread: true }, {})).toEqual({ count: 3, dot: false });
  });

  it("adds every other workspace's mentions, as the rail shows them", () => {
    expect(
      unreadBadge(
        { mentions: 2, unread: true },
        {
          "https://a.example": { mentions: 4, unread: true },
          "https://b.example": { mentions: 0, unread: false },
        },
      ),
    ).toEqual({ count: 6, dot: false });
  });

  it("is a dot when nothing mentions you but something is unread", () => {
    expect(unreadBadge({ mentions: 0, unread: true }, {})).toEqual({ count: 0, dot: true });
    expect(
      unreadBadge(
        { mentions: 0, unread: false },
        { "https://a.example": { mentions: 0, unread: true } },
      ),
    ).toEqual({ count: 0, dot: true });
  });

  it("is nothing when nothing is unread", () => {
    expect(
      unreadBadge(
        { mentions: 0, unread: false },
        { "https://a.example": { mentions: 0, unread: false } },
      ),
    ).toEqual({ count: 0, dot: false });
  });

  it("adds nothing for a workspace that did not answer, or none open", () => {
    // A workspace that could not answer is left out of the record.
    expect(unreadBadge({ mentions: 1, unread: true }, {})).toEqual({ count: 1, dot: false });
    expect(unreadBadge(null, {})).toEqual({ count: 0, dot: false });
    expect(unreadBadge(null, { "https://a.example": { mentions: 5, unread: true } })).toEqual({
      count: 5,
      dot: false,
    });
  });
});
