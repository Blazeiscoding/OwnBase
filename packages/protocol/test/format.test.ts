import { describe, expect, it } from "vitest";
import {
  broadcastsIn,
  customEmojiName,
  escapeMrkdwn,
  groupMentionLabel,
  groupMentionsIn,
  groupMentionToken,
  plainText,
} from "../src/format.js";

describe("escapeMrkdwn", () => {
  it("prefixes every delimiter, backslash included", () => {
    expect(escapeMrkdwn("a_b*c~d`e")).toBe("a\\_b\\*c\\~d\\`e");
    expect(escapeMrkdwn("c:\\temp")).toBe("c:\\\\temp");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeMrkdwn("just a sentence, with punctuation!")).toBe(
      "just a sentence, with punctuation!",
    );
  });

  it("escapes the backslash before the character it protects", () => {
    // Order matters: escaping "_" first and "\" second would double back over
    // the backslashes just added and produce \\_ instead of \_.
    expect(escapeMrkdwn("¯\\_(ツ)_/¯")).toBe("¯\\\\\\_(ツ)\\_/¯");
  });
});

describe("custom emoji tokens", () => {
  it("reads the name between the colons", () => {
    expect(customEmojiName(":party-parrot:")).toBe("party-parrot");
    expect(customEmojiName(":a:")).toBe("a");
    expect(customEmojiName(":ship_it_2:")).toBe("ship_it_2");
  });

  it("refuses anything that is not a name between colons", () => {
    expect(customEmojiName("::")).toBeNull();
    expect(customEmojiName(":Party:")).toBeNull();
    expect(customEmojiName(":two words:")).toBeNull();
    expect(customEmojiName("party:")).toBeNull();
    expect(customEmojiName(`:${"a".repeat(33)}:`)).toBeNull();
    expect(customEmojiName("👍")).toBeNull();
  });

  it("stays as its token in the plain-words reading", () => {
    const labels = { user: () => "@someone", channel: () => "#somewhere", group: () => "@group" };
    expect(plainText("ship it :party-parrot:", labels)).toBe("ship it :party-parrot:");
  });
});

describe("user group mentions", () => {
  const labels = {
    user: () => "@someone",
    channel: () => "#somewhere",
    group: (id: string, label: string | null) =>
      groupMentionLabel(id === "G1" ? { handle: "design" } : undefined, label),
  };

  it("finds each group a text names, with or without its label", () => {
    expect([...groupMentionsIn("hi <!subteam^G1|@design> and <!subteam^G2>")]).toEqual([
      "G1",
      "G2",
    ]);
    expect(groupMentionsIn("<!subteam^G1|@design> again <!subteam^G1|@old>").size).toBe(1);
    expect(groupMentionsIn("<!channel> <@G1> subteam^G1").size).toBe(0);
  });

  it("writes Slack's form with the handle as its label", () => {
    expect(groupMentionToken({ id: "G1", handle: "design" })).toBe("<!subteam^G1|@design>");
    expect([...groupMentionsIn(groupMentionToken({ id: "G1", handle: "design" }))]).toEqual(["G1"]);
  });

  it("reads a live group by its handle now, and a gone one by the label it was sent with", () => {
    expect(plainText("ask <!subteam^G1|@old-name>", labels)).toBe("ask @design");
    expect(plainText("ask <!subteam^G9|@gone>", labels)).toBe("ask @gone");
    expect(plainText("ask <!subteam^G9>", labels)).toBe("ask @group");
  });

  it("is not a room-wide mention", () => {
    expect(broadcastsIn("<!subteam^G1|@design>").size).toBe(0);
  });
});
