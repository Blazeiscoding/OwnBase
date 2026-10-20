import { getFromUrl, type OutboundOptions } from "./outbound.js";
import { imageSize } from "./imageSize.js";

/**
 * Link previews (E2): what a web page a message links to says about itself.
 *
 * The server reads the page, not the readers' devices, so nobody's address
 * reaches a site because someone else posted its link, and the picture comes
 * from the server too. Every request goes through the outbound guard with no
 * exception for private addresses, whatever `--allow-private-hooks` says: an
 * admin chose to let apps reach the network, but anyone can post a link, and a
 * preview of a router's admin page is exactly what the guard is for. Each
 * redirect is checked again, the page and the picture have size and time
 * limits, and the server never decodes a picture: it keeps one whose first
 * bytes say PNG, JPEG, WebP or GIF and whose header gives a sane size.
 */

/** How many links in one message get a preview, first ones first. */
export const MAX_PREVIEWS = 3;
/** The most of a page read; its head is near the start. */
const PAGE_BYTES = 512 * 1024;
/**
 * The largest picture kept. It is stored with the message and the server cannot
 * shrink one, and the 1200-pixel JPEGs pages name for previews run to several
 * hundred KB.
 */
export const PREVIEW_IMAGE_BYTES = 1024 * 1024;
/** Pixels on either side a kept picture may claim, and in all. */
const IMAGE_SIDE = 8000;
const IMAGE_PIXELS = 40_000_000;
const TIMEOUT_MS = 5000;

const LIMITS = { title: 200, description: 300, siteName: 80 };

export type PreviewImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface FetchedPreview {
  /** The address as the message has it. */
  url: string;
  title: string;
  description: string;
  siteName: string;
  image: { bytes: Buffer; type: PreviewImageType; width: number; height: number } | null;
}

/** What `fetchLinkPreview` takes besides the address; tests replace the guard's check. */
export type PreviewFetchOptions = Pick<OutboundOptions, "signal" | "blocked" | "timeoutMs">;

// The client's own grammar (Mrkdwn.tsx): Slack's <url|label> and <url>, and
// bare addresses. Code is not linked there, so it is skipped here.
const LINK_RE = /<(https?:\/\/[^\s|<>]+)(?:\|[^<>\n]+)?>|(https?:\/\/[^\s<>]+)/g;

/**
 * The addresses in a message's words that get a preview, at most
 * `MAX_PREVIEWS`, each once. Code blocks and inline code are left out, as
 * are addresses with a user name or password in them and links to a
 * conversation or message in a workspace (`#/c/...`), which the app opens
 * itself.
 */
export function previewLinks(text: string): string[] {
  const prose = text
    .split("```")
    .filter((_, i) => i % 2 === 0)
    .join(" ")
    .replace(/`[^`\n]+`/g, " ");
  const found: string[] = [];
  for (const m of prose.matchAll(LINK_RE)) {
    const url = m[1] ?? trimTrailing(m[2]!);
    if (found.includes(url) || !previewable(url)) continue;
    found.push(url);
    if (found.length === MAX_PREVIEWS) break;
  }
  return found;
}

/** Punctuation that ends a sentence rather than an address, and an unpaired ")". */
function trimTrailing(url: string): string {
  let out = url;
  for (;;) {
    const last = out.at(-1);
    if (last && ".,;:!?'\"*_~".includes(last)) out = out.slice(0, -1);
    else if (last === ")" && count(out, "(") < count(out, ")")) out = out.slice(0, -1);
    else return out;
  }
}

const count = (s: string, c: string) => s.split(c).length - 1;

function previewable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.hash.startsWith("#/c/")) return false;
  return parsed.hostname.length > 0;
}

/** What a page's head says about it, before any picture is fetched. */
export interface PageSummary {
  title: string;
  description: string;
  siteName: string;
  imageUrl: string | null;
}

/**
 * Reads Open Graph, then Twitter, then plain `<title>` and description data
 * from a page's HTML. Null when it has neither a title nor a description,
 * since a preview of nothing helps nobody.
 */
export function readPage(html: string, pageUrl: string): PageSummary | null {
  const end = html.search(/<\/head\s*>/i);
  const head = end === -1 ? html : html.slice(0, end);
  const meta = new Map<string, string>();
  for (const tag of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(tag[0]);
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const value = attrs.get("content");
    if (key && value !== undefined && !meta.has(key)) meta.set(key, value);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1] ?? "";
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = clean(meta.get(key) ?? "");
      if (value) return value;
    }
    return "";
  };
  const title = cut(pick("og:title", "twitter:title") || clean(titleTag), LIMITS.title);
  const description = cut(
    pick("og:description", "twitter:description", "description"),
    LIMITS.description,
  );
  if (!title && !description) return null;
  let host = "";
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {
    // An address that does not parse names no site.
  }
  const siteName = cut(pick("og:site_name", "application-name") || host, LIMITS.siteName);
  const image = pick(
    "og:image:secure_url",
    "og:image",
    "og:image:url",
    "twitter:image",
    "twitter:image:src",
  );
  return { title, description, siteName, imageUrl: image ? absolute(image, pageUrl) : null };
}

/** A tag's attributes, names lower-cased and values decoded. */
function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
  )) {
    const name = m[1]!.toLowerCase();
    if (!out.has(name)) out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** One line of plain text: tags, control characters and runs of spaces gone. */
function clean(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/g, " "))
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function absolute(url: string, base: string): string | null {
  try {
    const resolved = new URL(url, base);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.toString()
      : null;
  } catch {
    return null;
  }
}

/** The text of an HTML page, in the character set it says it uses. */
function decodePage(body: Buffer, contentType: string): string {
  const declared =
    /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(body.subarray(0, 4096).toString("latin1"))?.[1];
  if (declared) {
    try {
      return new TextDecoder(declared).decode(body);
    } catch {
      // A label TextDecoder does not know: read it as UTF-8, as browsers mostly do.
    }
  }
  return new TextDecoder("utf-8").decode(body);
}

/** The type a picture's first bytes say it is, of those a preview keeps, or null. */
export function previewImageType(bytes: Uint8Array): PreviewImageType | null {
  const at = (offset: number, ...expected: number[]) =>
    bytes.length >= offset + expected.length && expected.every((b, i) => bytes[offset + i] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  return null;
}

/**
 * Fetches one link's preview, or null when there is nothing to show: the page
 * cannot be reached through the guard, does not answer with HTML, or says
 * nothing about itself. A picture that cannot be kept leaves the preview
 * without one rather than without a preview.
 */
export async function fetchLinkPreview(
  url: string,
  opts: PreviewFetchOptions = {},
): Promise<FetchedPreview | null> {
  let page;
  try {
    page = await getFromUrl(url, {
      ...opts,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      maxBytes: PAGE_BYTES,
      truncate: true,
      timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
      maxRedirects: 3,
    });
  } catch {
    return null;
  }
  if (page.status < 200 || page.status > 299) return null;
  const type = page.contentType.split(";")[0]!.trim().toLowerCase();
  if (type !== "text/html" && type !== "application/xhtml+xml") return null;
  const summary = readPage(decodePage(page.body, page.contentType), page.url);
  if (!summary) return null;
  return {
    url,
    title: summary.title,
    description: summary.description,
    siteName: summary.siteName,
    image: summary.imageUrl ? await fetchImage(summary.imageUrl, opts) : null,
  };
}

async function fetchImage(
  url: string,
  opts: PreviewFetchOptions,
): Promise<FetchedPreview["image"]> {
  let res;
  try {
    res = await getFromUrl(url, {
      ...opts,
      accept: "image/png,image/jpeg,image/webp,image/gif;q=0.9",
      maxBytes: PREVIEW_IMAGE_BYTES,
      timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
      maxRedirects: 3,
    });
  } catch {
    return null;
  }
  if (res.status < 200 || res.status > 299) return null;
  const type = previewImageType(res.body);
  const size = type ? imageSize(res.body) : null;
  if (!type || !size) return null;
  const { width, height } = size;
  if (width < 1 || height < 1 || width > IMAGE_SIDE || height > IMAGE_SIDE) return null;
  if (width * height > IMAGE_PIXELS) return null;
  return { bytes: res.body, type, width, height };
}
