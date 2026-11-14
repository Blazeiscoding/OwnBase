import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { GUIDES, buildSite, renderMarkdown } from "./generate-docs-site.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(root, "scripts/generate-docs-site.mjs");
const read = (path) => readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");

// What the generator makes from this checkout now, not the copy in
// apps/site/docs: that one lags between rebuilds on main.
const site = buildSite(root);
const pages = [...site].filter(([path]) => path.endsWith(".html"));
const urlOf = (path) => `/docs/${path.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "")}`;
const byUrl = new Map(pages.map(([path, html]) => [urlOf(path), html]));
const idsOf = (html) => new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
// One pass, so "&amp;quot;" comes back as "&quot;", not as a quote.
const decode = (text) => text.replace(/&(amp|quot);/g, (_, e) => (e === "amp" ? "&" : '"'));

test("renders what the guides use", () => {
  const html = renderMarkdown(
    [
      "# Title",
      "",
      "A paragraph with `code`, **bold**, _emphasis_ and a [link](https://example.org/a_b).",
      "",
      "- one",
      "  carried on",
      "- two",
      "  - nested",
      "",
      "1. first",
      "2. second",
      "",
      "> quoted",
      "",
      "| Left | Middle | Right |",
      "| ---- | ------ | ----: |",
      "| `a|b` | 2 |",
      "",
      "```sh",
      "echo <hi> && exit",
      "```",
      "",
      "## A plan's members",
      "## A plan's members",
    ].join("\n"),
  );
  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<code>code<\/code>, <strong>bold<\/strong>, <em>emphasis<\/em>/);
  assert.match(html, /<a href="https:\/\/example.org\/a_b">link<\/a>/);
  assert.match(
    html,
    /<ul>\n<li>one\ncarried on<\/li>\n<li>two\n<ul>\n<li>nested<\/li>\n<\/ul><\/li>\n<\/ul>/,
  );
  assert.match(html, /<ol>\n<li>first<\/li>\n<li>second<\/li>\n<\/ol>/);
  assert.match(html, /<blockquote>\n<p>quoted<\/p>\n<\/blockquote>/);
  // GitHub splits table cells on every unescaped pipe, even inside code.
  assert.match(html, /<th class="align-right">Right<\/th>/);
  assert.match(html, /<td>`a<\/td><td>b`<\/td><td class="align-right">2<\/td>/);
  assert.match(
    html,
    /<pre tabindex="0"><code class="language-sh">echo &lt;hi&gt; &amp;&amp; exit<\/code><\/pre>/,
  );
  assert.match(html, /<h2 id="a-plans-members">[^]*<h2 id="a-plans-members-1">/);
});

test("escapes what it writes", () => {
  const html = renderMarkdown(
    'Text with 5 < 6 & "quotes" and `<script>alert(1)</script>`, and [x](https://example.org/"onmouseover=alert).',
  );
  assert.ok(!html.includes("<script"));
  assert.ok(!/ on\w+=/.test(html.replace(/&quot;/g, "")));
  assert.match(html, /5 &lt; 6 &amp; &quot;quotes&quot;/);
  assert.match(html, /href="https:\/\/example.org\/&quot;onmouseover=alert"/);
});

test("refuses Markdown it does not handle, naming the line", () => {
  const refused = {
    "raw HTML": "a <b>bold</b> word",
    "an HTML block": "<div>\nhi\n</div>",
    "an image": "![a cabin](cabin.png)",
    "a reference link": "[a link][ref]",
    "a link definition": "[ref]: https://example.org",
    "a footnote": "words[^1]",
    "an entity": "a &mdash; b",
    strikethrough: "~~gone~~",
    "an indented code block": "    code",
    "a setext heading": "Title\n=====",
    "a horizontal rule": "---",
    "a * bullet": "* item",
    "a task list": "- [ ] todo",
    "a fence that never closes": "```sh\necho",
    "a ~~~ fence": "~~~\ncode\n~~~",
    "a table that is not one": "| a | b |\nnot a delimiter",
    "a ragged table": "| a | b |\n| - | - |\n| 1 |",
    "a hidden line break": "one  \ntwo",
    "a javascript: link": "[x](javascript:alert(1))",
    "a link with a title": '[x](https://example.org "title")',
    "a multi-line HTML comment": "<!--\nhidden\n-->",
  };
  for (const [what, markdown] of Object.entries(refused))
    assert.throws(() => renderMarkdown(`ok\n\n${markdown}`), /^Error: test\.md:[345]: /, what);
});

test("a numbered item starts the next item, not the item above", () => {
  const html = renderMarkdown("1. first\n2. second\n3. third");
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
});

test("every heading anchor in the guides exists on the site", () => {
  for (const guide of GUIDES) {
    // The whole file's anchors, as GitHub gives them.
    const anchors = [...renderMarkdown(read(guide.source)).matchAll(/<h\d id="([^"]+)"/g)].map(
      (m) => m[1],
    );
    assert.ok(anchors.length > 10, `${guide.source} has headings`);
    const ids = new Set(
      pages
        .filter(([path]) => path.startsWith(`${guide.folder}/`))
        .flatMap(([, html]) => [...idsOf(html)]),
    );
    for (const anchor of anchors)
      assert.ok(ids.has(anchor), `${guide.source}#${anchor} is on no page`);
  }
});

test("every link the README makes into the guides names a heading that exists", () => {
  const readme = read("README.md");
  const anchors = new Map(
    GUIDES.map((guide) => [
      guide.source,
      new Set(
        [...renderMarkdown(read(guide.source)).matchAll(/<h\d id="([^"]+)"/g)].map((m) => m[1]),
      ),
    ]),
  );
  const links = [...readme.matchAll(/\]\((docs\/[A-Z]+\.md)#([^)]+)\)/g)];
  assert.ok(links.length > 10);
  for (const [, file, anchor] of links)
    assert.ok(
      anchors.get(file)?.has(anchor),
      `README links to ${file}#${anchor}, which is not a heading`,
    );
});

test("every link between docs pages reaches a page and a heading on it", () => {
  for (const [path, html] of pages) {
    for (const [, href] of html.matchAll(/href="(\/docs\/[^"]*)"/g)) {
      const [url, id] = decode(href).split("#");
      assert.ok(byUrl.has(url), `${path} links to ${url}, which is no page`);
      if (id)
        assert.ok(
          idsOf(byUrl.get(url)).has(id),
          `${path} links to ${url}#${id}, which is no heading`,
        );
    }
    for (const [, id] of html.matchAll(/href="#([^"]+)"/g))
      assert.ok(
        idsOf(html).has(decode(id)),
        `${path} links to #${id} on itself, which is no heading`,
      );
  }
});

test("each search result leads to its heading", () => {
  const { pages: indexed, entries } = JSON.parse(site.get("search.json"));
  assert.ok(entries.length > 50);
  for (const [page, id, title] of entries) {
    const html = byUrl.get(indexed[page].url);
    assert.ok(html, `the index names ${indexed[page].url}, which is no page`);
    assert.ok(
      idsOf(html).has(id),
      `the index sends "${title}" to #${id}, which is not on its page`,
    );
  }
});

test("the pages need nothing the site's content security policy refuses", () => {
  for (const [path, html] of pages) {
    assert.ok(!/<script(?![^>]*\ssrc=)/.test(html), `${path} has an inline script`);
    assert.ok(!/<style|\sstyle=/.test(html), `${path} has an inline style`);
    assert.ok(!/\son[a-z]+=/.test(html), `${path} has an inline event handler`);
  }
});

test("--check passes on what it wrote and fails on a stale, missing or extra file", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "ownbase-docs-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) =>
    execFileSync(process.execPath, [script, "--out", dir, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  run();
  assert.match(run("--check"), /current/);
  const page = join(dir, "hosting", "guests.html");
  const original = readFileSync(page, "utf8");
  writeFileSync(page, original.replace("Guests", "Visitors"));
  assert.throws(() => run("--check"), /stale[^]*hosting\/guests\.html/);
  rmSync(page);
  assert.throws(() => run("--check"), /hosting\/guests\.html/);
  run();
  writeFileSync(join(dir, "hosting", "old-section.html"), "gone");
  assert.throws(() => run("--check"), /hosting\/old-section\.html/);
  run();
  assert.match(run("--check"), /current/);
});
