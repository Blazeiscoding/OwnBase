import { describe, expect, it } from "vitest";
import { customEmojiName, escapeMrkdwn, plainText } from "../src/format.js";

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
    const labels = { user: () => "@someone", channel: () => "#somewhere" };
    expect(plainText("ship it :party-parrot:", labels)).toBe("ship it :party-parrot:");
  });
});
