// Maintainer command: node scripts/generate-emoji.mjs
//
// Writes the files the emoji in the app come from. All are checked in, so a
// build needs neither this script nor the two packages it reads:
//
//   packages/ui/src/lib/emojiData.json  every emoji the pickers offer, with
//     the names Slack knows them by, from @emoji-mart/data
//   packages/ui/fonts/noto-color-emoji.woff2  Noto Color Emoji, from
//     @fontsource/noto-color-emoji, without the copy of every glyph it does
//     not need
//   packages/ui/fonts/OFL.txt  the font's license, which travels with it
//   packages/ui/src/emoji.css  the face that loads the font
//
// Run it again after changing the version of either package. With --check it
// writes nothing and fails if a file is not what it would write.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));
const installed = createRequire(join(root, "package.json"));

/** The sections of the picker, in Slack's order and under its names. */
const CATEGORY_NAMES = {
  people: "Smileys & People",
  nature: "Animals & Nature",
  foods: "Food & Drink",
  activity: "Activity",
  places: "Travel & Places",
  objects: "Objects",
  symbols: "Symbols",
  flags: "Flags",
};

/** The flags that are not a country's, in Unicode's order, before the countries. */
const OTHER_FLAGS = ["🏁", "🚩", "🎌", "🏴", "🏳️", "🏳️‍🌈", "🏳️‍⚧️", "🏴‍☠️"];

/**
 * Where a flag goes: the others first, then each country by its two letters,
 * then England, Scotland and Wales. The data lists them by shortcode, which
 * puts China and Germany ("cn", "de") before Afghanistan ("flag-af").
 */
function flagPlace([char]) {
  const other = OTHER_FLAGS.indexOf(char);
  if (other >= 0) return `0${String(other).padStart(2, "0")}`;
  const letters = [...char]
    .map((c) => c.codePointAt(0))
    .filter((code) => code >= 0x1f1e6 && code <= 0x1f1ff)
    .map((code) => String.fromCharCode(code - 0x1f1e6 + 65))
    .join("");
  return letters.length === 2 ? `1${letters}` : `2${char}`;
}

export function emojiData() {
  const source = JSON.parse(
    readFileSync(installed.resolve("@emoji-mart/data/sets/15/native.json"), "utf8"),
  );
  const seen = new Set();
  const categories = source.categories.map((category) => {
    const name = CATEGORY_NAMES[category.id];
    if (!name) throw new Error(`No name for the category "${category.id}"`);
    const rows = category.emojis.map((id) => {
      const emoji = source.emojis[id];
      const [plain, ...tones] = emoji.skins.map((skin) => skin.native);
      if (seen.has(plain)) throw new Error(`${plain} is listed twice`);
      seen.add(plain);
      if (tones.length !== 0 && tones.length !== 5)
        throw new Error(`${id} has ${tones.length} skin tones, not 5`);
      // Words the id and the name do not already say, to search by.
      const said = new Set(`${id} ${emoji.name}`.toLowerCase().split(/[^a-z0-9+]+/));
      const keywords = [
        ...new Set(emoji.keywords.map((word) => word.toLowerCase().trim()).filter(Boolean)),
      ].filter((word) => !said.has(word));
      const row = [plain, id, emoji.name, keywords.join(" ")];
      if (tones.length) row.push(tones);
      return row;
    });
    if (category.id === "flags")
      rows.sort((a, b) => (flagPlace(a) < flagPlace(b) ? -1 : flagPlace(a) > flagPlace(b) ? 1 : 0));
    return [category.id, name, rows];
  });
  const ids = new Set(Object.keys(source.emojis));
  const aliases = Object.fromEntries(
    Object.entries(source.aliases)
      .filter(([alias, id]) => ids.has(id) && !ids.has(alias))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  // One emoji to a line, so a new version of the data reads as a diff.
  const lines = ["{", '  "categories": ['];
  categories.forEach(([id, name, rows], c) => {
    lines.push(`    [${JSON.stringify(id)}, ${JSON.stringify(name)}, [`);
    rows.forEach((row, r) =>
      lines.push(`      ${JSON.stringify(row)}${r === rows.length - 1 ? "" : ","}`),
    );
    lines.push(`    ]]${c === categories.length - 1 ? "" : ","}`);
  });
  lines.push("  ],", `  "aliases": ${JSON.stringify(aliases)}`, "}", "");
  return lines.join("\n");
}

const fontPackage = () => dirname(installed.resolve("@fontsource/noto-color-emoji/package.json"));

/** The tags a WOFF2 table directory names by number, in the format's order. */
const KNOWN_TAGS =
  "cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG  sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill"
    .match(/.{4} ?/g)
    .map((tag) => tag.slice(0, 4));

/** A WOFF2 font's tables, each with its directory entry and its stored bytes. */
export function woff2Tables(font) {
  if (font.toString("latin1", 0, 4) !== "wOF2") throw new Error("Not a WOFF2 font");
  if (font.readUInt32BE(28) || font.readUInt32BE(40))
    throw new Error("The font carries metadata or private data, which this does not copy");
  const count = font.readUInt16BE(12);
  let at = 48;
  const number = () => {
    let value = 0;
    for (;;) {
      const byte = font[at++];
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
  };
  const entries = [];
  for (let i = 0; i < count; i++) {
    const start = at;
    const flags = font[at++];
    const known = flags & 0x3f;
    let tag = KNOWN_TAGS[known];
    if (known === 63) {
      tag = font.toString("latin1", at, at + 4);
      at += 4;
    }
    const length = number();
    // glyf and loca are stored transformed unless marked otherwise; the rest the other way round.
    const transformed = tag === "glyf" || tag === "loca" ? flags >> 6 === 0 : flags >> 6 !== 0;
    entries.push({
      tag,
      length,
      stored: transformed ? number() : length,
      entry: font.subarray(start, at),
    });
  }
  const data = brotliDecompressSync(font.subarray(at, at + font.readUInt32BE(20)));
  let offset = 0;
  for (const entry of entries) {
    entry.data = data.subarray(offset, offset + entry.stored);
    offset += entry.stored;
  }
  if (offset !== data.length) throw new Error("The font's tables do not add up to its data");
  return entries;
}

/**
 * Noto Color Emoji as one file holds every glyph twice: as layered vectors
 * (COLR), which Chromium and Firefox draw, and as SVG, which only Safari and
 * Firefox do and which is four fifths of the file. Safari is left with the
 * device's own emoji (see emoji.css), so the SVG copy is dropped.
 */
function emojiFontTables() {
  const font = readFileSync(join(fontPackage(), "files/noto-color-emoji-emoji-400-normal.woff2"));
  const tables = woff2Tables(font);
  if (!tables.some((table) => table.tag === "COLR")) throw new Error("The font has no COLR table");
  return { header: font.subarray(0, 48), tables: tables.filter((table) => table.tag !== "SVG ") };
}

export function emojiFont() {
  const { header: original, tables } = emojiFontTables();
  const stream = Buffer.concat(tables.map((table) => table.data));
  const compressed = brotliCompressSync(stream, {
    params: {
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT,
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: stream.length,
    },
  });
  const directory = Buffer.concat(tables.map((table) => table.entry));
  const end = 48 + directory.length + compressed.length;
  const length = Math.ceil(end / 4) * 4;
  const header = Buffer.from(original);
  header.writeUInt32BE(length, 8);
  header.writeUInt16BE(tables.length, 12);
  // What the font takes unpacked: its header, a directory row and the padded bytes per table.
  header.writeUInt32BE(
    tables.reduce((sum, table) => sum + 16 + Math.ceil(table.length / 4) * 4, 12),
    16,
  );
  header.writeUInt32BE(compressed.length, 20);
  return Buffer.concat([header, directory, compressed, Buffer.alloc(length - end)]);
}

/** Whether a font on disk holds the tables this would write. Its packing may differ by Node version. */
function emojiFontIsCurrent(file) {
  let current;
  try {
    current = woff2Tables(readFileSync(file));
  } catch {
    return false;
  }
  const wanted = emojiFontTables().tables;
  return (
    current.length === wanted.length &&
    current.every(
      (table, i) => table.entry.equals(wanted[i].entry) && table.data.equals(wanted[i].data),
    )
  );
}

export function emojiCss() {
  const pkg = fontPackage();
  const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  // The package's own faces cut the emoji into slices; together they say which
  // characters the font is for.
  const css = readFileSync(join(pkg, "index.css"), "utf8");
  const covered = new Set();
  for (const [, ranges] of css.matchAll(/unicode-range: ([^;]+);/g))
    for (const range of ranges.split(",")) {
      const [from, to = from] = range.trim().slice(2).split("-");
      for (let code = parseInt(from, 16); code <= parseInt(to, 16); code++) covered.add(code);
    }
  if (covered.size === 0) throw new Error("Found no unicode-range in the font package");
  const codes = [...covered].sort((a, b) => a - b);
  const ranges = [];
  for (let i = 0; i < codes.length; i++) {
    const from = codes[i];
    while (codes[i + 1] === codes[i] + 1) i++;
    const hex = (code) => code.toString(16);
    ranges.push(from === codes[i] ? `U+${hex(from)}` : `U+${hex(from)}-${hex(codes[i])}`);
  }
  const lines = [];
  for (let line = "", i = 0; i <= ranges.length; i++) {
    const next = ranges[i];
    if (next === undefined || line.length + next.length + 2 > 78) {
      lines.push(`      ${line}${next === undefined ? ";" : ","}`);
      line = "";
    }
    if (next !== undefined) line += (line ? ", " : "") + next;
  }
  return `/*
 * Noto Color Emoji ${version}, written by scripts/generate-emoji.mjs: do not edit.
 *
 * One face, bundled, so emoji look the same on every device and with no
 * internet. Its glyphs are layered vectors (COLRv1), which Safari cannot draw:
 * it is left with the emoji of the device it runs on, and so is any browser
 * that cannot say it draws them. The range keeps the font from being fetched
 * for a character it does not have. Emoji stay hidden until it arrives, rather
 * than showing in the device's own and then changing.
 */
@supports (font-tech(color-COLRv1)) {
  @font-face {
    font-family: "Noto Color Emoji";
    font-display: block;
    src: url("../fonts/noto-color-emoji.woff2") format("woff2");
    unicode-range:
${lines.join("\n")}
  }
}
`;
}

const text = (write) => ({
  write,
  current: (file, wanted) => {
    try {
      return readFileSync(file, "utf8").replace(/\r\n/g, "\n") === wanted;
    } catch {
      return false;
    }
  },
});

export const OUTPUTS = {
  "packages/ui/src/lib/emojiData.json": text(emojiData),
  "packages/ui/src/emoji.css": text(emojiCss),
  "packages/ui/fonts/OFL.txt": text(() =>
    readFileSync(join(fontPackage(), "LICENSE"), "utf8").replace(/\r\n/g, "\n"),
  ),
  "packages/ui/fonts/noto-color-emoji.woff2": {
    write: emojiFont,
    current: (file) => emojiFontIsCurrent(file),
  },
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes("--check");
  let stale = false;
  for (const [path, output] of Object.entries(OUTPUTS)) {
    const file = join(root, path);
    if (check) {
      const wanted = output.current.length > 1 ? output.write() : undefined;
      if (output.current(file, wanted)) continue;
      console.error(`${path} is out of date. Run: node scripts/generate-emoji.mjs`);
      stale = true;
      continue;
    }
    const content = output.write();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    console.log(`Wrote ${path}: ${(Buffer.byteLength(content) / 1000).toFixed(1)} kB`);
  }
  if (stale) process.exit(1);
}
