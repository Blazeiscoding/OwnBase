import { describe, expect, it } from "vitest";
import { mrkdwnFromHtml } from "../src/lib/richPaste.js";

/** A paste of formatted text keeps its links and marks, written as Mrkdwn. */
describe("pasting formatted text", () => {
  it("keeps a link's address with its words, and bold, italic and struck words", () => {
    expect(
      mrkdwnFromHtml(
        '<p>See <b>the design doc</b> and <a href="https://docs.example.com/d/123">the plan</a> before <i>Friday</i>, <s>not Monday</s>.</p>',
      ),
    ).toBe(
      "See *the design doc* and <https://docs.example.com/d/123|the plan> before _Friday_, ~not Monday~.",
    );
  });

  it("writes lists, numbered from where they start, quotes and code", () => {
    expect(
      mrkdwnFromHtml(
        '<p>Steps:</p><ol start="3"><li>Tag</li><li>Build <code>dist</code></li></ol><ul><li>one</li><li>two</li></ul><blockquote>Ship it.</blockquote><pre><code>npm run build\n  --prod</code></pre>',
      ),
    ).toBe(
      "Steps:\n3. Tag\n4. Build `dist`\n- one\n- two\n> Ship it.\n```\nnpm run build\n  --prod\n```",
    );
  });

  it("makes one line break where paragraphs meet, and keeps an empty one between", () => {
    expect(mrkdwnFromHtml("<p><b>One</b></p><p>Two</p><p><br></p><p>Three</p>")).toBe(
      "*One*\nTwo\n\nThree",
    );
  });

  it("reads Google Docs' marks, which sit on spans inside a bold that is not bold", () => {
    expect(
      mrkdwnFromHtml(
        '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:700;">Agenda</span><span style="font-weight:400;"> for </span><span style="font-style:italic;">Thursday</span></p></b>',
      ),
    ).toBe("*Agenda* for _Thursday_");
  });

  it("moves spaces out of a mark, and drops a mark around nothing", () => {
    expect(mrkdwnFromHtml("<p>a<b> bold </b>b<i> </i>c</p>")).toBe("a *bold* b c");
  });

  it("leaves a link that is its own address, or not to the web, as words", () => {
    expect(
      mrkdwnFromHtml(
        '<p><b>x</b> <a href="https://example.com/x">https://example.com/x</a> <a href="javascript:alert(1)">click</a> <a href="mailto:a@b.c">mail</a></p>',
      ),
    ).toBe("*x* https://example.com/x click mail");
  });

  it("keeps a label from breaking out of the link", () => {
    expect(mrkdwnFromHtml('<a href="https://example.com">a|b &lt;c&gt;</a>')).toBe(
      "<https://example.com|a b c>",
    );
  });

  it("leaves to the browser what loses nothing as plain text, and a code editor's copy", () => {
    expect(mrkdwnFromHtml("<p>Just words</p><p>on two lines</p>")).toBeNull();
    expect(mrkdwnFromHtml('<a href="https://example.com/x">https://example.com/x</a>')).toBeNull();
    // VS Code: lines and indentation live in white-space: pre, which only plain text keeps.
    expect(
      mrkdwnFromHtml(
        '<div style="color: #d4d4d4;white-space: pre;"><div><span style="color: #569cd6;font-weight: bold;">const</span> x = 1;</div><div>  <b>y</b></div></div>',
      ),
    ).toBeNull();
    expect(mrkdwnFromHtml("")).toBeNull();
    expect(mrkdwnFromHtml("<script>alert(1)</script><b></b>")).toBeNull();
  });
});
