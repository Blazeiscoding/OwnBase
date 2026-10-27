import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { escapeMrkdwn, type Channel, type ID, type User } from "@ownbase/protocol";
import { Mrkdwn } from "../src/components/Mrkdwn.js";

const users: Record<ID, User> = {
  U1: {
    id: "U1",
    handle: "alice",
    displayName: "Alice",
    role: "member",
    statusText: "",
    statusEmoji: "",
    isBot: false,
    deactivated: false,
    dndUntil: null,
    createdAt: 0,
  },
};
const channels: Record<ID, Channel> = {
  C1: {
    id: "C1",
    type: "public",
    name: "general",
    topic: "",
    description: "",
    creatorId: "U1",
    archived: false,
    createdAt: 0,
  },
};

const render = (text: string) =>
  renderToStaticMarkup(<Mrkdwn text={text} users={users} channels={channels} />);

describe("Mrkdwn", () => {
  it("formats bold, italic, strike and code", () => {
    const html = render("*bold* _italic_ ~gone~ `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<s>gone</s>");
    expect(html).toContain(">code<");
  });

  it("renders escaped text back exactly as it was written", () => {
    // The other half of what the server's /shrug does. Unescaped, the
    // underscores pair up and the arms vanish into an <em>.
    const art = "¯\\_(ツ)_/¯";
    const html = render(`guess so ${escapeMrkdwn(art)}`);
    expect(html).not.toContain("<em>");
    expect(html).toContain(`guess so ${art}`);
  });

  it("never treats an escaped character as a delimiter", () => {
    // Both ends escaped, so there is no italic run at all — the rest of the
    // line is untouched either way.
    const html = render("\\_not italic\\_ and *bold*");
    expect(html).not.toContain("<em>");
    expect(html).toContain("_not italic_");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("renders mentions and channel links by name", () => {
    const html = render("hi <@U1> see <#C1>");
    expect(html).toContain("@Alice");
    expect(html).toContain("#general");
  });

  it("does not draw blank lines for the line breaks typed around a code block", () => {
    // How nearly everyone writes one: the fences on lines of their own.
    const html = render("Deploy notes:\n```\npnpm build\npnpm test\n```\nStaging is up.");
    expect(html).toMatch(/Deploy notes:<code[^>]*>pnpm build\npnpm test<\/code>Staging is up\./);
  });

  it("keeps the line breaks inside a code block, and text around one written inline", () => {
    const html = render("before ```\n\nfirst\n\nlast\n\n``` after");
    expect(html).toMatch(/before <code[^>]*>\nfirst\n\nlast\n<\/code> after/);
  });

  describe("quoted lines", () => {
    it("draws consecutive > lines as one quote, formatted, and leaves the rest as it was", () => {
      const html = render("Earlier:\n> it *does* ship\n>today\nAgreed.");
      expect(html).toContain(
        '<blockquote class="my-0.5 block border-l-2 border-edge pl-2 text-ink-dim">it <strong>does</strong> ship\ntoday</blockquote>',
      );
      // The quote is a block, so the breaks at its edges are not drawn twice.
      expect(html).toContain("Earlier:<blockquote");
      expect(html).toContain("</blockquote>Agreed.");
    });

    it("quotes only at the start of a line", () => {
      const html = render("5 > 3, and a -> b");
      expect(html).not.toContain("<blockquote");
      expect(html).toContain("5 &gt; 3, and a -&gt; b");
    });

    it("leaves a > inside a code block alone", () => {
      const html = render("```\n> not a quote\n```");
      expect(html).not.toContain("<blockquote");
      expect(html).toContain("&gt; not a quote");
    });
  });

  describe("lists", () => {
    it("draws lines starting -, * or • as one bulleted list, formatted, as a block", () => {
      const html = render("Bring:\n- *snacks*\n* a `cable`\n• @nobody's mug\nThanks.");
      expect(html).toContain(
        '<ul class="my-0.5 block list-disc pl-5 marker:text-ink-dim"><li><strong>snacks</strong></li><li>a <code',
      );
      expect(html).toContain("<li>@nobody&#x27;s mug</li></ul>");
      // A block, so the breaks at its edges are not drawn twice.
      expect(html).toContain("Bring:<ul");
      expect(html).toContain("</ul>Thanks.");
    });

    it("numbers lines starting 1. or 1), counting on from the first number", () => {
      const html = render("1. plan\n1) build\n7. ship");
      expect(html).toContain(
        '<ol class="my-0.5 block list-decimal pl-6 marker:text-ink-dim"><li>plan</li><li>build</li><li>ship</li></ol>',
      );
      expect(render("3. third\n4. fourth")).toContain('<ol start="3"');
    });

    it("keeps lists, quotes and code blocks apart", () => {
      const html = render("> said\n- one\n1. first\n```\n- not a list\n```\n- after");
      expect(html).toMatch(
        /^<span[^>]*><blockquote[^>]*>said<\/blockquote><ul[^>]*><li>one<\/li><\/ul><ol[^>]*><li>first<\/li><\/ol><code[^>]*>- not a list<\/code><ul[^>]*><li>after<\/li><\/ul><\/span>$/,
      );
      // A list item inside a quote stays in the quote, as it was written.
      expect(render("> - quoted")).toContain(">- quoted</blockquote>");
    });

    it("leaves text that only looks like a list as it was", () => {
      for (const text of [
        "-5 degrees outside",
        "*bold* to start",
        "- ",
        "a line - with a dash",
        "2024. What a year",
        "1.5 times faster",
        "3.14",
      ]) {
        const html = render(text);
        expect(html, text).not.toMatch(/<[uo]l/);
      }
      expect(render("*bold* to start")).toContain("<strong>bold</strong> to start");
    });
  });

  describe("links in angle brackets, as apps send them", () => {
    it("shows a label in place of the address, and names the address in its title", () => {
      const html = render("Build <https://ci.example.com/runs/7|run 7> failed");
      expect(html).toContain('href="https://ci.example.com/runs/7"');
      expect(html).toContain('title="https://ci.example.com/runs/7"');
      expect(html).toContain(">run 7</a>");
      expect(html).not.toContain("|");
    });

    it("shows the address when there is no label", () => {
      const html = render("see <https://example.com/a>");
      expect(html).toContain('href="https://example.com/a"');
      expect(html).toContain(">https://example.com/a</a>");
      expect(html).not.toContain("&lt;");
    });

    it("names the real site beside a label that reads as another one's address", () => {
      const html = render("<https://evil.example.net/login|https://bank.example.com>");
      expect(html).toContain(">https://bank.example.com</a>");
      expect(html).toContain("(evil.example.net)");
      // A label naming the site it goes to, or a part of it, needs nothing more.
      expect(render("<https://docs.example.com/x|example.com docs>")).not.toContain("(");
      expect(render("<https://example.com/x|example.com>")).not.toContain("(example.com)");
    });

    it("makes links only of web addresses", () => {
      const html = render("<javascript:alert(1)|click me>");
      expect(html).not.toContain("<a");
      expect(html).toContain("&lt;javascript:alert(1)|click me&gt;");
    });
  });
});
