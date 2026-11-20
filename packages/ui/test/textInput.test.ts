import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  caretToRestore,
  insideCodeBlock,
  isImeKey,
  linkOverSelection,
} from "../src/lib/textInput.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("a key that belongs to an input method", () => {
  it("is recognised from the standard flag", () => {
    expect(isImeKey({ isComposing: true })).toBe(true);
  });

  it("is recognised from the old key code some browsers still give instead", () => {
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("leaves an ordinary key press alone", () => {
    expect(isImeKey({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeKey({})).toBe(false);
  });
});

describe("putting the caret back after a rewrite", () => {
  const pending = { start: 3, end: 3, text: "@alice " };

  it("restores the position it worked out", () => {
    expect(caretToRestore(pending, "@alice ")).toEqual({ start: 3, end: 3 });
  });

  it("keeps a selection rather than collapsing it", () => {
    expect(caretToRestore({ start: 1, end: 5, text: "*bold*" }, "*bold*")).toEqual({
      start: 1,
      end: 5,
    });
  });

  it("gives up once the person has typed again", () => {
    // The gap between rewriting the field and moving the caret is where a fast
    // typist lands a keystroke, and completing a mention is exactly when
    // somebody is typing fast. Moving the caret anyway drags it backwards out
    // from under them and puts their next letters inside a finished word.
    expect(caretToRestore(pending, "@alice h")).toBeNull();
  });

  it("has nothing to do when no rewrite is waiting", () => {
    expect(caretToRestore(null, "anything")).toBeNull();
  });

  it("never points past the end of the text", () => {
    expect(caretToRestore({ start: 99, end: 99, text: "short" }, "short")).toEqual({
      start: 5,
      end: 5,
    });
    expect(caretToRestore({ start: -4, end: 2, text: "short" }, "short")).toEqual({
      start: 0,
      end: 2,
    });
  });
});

describe("asking for less motion", () => {
  it("stops a looping animation rather than speeding it up", () => {
    // A pulsing dot at a hundredth of a second does not stop; it flickers,
    // which is worse for the person who asked than what they were avoiding.
    const css = readFileSync(resolve(here, "../src/theme.css"), "utf8");
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css);
    expect(block, "theme.css has no reduced-motion block").not.toBeNull();
    expect(block![1]).toContain("animation-iteration-count: 1 !important");
  });
});

describe("a caret inside a code block (UX-04)", () => {
  const at = (text: string) => insideCodeBlock(text.replace("|", ""), text.indexOf("|"));

  it("is inside one opened and not yet closed, on its first line or a later one", () => {
    expect(at("```|")).toBe(true);
    expect(at("look:\n```\nconst x = 1|")).toBe(true);
    expect(at("```js\nline one\n|")).toBe(true);
  });

  it("is outside one closed, or not yet opened", () => {
    expect(at("```x = 1```|")).toBe(false);
    expect(at("plain words|")).toBe(false);
    expect(at("|```after the caret```")).toBe(false);
  });

  it("counts only the fences before the caret, as the message is read", () => {
    expect(at("```a``` and ```b|")).toBe(true);
    expect(at("```a|``` more")).toBe(true);
  });
});

describe("a web address pasted over selected words", () => {
  const url = "https://example.com/docs";

  it("links them rather than replacing them, the caret after the link", () => {
    expect(linkOverSelection("read the docs please", 9, 13, ` ${url}\n`)).toEqual({
      text: `read the <${url}|docs> please`,
      caret: 9 + `<${url}|docs>`.length,
    });
  });

  it("pastes as usual otherwise", () => {
    // Nothing selected, more than an address, or not a web address.
    expect(linkOverSelection("read the docs", 9, 9, url)).toBeNull();
    expect(linkOverSelection("read the docs", 9, 13, `${url} and more`)).toBeNull();
    expect(linkOverSelection("read the docs", 9, 13, "ftp://example.com")).toBeNull();
    // Words a label cannot hold: a mention, a line break, code.
    expect(linkOverSelection("hi <@U1> there", 3, 8, url)).toBeNull();
    expect(linkOverSelection("one\ntwo", 0, 7, url)).toBeNull();
    expect(linkOverSelection("```\ncode\n```", 4, 8, url)).toBeNull();
    expect(linkOverSelection("`code`", 0, 6, url)).toBeNull();
  });
});
