/**
 * What a paste of formatted text (a web page, a document, another message)
 * keeps, written as the composer's own markup, as Slack does: a link keeps
 * its address as <url|words>, and bold, italic, struck-through words, code,
 * quotes and lists keep their marks. A browser pastes only the words into a
 * text box, so a link copied from a document used to arrive as its words with
 * no address.
 *
 * Gives null when the formatting adds nothing the plain text lacks, so the
 * browser's own paste goes ahead, and for a copy from a code editor, whose
 * lines and indentation only the plain text keeps (`white-space: pre`).
 */
export function mrkdwnFromHtml(html: string): string | null {
  if (!html || typeof DOMParser === "undefined") return null;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  if (!body) return null;
  if (body.querySelector('[style*="white-space: pre"], [style*="white-space:pre"]')) return null;
  if (!worthKeeping(body)) return null;
  const text = edges(blocks(body, { pre: false }))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

const LINK = /^https?:\/\//i;

/**
 * A block's edge, made one line break once the text around it is written:
 * where two blocks meet is one break, however many edges meet there, and a
 * break written inside, as an empty paragraph's, still counts.
 */
const EDGE = "\u0000";
const edges = (text: string) => text.replace(/\n*\u0000+/g, "\n");

/** Something a plain-text paste would lose: a link with words of its own, or a mark. */
function worthKeeping(body: HTMLElement): boolean {
  for (const a of body.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    const words = a.textContent?.trim() ?? "";
    if (LINK.test(href) && words && words !== href) return true;
  }
  if (body.querySelector("b, strong, i, em, s, strike, del, code, pre, ul, ol, blockquote"))
    return true;
  return [...body.querySelectorAll<HTMLElement>("span[style]")].some(
    (span) => boldSpan(span) || italicSpan(span),
  );
}

interface Context {
  /** Inside a code block, where spaces and line breaks are the text's own. */
  pre: boolean;
}

const BLOCK = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "TR",
  "TABLE",
  "FIGURE",
]);
const SKIP = new Set(["SCRIPT", "STYLE", "HEAD", "TITLE", "META", "LINK", "TEMPLATE", "NOSCRIPT"]);

function blocks(node: Node, ctx: Context): string {
  let out = "";
  for (const child of node.childNodes) out += piece(child, ctx);
  return out;
}

function piece(node: Node, ctx: Context): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = (node.nodeValue ?? "").replaceAll(EDGE, "");
    return ctx.pre ? value : value.replace(/\s+/g, " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (SKIP.has(tag)) return "";
  const inner = () => blocks(el, ctx);
  switch (tag) {
    case "BR":
      return "\n";
    case "A": {
      const href = el.getAttribute("href") ?? "";
      const words = edges(inner()).trim();
      if (!LINK.test(href)) return words;
      if (!words || words === href) return href;
      // Nothing in the words may end the link or start a second label.
      const label = words.replace(/[|<>\s]+/g, " ").trim();
      return label ? `<${href}|${label}>` : href;
    }
    case "B":
    case "STRONG":
      return normalWeight(el) ? inner() : mark(inner(), "*");
    case "I":
    case "EM":
      return mark(inner(), "_");
    case "S":
    case "STRIKE":
    case "DEL":
      return mark(inner(), "~");
    case "CODE":
      return ctx.pre ? inner() : mark(inner(), "`");
    case "PRE": {
      const code = blocks(el, { pre: true }).replace(/\n$/, "");
      return `${EDGE}\`\`\`\n${code}\n\`\`\`${EDGE}`;
    }
    case "BLOCKQUOTE": {
      const lines = edges(inner()).trim().split("\n");
      return `${EDGE}${lines.map((line) => `> ${line}`).join("\n")}${EDGE}`;
    }
    case "UL":
    case "OL": {
      const start = Number(el.getAttribute("start")) || 1;
      const items = [...el.children].filter((child) => child.tagName === "LI");
      const lines = items.map((item, i) => {
        const words = blocks(item, ctx)
          .replace(/[\n\u0000]+/g, " ")
          .trim();
        return `${tag === "OL" ? `${start + i}.` : "-"} ${words}`;
      });
      return `${EDGE}${lines.join("\n")}${EDGE}`;
    }
    case "LI":
      return `${EDGE}- ${edges(inner()).trim()}${EDGE}`;
    case "TD":
    case "TH":
      return `${edges(inner()).trim()}\t`;
    case "SPAN":
      return boldSpan(el) ? mark(inner(), "*") : italicSpan(el) ? mark(inner(), "_") : inner();
    default:
      return BLOCK.has(tag) ? `${EDGE}${inner()}${EDGE}` : inner();
  }
}

/**
 * A mark around words, with the spaces inside moved out: "*bold *" is not bold
 * in Mrkdwn, and a mark around nothing is dropped.
 */
function mark(words: string, sign: string): string {
  const [, before = "", core = "", after = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(words) ?? [];
  if (!core) return words;
  return `${before}${sign}${core}${sign}${after}`;
}

/** Google Docs wraps a whole copy in <b style="font-weight:normal">. */
function normalWeight(el: HTMLElement): boolean {
  const weight = el.style.fontWeight;
  return weight === "normal" || weight === "400";
}

/** Google Docs marks bold and italic on spans. */
function boldSpan(el: HTMLElement): boolean {
  const weight = el.style.fontWeight;
  return weight === "bold" || weight === "bolder" || Number(weight) >= 600;
}

function italicSpan(el: HTMLElement): boolean {
  return el.style.fontStyle === "italic";
}

/**
 * The text a box holds once formatted text is pasted over its selection, and
 * where the caret goes, or null to leave the paste to the browser.
 */
export function pasteRich(
  text: string,
  start: number,
  end: number,
  html: string,
): { text: string; caret: number } | null {
  const pasted = mrkdwnFromHtml(html);
  if (pasted === null) return null;
  return { text: text.slice(0, start) + pasted + text.slice(end), caret: start + pasted.length };
}
