import { describe, expect, it } from "vitest";
import { formatLink, formatQuote, linkAddress } from "../src/components/FormattingToolbar.js";
import { markdownLinks } from "../src/lib/markdownLinks.js";

/** Links and quotes from the formatting bar, and links typed as Markdown. */
describe("a link from the formatting bar", () => {
  it("makes the selection the link's words", () => {
    const text = "See the docs for more";
    const next = formatLink(text, 8, 12, "https://ownbase.site/docs");
    expect(next.text).toBe("See the <https://ownbase.site/docs|docs> for more");
    expect(next.selectionStart).toBe(next.selectionEnd);
    expect(next.text.slice(0, next.selectionStart)).toBe(
      "See the <https://ownbase.site/docs|docs>",
    );
  });

  it("puts the address in by itself with nothing selected", () => {
    expect(formatLink("Read ", 5, 5, "https://ownbase.site").text).toBe(
      "Read <https://ownbase.site>",
    );
  });

  it("keeps words a link cannot hold, the address after them", () => {
    expect(formatLink("a|b", 0, 3, "https://x.dev").text).toBe("a|b <https://x.dev>");
    expect(formatLink("two\nlines", 0, 9, "https://x.dev").text).toBe("two\nlines <https://x.dev>");
  });

  it("takes a bare site, a full address or mail, and refuses the rest", () => {
    expect(linkAddress(" ownbase.site/docs ")).toBe("https://ownbase.site/docs");
    expect(linkAddress("http://192.168.1.5:8543")).toBe("http://192.168.1.5:8543");
    expect(linkAddress("mailto:team@example.com")).toBe("mailto:team@example.com");
    expect(linkAddress("http://localhost:8543")).toBe("http://localhost:8543");
    expect(linkAddress("notes")).toBeNull();
    expect(linkAddress("two words.com")).toBeNull();
    expect(linkAddress("javascript:alert(1)")).toBeNull();
    expect(linkAddress("")).toBeNull();
  });
});

describe("a quote from the formatting bar", () => {
  it("quotes each line the selection touches, and takes it away again", () => {
    const text = "first\nsecond\nthird";
    const quoted = formatQuote(text, 2, 9);
    expect(quoted.text).toBe("> first\n> second\nthird");
    const back = formatQuote(quoted.text, quoted.selectionStart, quoted.selectionEnd);
    expect(back.text).toBe(text);
  });

  it("quotes the caret's line and keeps the caret in its words", () => {
    const next = formatQuote("hello there", 5, 5);
    expect(next.text).toBe("> hello there");
    expect(next.selectionStart).toBe(7);
  });

  it("leaves blank lines between quoted ones blank", () => {
    expect(formatQuote("a\n\nb", 0, 4).text).toBe("> a\n\n> b");
  });
});

describe("a link typed as Markdown", () => {
  it("goes as Mrkdwn's own link", () => {
    expect(markdownLinks("Read [the docs](https://ownbase.site/docs) first")).toBe(
      "Read <https://ownbase.site/docs|the docs> first",
    );
    expect(markdownLinks("[a](https://a.dev) and [b](mailto:b@c.dev)")).toBe(
      "<https://a.dev|a> and <mailto:b@c.dev|b>",
    );
  });

  it("leaves code, other brackets and words a link cannot hold alone", () => {
    const code = "Use `[x](https://a.dev)` and\n```\n[y](https://b.dev)\n```";
    expect(markdownLinks(code)).toBe(code);
    expect(markdownLinks("[a|b](https://a.dev)")).toBe("[a|b](https://a.dev)");
    expect(markdownLinks("[todo] (later)")).toBe("[todo] (later)");
    expect(markdownLinks("[x](ftp://a.dev)")).toBe("[x](ftp://a.dev)");
  });
});
