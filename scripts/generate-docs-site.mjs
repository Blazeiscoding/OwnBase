// Builds the docs at ownbase.site/docs from docs/DEPLOYMENT.md and
// docs/INTEGRATIONS.md, which stay the only copy anyone edits:
//
//   node scripts/generate-docs-site.mjs            write apps/site/docs
//   node scripts/generate-docs-site.mjs --check    fail if apps/site/docs is stale
//   node scripts/generate-docs-site.mjs --out DIR  write somewhere else (the tests)
//
// The site is served by Cloudflare Pages with no build step, so the pages are
// committed. Pull requests do not commit them: the Atlas workflow rebuilds them
// on main after each merge, as it does the project atlas.
//
// The Markdown reader handles what these two files use, the way GitHub shows
// it, and refuses everything else with the file and line, so an edit that
// GitHub would show one way cannot publish a page that shows it another. No
// Markdown library: the landing page has no dependencies, and neither does this.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Where the pages go, all of it written by this script. */
export const OUTPUT = "apps/site/docs";
const REPO_URL = "https://github.com/Blazeiscoding/OwnBase";
const SITE_URL = "https://ownbase.site";

export const GUIDES = [
  {
    source: "docs/DEPLOYMENT.md",
    folder: "hosting",
    short: "Hosting",
    about:
      "Run OwnBase on a desktop, a Linux or Windows server, or in Docker: sharing it on the internet, calls, backups, proxies, limits and the Enterprise features.",
  },
  {
    source: "docs/INTEGRATIONS.md",
    folder: "integrations",
    short: "Integrations",
    about:
      "What a Slack-shaped app, webhook or bot can rely on from an OwnBase server, and where it differs from Slack.",
  },
];

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => ENTITIES[c]);
const DECODE = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
const ESCAPE = /^&(amp|lt|gt|quot|#39);/;
/**
 * The plain text of HTML this script wrote, for anchors, titles and the
 * search index: its tags dropped, its escapes undone. Not a sanitizer. The
 * result is text, and everything that writes it into a page escapes it
 * again. Read once, left to right, so text an escape stands for is never
 * read again as a tag or an escape. A "<" with no ">" after it stays.
 */
function textOf(html) {
  let text = "";
  for (let at = 0; at < html.length; at++) {
    const char = html[at];
    const close = char === "<" ? html.indexOf(">", at) : -1;
    const escape = char === "&" ? ESCAPE.exec(html.slice(at, at + 6)) : null;
    if (close !== -1) at = close;
    else if (escape) {
      text += DECODE[escape[1]];
      at += escape[0].length - 1;
    } else text += char;
  }
  return text;
}

/** GitHub's anchor for a heading (github-slugger), before duplicates are numbered. */
export function githubSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Numbers repeated anchors as GitHub does: intro, intro-1, intro-2. */
function slugger() {
  const occurrences = new Map();
  return (text) => {
    const base = githubSlug(text);
    let slug = base;
    while (occurrences.has(slug)) {
      occurrences.set(base, occurrences.get(base) + 1);
      slug = `${base}-${occurrences.get(base)}`;
    }
    occurrences.set(slug, 0);
    return slug;
  };
}

// ---------------------------------------------------------------- inline

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

function findBackticks(text, from, length) {
  const run = /`+/g;
  run.lastIndex = from;
  for (let m; (m = run.exec(text));) if (m[0].length === length) return m.index;
  return -1;
}

/** The next place `delimiter` closes, past escapes and code spans, or -1. */
function findClose(text, from, delimiter, closes = () => true) {
  for (let j = from; j < text.length; j++) {
    if (text[j] === "\\") {
      j++;
      continue;
    }
    if (text[j] === "`") {
      const run = text.slice(j).match(/^`+/)[0];
      const end = findBackticks(text, j + run.length, run.length);
      j = (end >= 0 ? end : j) + run.length - 1;
      continue;
    }
    if (text.startsWith(delimiter, j) && closes(j)) return j;
  }
  return -1;
}

/** The `]` that closes the `[` at `from`, or -1. */
function findBracket(text, from) {
  let depth = 0;
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") j++;
    else if (c === "`") {
      const run = text.slice(j).match(/^`+/)[0];
      const end = findBackticks(text, j + run.length, run.length);
      j = (end >= 0 ? end : j) + run.length - 1;
    } else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return j;
  }
  return -1;
}

/** GitHub leaves trailing punctuation out of a bare link. */
function trimAutolink(url) {
  for (;;) {
    if (/[?!.,:*_~'"]$/.test(url)) url = url.slice(0, -1);
    else if (url.endsWith(")") && url.split("(").length < url.split(")").length)
      url = url.slice(0, -1);
    else return url;
  }
}

/** One paragraph's or cell's text as HTML. */
function inline(text, ctx, inLink = false) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const rest = text.slice(i);
    if (c === "\\") {
      const next = text[i + 1];
      if (next === "\n") ctx.fail("a backslash line break is not supported");
      if (next !== undefined && PUNCTUATION.test(next)) {
        out += escapeHtml(next);
        i += 2;
      } else {
        out += "\\";
        i++;
      }
      continue;
    }
    if (c === "`") {
      const run = rest.match(/^`+/)[0];
      const close = findBackticks(text, i + run.length, run.length);
      if (close < 0) {
        out += run;
        i += run.length;
        continue;
      }
      let code = text.slice(i + run.length, close).replace(/\n/g, " ");
      if (/^ .* $/s.test(code) && code.trim()) code = code.slice(1, -1);
      out += `<code>${escapeHtml(code)}</code>`;
      i = close + run.length;
      continue;
    }
    if (rest.startsWith("~~")) ctx.fail("strikethrough is not supported");
    if (rest.startsWith("**")) {
      const close = findClose(text, i + 2, "**");
      if (close > i + 2 && !SPACE.test(text[i + 2]) && !SPACE.test(text[close - 1])) {
        out += `<strong>${inline(text.slice(i + 2, close), ctx, inLink)}</strong>`;
        i = close + 2;
      } else {
        out += "**";
        i += 2;
      }
      continue;
    }
    if (rest.startsWith("__")) ctx.fail("__bold__ is not supported; use **bold**");
    if (c === "_" || c === "*") {
      const before = text[i - 1] ?? " ";
      const after = text[i + 1] ?? " ";
      const opens = !SPACE.test(after) && (c === "*" || !WORD.test(before));
      const close = opens
        ? findClose(
            text,
            i + 1,
            c,
            (j) =>
              !SPACE.test(text[j - 1]) &&
              text[j + 1] !== c &&
              (c === "*" || !WORD.test(text[j + 1] ?? " ")),
          )
        : -1;
      if (close > i + 1) {
        out += `<em>${inline(text.slice(i + 1, close), ctx, inLink)}</em>`;
        i = close + 1;
      } else {
        out += c;
        i++;
      }
      continue;
    }
    if (c === "!" && text[i + 1] === "[") ctx.fail("images are not supported");
    if (c === "[") {
      if (text[i + 1] === "^") ctx.fail("footnotes are not supported");
      const end = findBracket(text, i);
      if (end >= 0 && text[end + 1] === "(") {
        const close = text.indexOf(")", end + 2);
        if (close < 0) ctx.fail("a link whose address never closes");
        const target = text.slice(end + 2, close);
        if (!target || /[\s(]/.test(target))
          ctx.fail(`the link address "${target}" is empty or has a space or "(" in it`);
        if (inLink) ctx.fail("a link inside a link");
        out += `<a href="${escapeHtml(ctx.link(target))}">${inline(text.slice(i + 1, end), ctx, true)}</a>`;
        i = close + 1;
        continue;
      }
      if (end >= 0 && (text[end + 1] === "[" || text[end + 1] === ":"))
        ctx.fail("reference links are not supported; put the address in the link");
      out += "[";
      i++;
      continue;
    }
    if (c === "<") {
      const auto = rest.match(/^<(https?:\/\/[^\s<>]+)>/);
      if (auto) {
        if (inLink) ctx.fail("a link inside a link");
        out += `<a href="${escapeHtml(ctx.link(auto[1]))}">${escapeHtml(auto[1])}</a>`;
        i += auto[0].length;
        continue;
      }
      if (/^<[A-Za-z/!?]/.test(rest)) ctx.fail("inline HTML is not supported; put it in `code`");
      out += "&lt;";
      i++;
      continue;
    }
    if (c === "&") {
      if (/^&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(rest))
        ctx.fail("HTML entities are not supported; write the character itself");
      out += "&amp;";
      i++;
      continue;
    }
    if (
      c === "h" &&
      !inLink &&
      /^https?:\/\//.test(rest) &&
      (i === 0 || /[\s*_~(]/.test(text[i - 1]))
    ) {
      const url = trimAutolink(rest.match(/^https?:\/\/[^\s<]*/)[0]);
      out += `<a href="${escapeHtml(ctx.link(url))}">${escapeHtml(url)}</a>`;
      i += url.length;
      continue;
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- blocks

const LIST_ITEM = /^(\d{1,9}[.)]|[-*+])( +|$)(.*)$/;
const HEADING = /^(#{1,6})(?: +(.*?))?(?: +#+)? *$/;

const isOrdered = (marker) => /\d/.test(marker);
const isDelimiterRow = (line) =>
  line.trimStart().startsWith("|") &&
  line.includes("-") &&
  splitRow(line).every((cell) => /^:?-+:?$/.test(cell));

/** Whether a line ends the paragraph before it. */
function interrupts(line) {
  if (/^#{1,6}( |$)/.test(line) || line.startsWith("```") || line.startsWith(">")) return true;
  if (line.startsWith("<!--")) return true;
  const item = line.match(LIST_ITEM);
  // As on GitHub, a numbered item breaks into a paragraph only when it is 1.
  return Boolean(item && item[3].trim() && (!isOrdered(item[1]) || /^1[.)]$/.test(item[1])));
}

/** A table row's cells. GitHub splits on every unescaped |, even inside `code`. */
function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells = [];
  let cell = "";
  for (let k = 0; k < row.length; k++) {
    if (row[k] === "\\" && row[k + 1] === "|") {
      cell += "|";
      k++;
    } else if (row[k] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += row[k];
  }
  cells.push(cell.trim());
  return cells;
}

/** Reads lines (`{ t, no }`) into blocks. */
function parseBlocks(lines, ctx) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const { t, no } = lines[i];
    const fail = (message) => ctx.fail(message, no);
    if (!t.trim()) {
      i++;
      continue;
    }
    if (/^ {4,}\S/.test(t)) fail("indented code is not supported; use a ``` fence");
    if (/^ /.test(t)) fail("a block that starts indented, outside a list item");
    if (t.startsWith("```")) {
      const lang = t.slice(3).trim();
      if (!/^[\w+-]*$/.test(lang)) fail(`the code fence's language "${lang}" is not one word`);
      let end = i + 1;
      while (end < lines.length && lines[end].t.trimEnd() !== "```") end++;
      if (end === lines.length) fail("a code fence that never closes");
      const body = lines.slice(i + 1, end).map((line) => line.t);
      blocks.push({ type: "code", lang, body: body.join("\n"), no });
      i = end + 1;
      continue;
    }
    if (t.startsWith("~~~")) fail("~~~ fences are not supported; use ```");
    const heading = t.match(HEADING);
    if (heading) {
      if (!heading[2]) fail("an empty heading");
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2], no });
      i++;
      continue;
    }
    if (t.startsWith("<!--")) {
      // Skipped whole, so it must end on its own line: anything after a
      // close, or a comment left open, is refused rather than guessed at.
      const rest = t.trimEnd();
      if (!rest.endsWith("-->") || rest.slice(0, -3).includes("-->"))
        fail("an HTML comment must open and close on one line");
      i++;
      continue;
    }
    if (t.startsWith("<")) fail("HTML blocks are not supported");
    if (/^([-*_])( *\1){2,} *$/.test(t)) fail("horizontal rules are not supported");
    if (t.startsWith(">")) {
      const quoted = [];
      while (i < lines.length && lines[i].t.startsWith(">")) {
        quoted.push({ t: lines[i].t.replace(/^> ?/, ""), no: lines[i].no });
        i++;
      }
      blocks.push({ type: "quote", children: parseBlocks(quoted, ctx) });
      continue;
    }
    if (t.startsWith("|")) {
      const next = lines[i + 1];
      if (!next || !isDelimiterRow(next.t))
        fail("a line that starts with | must be a table header, with its |---| row next");
      const head = splitRow(t);
      const align = splitRow(next.t).map((cell) =>
        cell.startsWith(":") && cell.endsWith(":")
          ? "center"
          : cell.endsWith(":")
            ? "right"
            : cell.startsWith(":")
              ? "left"
              : "",
      );
      if (align.length !== head.length)
        fail("the table's |---| row has a different number of cells");
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].t.trim()) {
        const row = lines[i];
        if (!row.t.startsWith("|")) ctx.fail("a table row must start with |", row.no);
        const cells = splitRow(row.t);
        if (cells.length !== head.length)
          ctx.fail(`a table row with ${cells.length} cells under ${head.length} headings`, row.no);
        rows.push({ cells, no: row.no });
        i++;
      }
      blocks.push({ type: "table", head, align, rows, no });
      continue;
    }
    const item = t.match(LIST_ITEM);
    if (item) {
      i = parseList(lines, i, ctx, blocks);
      continue;
    }
    const text = [t];
    i++;
    while (i < lines.length && lines[i].t.trim() && !interrupts(lines[i].t.trimStart())) {
      const line = lines[i].t;
      if (/^ {0,3}(=+|-+) *$/.test(line))
        ctx.fail("underlined headings are not supported; use #", lines[i].no);
      if (isDelimiterRow(line))
        ctx.fail(
          "a table must start after a blank line, with | at the start of each row",
          lines[i].no,
        );
      text.push(line.trimStart());
      i++;
    }
    if (text.slice(0, -1).some((line) => / {2,}$/.test(line)))
      fail("a line ending in two spaces (a hidden line break) is not supported");
    blocks.push({ type: "para", text: text.join("\n").trimEnd(), no });
  }
  return blocks;
}

/** Reads the list that starts at `start` into `blocks`; returns the line after it. */
function parseList(lines, start, ctx, blocks) {
  const first = lines[start].t.match(LIST_ITEM);
  const ordered = isOrdered(first[1]);
  const list = {
    type: "list",
    ordered,
    start: ordered ? Number.parseInt(first[1], 10) : 1,
    loose: false,
    items: [],
  };
  let i = start;
  while (i < lines.length) {
    const item = lines[i].t.match(LIST_ITEM);
    if (!item || isOrdered(item[1]) !== ordered) break;
    const fail = (message) => ctx.fail(message, lines[i].no);
    if (/^[*+]$/.test(item[1])) fail(`"${item[1]}" bullets are not supported; use -`);
    if (item[1].endsWith(")")) fail('"1)" numbering is not supported; use "1."');
    if (!item[3].trim()) fail("an empty list item");
    if (item[2].length > 4) fail("a list item whose text starts as indented code");
    if (/^\[[ xX]\] /.test(item[3])) fail("task list boxes are not supported");
    const width = item[1].length + item[2].length;
    const body = [{ t: item[3], no: lines[i].no }];
    let j = i + 1;
    while (j < lines.length) {
      const { t, no } = lines[j];
      if (!t.trim()) body.push({ t: "", no });
      else if (t.match(/^ */)[0].length >= width) body.push({ t: t.slice(width), no });
      // A lazy line: it carries on the paragraph above it without the indent.
      // Any marker starts the next item here, 2. as much as 1.
      else if (
        body.at(-1).t.trim() &&
        !interrupts(t) &&
        !t.startsWith("|") &&
        !LIST_ITEM.test(t.trimStart())
      )
        body.push({ t: t.trimStart(), no });
      else break;
      j++;
    }
    let end = body.length;
    while (!body[end - 1].t.trim()) end--;
    const trailingBlank = end < body.length;
    body.length = end;
    if (body.some((line) => !line.t.trim())) list.loose = true;
    list.items.push(parseBlocks(body, ctx));
    i = j;
    const next = lines[i]?.t.match(LIST_ITEM);
    if (trailingBlank && next && isOrdered(next[1]) === ordered) list.loose = true;
  }
  blocks.push(list);
  return i;
}

function renderBlocks(blocks, ctx, tight = false) {
  return blocks.map((block) => renderBlock(block, ctx, tight)).join("\n");
}

function renderBlock(block, ctx, tight) {
  ctx.line = block.no ?? ctx.line;
  switch (block.type) {
    case "para": {
      const html = inline(block.text, ctx);
      return tight ? html : `<p>${html}</p>`;
    }
    case "code": {
      const lang = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : "";
      return `<pre tabindex="0"><code${lang}>${escapeHtml(block.body)}</code></pre>`;
    }
    case "quote":
      return `<blockquote>\n${renderBlocks(block.children, ctx)}\n</blockquote>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
      const items = block.items.map((item) => `<li>${renderBlocks(item, ctx, !block.loose)}</li>`);
      return `<${tag}${start}>\n${items.join("\n")}\n</${tag}>`;
    }
    case "table": {
      const cell = (tag, text, k) => {
        const align = block.align[k] ? ` class="align-${block.align[k]}"` : "";
        return `<${tag}${align}>${inline(text, ctx)}</${tag}>`;
      };
      const head = block.head.map((text, k) => cell("th", text, k)).join("");
      const rows = block.rows.map((row) => {
        ctx.line = row.no;
        return `<tr>${row.cells.map((text, k) => cell("td", text, k)).join("")}</tr>`;
      });
      // Wide tables scroll inside their own box, which a keyboard can reach.
      return `<div class="doc-table" tabindex="0" role="region" aria-label="Table"><table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows.join("\n")}\n</tbody>\n</table></div>`;
    }
    case "heading": {
      if (!ctx.heading) ctx.fail("a heading inside a list or quote is not supported");
      return ctx.heading(block);
    }
  }
  throw new Error(`Unknown block ${block.type}`);
}

/** A context for reading `file`, whose failures name it and the line. */
function context(file, fields = {}) {
  const ctx = {
    file,
    line: 0,
    fail(message, line = ctx.line) {
      throw new Error(`${file}:${line}: ${message}`);
    },
    link: (target) => target,
    ...fields,
  };
  return ctx;
}

const toLines = (source) =>
  source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((t, k) => ({ t, no: k + 1 }));

/**
 * Markdown on its own, for the tests: headings get GitHub's anchors and links
 * pass through `link`.
 */
export function renderMarkdown(source, { file = "test.md", link = (target) => target } = {}) {
  const slug = slugger();
  const ctx = context(file, {
    link,
    heading: (block) => {
      const html = inline(
        block.text,
        context(file, { line: block.no, link: noLinkInHeading(file, block.no) }),
      );
      return `<h${block.level} id="${escapeHtml(slug(textOf(html)))}">${html}</h${block.level}>`;
    },
  });
  return renderBlocks(parseBlocks(toLines(source), ctx), ctx);
}

const noLinkInHeading = (file, line) => () => {
  throw new Error(`${file}:${line}: links in headings are not supported`);
};

// ---------------------------------------------------------------- the site

const shortHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 10);
const pageUrl = (guide, page) => `/docs/${guide.folder}/${page ? page.slug : ""}`;

/** Splits a guide at its ## headings, each a page, and gives every heading its anchor. */
function readGuide(guide, root) {
  const source = readFileSync(resolve(root, guide.source), "utf8");
  const ctx = context(guide.source);
  const blocks = parseBlocks(toLines(source), ctx);
  const slug = slugger();
  const anchors = new Map();
  const headingHtml = (block) =>
    inline(
      block.text,
      context(guide.source, { line: block.no, link: noLinkInHeading(guide.source, block.no) }),
    );
  const [title, ...rest] = blocks;
  if (title?.type !== "heading" || title.level !== 1)
    ctx.fail("the guide must start with one # heading, its title", 1);
  const top = {
    slug: "",
    title: textOf(headingHtml(title)),
    titleHtml: headingHtml(title),
    id: slug(textOf(headingHtml(title))),
    blocks: [],
    headings: [],
  };
  anchors.set(top.id, top);
  const pages = [];
  let page = top;
  for (const block of rest) {
    if (block.type === "heading") {
      const html = headingHtml(block);
      const id = slug(textOf(html));
      if (block.level === 1) ctx.fail("a second # heading; a guide has one title", block.no);
      if (block.level === 2) {
        if (id === "index" || id === "")
          ctx.fail(`the heading "${block.text}" cannot name a page`, block.no);
        page = { slug: id, id, title: textOf(html), titleHtml: html, blocks: [], headings: [] };
        pages.push(page);
        anchors.set(id, page);
        continue;
      }
      if (page === top) ctx.fail("a ### heading before the first ## heading", block.no);
      const heading = { level: block.level, id, html, text: textOf(html) };
      page.headings.push(heading);
      anchors.set(id, page);
      page.blocks.push({ type: "heading", heading, no: block.no });
      continue;
    }
    page.blocks.push(block);
  }
  return { ...guide, top, pages, anchors };
}

/** Where a link in `guide`'s Markdown, on `page`, goes on the site. */
function linker(guides, guide, page, root, fail) {
  const toAnchor = (target, id) => {
    const holder = target.anchors.get(id);
    if (!holder) fail(`no heading in ${target.source} has the anchor #${id}`);
    const url = pageUrl(target, holder.slug ? holder : null);
    return target === guide && holder === page ? `#${id}` : `${url}#${id}`;
  };
  return (address) => {
    if (/^https?:\/\//.test(address) || address.startsWith("mailto:")) return address;
    if (/^[a-z][a-z0-9+.-]*:/i.test(address)) fail(`links to "${address}" are not allowed`);
    const at = address.indexOf("#");
    const path = at < 0 ? address : address.slice(0, at);
    let id = at < 0 ? "" : address.slice(at + 1);
    try {
      id = decodeURIComponent(id);
    } catch {
      fail(`the anchor in "${address}" is not valid`);
    }
    if (!path) return toAnchor(guide, id);
    const file = posix.normalize(posix.join(posix.dirname(guide.source), path));
    if (file.startsWith("../") || posix.isAbsolute(file))
      fail(`"${address}" leaves the repository`);
    const other = guides.find((g) => g.source === file);
    if (other) return id ? toAnchor(other, id) : pageUrl(other);
    if (!existsSync(resolve(root, file))) fail(`links to ${file}, which does not exist`);
    const kind = statSync(resolve(root, file)).isDirectory() ? "tree" : "blob";
    return `${REPO_URL}/${kind}/main/${file}${id ? `#${encodeURIComponent(id)}` : ""}`;
  };
}

function description(text, fallback) {
  const words = (text || fallback).replace(/\s+/g, " ").trim();
  if (words.length <= 155) return words;
  return `${words.slice(0, 154).replace(/\s+\S*$/, "")}…`;
}

const NAV = [
  ["/#host", "Hosting"],
  ["/host", "Guide"],
  ["/docs/", "Docs"],
  ["/#download", "Download"],
  [REPO_URL, "GitHub"],
];

function layout({ title, about, url, assets, guides, current, main, toc }) {
  const nav = NAV.map(
    ([href, label]) =>
      `<li><a href="${href}"${label === "Docs" ? ' aria-current="page"' : ""}>${label}</a></li>`,
  ).join("\n          ");
  const sections = guides
    .map((guide) => {
      const link = (page) => {
        const href = pageUrl(guide, page);
        const here = href === url ? ' aria-current="page"' : "";
        return `<li><a href="${href}"${here}>${escapeHtml(page ? page.title : "Overview")}</a></li>`;
      };
      return `<p class="docs-group">${escapeHtml(guide.top.title)}</p>
            <ul>
              ${[link(null), ...guide.pages.map(link)].join("\n              ")}
            </ul>`;
    })
    .join("\n            ");
  const inPage = toc?.length
    ? `
      <aside class="docs-toc" aria-labelledby="toc-title">
        <p id="toc-title" class="docs-toc-title">On this page</p>
        <ul>
          ${toc.map((h) => `<li class="toc-${h.level}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`).join("\n          ")}
        </ul>
      </aside>`
    : "";
  return `<!doctype html>
<!-- Written by scripts/generate-docs-site.mjs from ${current ? escapeHtml(current.source) : "docs/*.md"}. Edit that, not this. -->
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(about)}" />
    <link rel="canonical" href="${SITE_URL}${url}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(about)}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${SITE_URL}${url}" />
    <meta property="og:site_name" content="OwnBase" />
    <meta property="og:image" content="${SITE_URL}/og.png?v=2" />
    <meta name="theme-color" content="#0b0a20" />
    <link rel="preload" href="/fonts/onest-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="icon" href="/ownbase.svg?v=2" type="image/svg+xml" />
    <link rel="stylesheet" href="/site.css?v=${assets.siteCss}" />
    <link rel="stylesheet" href="/docs.css?v=${assets.docsCss}" />
    <script src="/docs.js?v=${assets.docsJs}" defer></script>
  </head>
  <body class="docs-body" data-search="/docs/search.json?v=${assets.search}"${current ? ` data-guide="${current.folder}"` : ""}>
    <a class="skip" href="#main">Skip to content</a>

    <header class="guide-head">
      <nav class="nav wrap" aria-label="Main">
        <a class="brand" href="/">
          <img src="/ownbase.svg?v=2" alt="" width="32" height="32" />
          <span>OwnBase</span>
          <span class="alpha">Alpha</span>
        </a>
        <ul class="nav-links">
          ${nav}
        </ul>
        <a class="btn btn-small btn-light" href="/#download">Get OwnBase</a>
      </nav>
    </header>

    <div class="docs wrap">
      <aside class="docs-side">
        <div class="docs-search" role="search" hidden>
          <label class="sr-only" for="docs-query">Search the docs</label>
          <input id="docs-query" type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false" />
          <p class="docs-status" aria-live="polite"></p>
          <div class="docs-results" hidden></div>
        </div>
        <details class="docs-nav" open>
          <summary>All sections</summary>
          <nav aria-label="Docs">
            ${sections}
          </nav>
        </details>
      </aside>
${inPage}
      <main id="main" class="docs-main">
${main}
      </main>
    </div>

    <footer class="end guide-foot">
      <div class="footer wrap">
        <a class="brand" href="/">
          <img src="/ownbase.svg?v=2" alt="" width="24" height="24" />
          <span>OwnBase</span>
        </a>
        <ul class="footer-links">
          <li><a href="/host">Hosting guide</a></li>
          <li><a href="/docs/">Docs</a></li>
          <li><a href="${REPO_URL}">GitHub</a></li>
          <li><a href="${REPO_URL}/blob/main/SECURITY.md">Security</a></li>
          <li><a href="${REPO_URL}/blob/main/docs/PLANS.md">Plans</a></li>
        </ul>
        <p class="legal">
          OwnBase is in alpha. MIT licensed, except the Enterprise code in <code>ee/</code>. Not
          affiliated with Slack or Salesforce.
        </p>
      </div>
    </footer>
  </body>
</html>
`;
}

/** Every file under apps/site/docs, as `relative path -> content`. */
export function buildSite(root = repoRoot) {
  const guides = GUIDES.map((guide) => readGuide(guide, root));
  const readAsset = (path) => readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");
  const pages = [];
  const entries = [];
  const files = new Map();

  for (const guide of guides) {
    const order = [null, ...guide.pages];
    order.forEach((page, k) => {
      const url = pageUrl(guide, page);
      const ctx = context(guide.source);
      ctx.link = linker(guides, guide, page ?? guide.top, root, (message) => ctx.fail(message));
      const pageIndex = pages.length;
      pages.push({ url, title: page ? page.title : guide.top.title, guide: guide.folder });
      const sections = [];
      const section = (id, title) => {
        const entry = [pageIndex, id, title, ""];
        sections.push(entry);
        return entry;
      };
      let open = section(page ? page.id : guide.top.id, page ? page.title : guide.top.title);
      ctx.heading = ({ heading }) => {
        open = section(heading.id, heading.text);
        const level = heading.level - 1;
        return `<h${level} id="${escapeHtml(heading.id)}">${heading.html}<a class="doc-anchor" href="#${escapeHtml(heading.id)}" aria-label="Link to ${escapeHtml(heading.text)}">#</a></h${level}>`;
      };
      const blocks = (page ?? guide.top).blocks;
      const parts = blocks.map((block) => {
        const html = renderBlock(block, ctx, false);
        if (block.type !== "heading") open[3] += ` ${textOf(html)}`;
        return html;
      });
      for (const entry of sections)
        entries.push([...entry.slice(0, 3), entry[3].replace(/\s+/g, " ").trim()]);
      const firstText = sections[0][3];
      const sourceUrl = `${REPO_URL}/blob/main/${guide.source}${page ? `#${page.id}` : ""}`;
      const prev = order[k - 1];
      const next = order[k + 1];
      const pager = [
        k > 0
          ? `<a class="docs-prev" href="${pageUrl(guide, prev)}"><span>Previous</span>${escapeHtml(prev ? prev.title : "Overview")}</a>`
          : "",
        next
          ? `<a class="docs-next" href="${pageUrl(guide, next)}"><span>Next</span>${escapeHtml(next.title)}</a>`
          : "",
      ].join("");
      const contents = page
        ? ""
        : `
        <h2 id="sections">Sections</h2>
        <ul class="docs-list">
          ${guide.pages.map((p) => `<li><a href="${pageUrl(guide, p)}">${escapeHtml(p.title)}</a></li>`).join("\n          ")}
        </ul>`;
      const titleHtml = page ? page.titleHtml : guide.top.titleHtml;
      const id = page ? page.id : guide.top.id;
      const main = `        <p class="docs-crumb"><a href="/docs/">Docs</a> / <a href="${pageUrl(guide)}">${escapeHtml(guide.top.title)}</a></p>
        <article class="doc">
        <h1 id="${escapeHtml(id)}">${titleHtml}</h1>
        ${page ? "" : `<p class="docs-lede">${escapeHtml(guide.about)}</p>`}
${parts.join("\n")}${contents}
        </article>
        <nav class="docs-pager" aria-label="Pages">${pager}</nav>
        <p class="docs-source">This page is made from <a href="${sourceUrl}">${escapeHtml(guide.source)}</a>.</p>`;
      files.set(`${guide.folder}/${page ? `${page.slug}.html` : "index.html"}`, {
        main,
        title: `${page ? `${page.title} · ` : ""}${guide.top.title} · OwnBase docs`,
        about: description(firstText, guide.about),
        url,
        current: guide,
        toc: page ? page.headings.filter((h) => h.level <= 4) : null,
      });
    });
  }

  const index = `        <article class="doc">
        <h1 id="docs">OwnBase docs</h1>
        <p class="docs-lede">How to host OwnBase and connect apps to it, from the two guides kept with its code.</p>
        <div class="docs-guides">
${guides
  .map(
    (guide) => `          <section class="docs-guide" aria-labelledby="guide-${guide.folder}">
            <h2 id="guide-${guide.folder}"><a href="${pageUrl(guide)}">${escapeHtml(guide.top.title)}</a></h2>
            <p>${escapeHtml(guide.about)}</p>
            <ul class="docs-list">
              ${guide.pages.map((p) => `<li><a href="${pageUrl(guide, p)}">${escapeHtml(p.title)}</a></li>`).join("\n              ")}
            </ul>
          </section>`,
  )
  .join("\n")}
        </div>
        </article>`;
  files.set("index.html", {
    main: index,
    title: "OwnBase docs",
    about: "How to host OwnBase, the self-hosted team chat, and connect apps to it.",
    url: "/docs/",
    current: null,
    toc: null,
  });

  // Ids repeat across the two guides, so the index keeps which page holds each.
  const search = `${JSON.stringify({ pages, entries })}\n`;
  const assets = {
    siteCss: shortHash(readAsset("apps/site/site.css")),
    docsCss: shortHash(readAsset("apps/site/docs.css")),
    docsJs: shortHash(readAsset("apps/site/docs.js")),
    search: shortHash(search),
  };
  const out = new Map([["search.json", search]]);
  for (const [path, page] of files) out.set(path, layout({ ...page, assets, guides }));
  return out;
}

/** Every file under `dir`, as paths relative to `base` with forward slashes. */
function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? listFiles(path, base)
      : [relative(base, path).replaceAll("\\", "/")];
  });
}

/** Paths under `dir` that differ from `site`: changed, missing or left over. */
export function staleFiles(site, dir) {
  const stale = [];
  for (const [path, content] of site) {
    const file = join(dir, path);
    if (!existsSync(file) || readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== content)
      stale.push(path);
  }
  for (const path of listFiles(dir)) if (!site.has(path)) stale.push(path);
  return stale;
}

export function writeSite(site, dir) {
  for (const path of listFiles(dir)) if (!site.has(path)) rmSync(join(dir, path));
  for (const [path, content] of site) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const dir = outAt >= 0 ? resolve(args[outAt + 1]) : resolve(repoRoot, OUTPUT);
  const site = buildSite();
  if (args.includes("--check")) {
    const stale = staleFiles(site, dir);
    if (stale.length) {
      console.error(`The docs pages are stale. Run pnpm docs:build.\n  ${stale.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`The docs pages are current: ${site.size} files.`);
  } else {
    writeSite(site, dir);
    const bytes = [...site.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    console.log(
      `Wrote ${site.size} files to ${relative(repoRoot, dir) || "."}: ${(bytes / 1024).toFixed(0)} KiB.`,
    );
  }
}
