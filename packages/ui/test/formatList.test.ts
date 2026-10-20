import { describe, expect, it } from "vitest";
import { formatList, listShortcut } from "../src/components/FormattingToolbar.js";

/** formatList on `text`, the selection marked by [ and ], and the result marked the same way. */
function list(marked: string, kind: "bullets" | "numbers"): string {
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  const text = marked.replace("[", "").replace("]", "");
  const next = formatList(text, start, end, kind);
  return (
    next.text.slice(0, next.selectionStart) +
    "[" +
    next.text.slice(next.selectionStart, next.selectionEnd) +
    "]" +
    next.text.slice(next.selectionEnd)
  );
}

describe("making lines a list", () => {
  it("makes each line the selection touches an item, and selects them", () => {
    expect(list("Bring:\nmi[lk\neg]gs\nThanks", "bullets")).toBe(
      "Bring:\n[- milk\n- eggs]\nThanks",
    );
    expect(list("[a\nb\nc]", "numbers")).toBe("[1. a\n2. b\n3. c]");
  });

  it("takes them back to plain lines when every one is already an item of that kind", () => {
    expect(list("[- a\n* b\n\u2022 c]", "bullets")).toBe("[a\nb\nc]");
    expect(list("[1. a\n2) b]", "numbers")).toBe("[a\nb]");
    // Not every one is, so all of them become items.
    expect(list("[- a\nb]", "bullets")).toBe("[- a\n- b]");
  });

  it("changes a list of the other kind, numbering it afresh", () => {
    expect(list("[- a\n- b]", "numbers")).toBe("[1. a\n2. b]");
    expect(list("[3. a\n7. b]", "bullets")).toBe("[- a\n- b]");
  });

  it("leaves a blank line among several blank, and counts only the items", () => {
    expect(list("[a\n\nb]", "numbers")).toBe("[1. a\n\n2. b]");
  });

  it("does not take in the line a selection ends at the start of", () => {
    expect(list("[a\n]b", "bullets")).toBe("[- a]\nb");
  });

  it("keeps a caret in its place among the line's words", () => {
    expect(list("ship[] it", "bullets")).toBe("- ship[] it");
    expect(list("- ship[] it", "bullets")).toBe("ship[] it");
    expect(list("- ship[] it", "numbers")).toBe("1. ship[] it");
    // On an empty line, ready to type the first item.
    expect(list("[]", "numbers")).toBe("1. []");
    // A caret inside the marker goes to the start of the words.
    expect(list("-[] ship", "numbers")).toBe("1. []ship");
  });

  it("does not read *bold* or -5 as a marker", () => {
    expect(list("[*bold*]", "bullets")).toBe("[- *bold*]");
    expect(list("[-5 degrees]", "bullets")).toBe("[- -5 degrees]");
  });
});

describe("the list shortcuts", () => {
  it("are Shift with 8 and 7, wherever the layout puts the characters", () => {
    expect(listShortcut({ code: "Digit8", shiftKey: true })).toBe("bullets");
    expect(listShortcut({ code: "Digit7", shiftKey: true })).toBe("numbers");
    expect(listShortcut({ code: "Digit8", shiftKey: false })).toBeUndefined();
    expect(listShortcut({ code: "KeyB", shiftKey: true })).toBeUndefined();
  });
});
