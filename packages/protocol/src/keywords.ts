/**
 * Keyword alerts (K11): words or short phrases a person wants to hear about
 * as if they were mentioned. A message has a keyword when its words hold the
 * keyword's words side by side, as whole words, whatever their case or
 * accents: "release" finds "Release!" and "réléase", not "released".
 *
 * Words are cut as the server's search index cuts them (SQLite's unicode61
 * tokenizer over `searchText`), so Activity, which finds keyword hits through
 * that index, and a notification, which uses this, agree: letters, digits and
 * the marks on them make words, anything else ends one, accents come off Latin
 * letters only, and each character of a writing system without spaces between
 * words is a word of its own, so 発表 is found in 新製品の発表会.
 */

/** How many keywords one account keeps. */
export const KEYWORDS_MAX = 20;
/** The longest keyword, in characters. */
export const KEYWORD_LENGTH_MAX = 50;

/**
 * Writing systems that put no spaces between words. The same ranges as the
 * server's `UNSPACED_RANGES` (search/words.ts), which a server test holds to
 * these.
 */
export const UNSPACED_RANGES: readonly (readonly [first: number, last: number])[] = [
  [0x0e00, 0x0eff],
  [0x1000, 0x109f],
  [0x1100, 0x11ff],
  [0x1780, 0x17ff],
  [0x3040, 0x30ff],
  [0x3130, 0x318f],
  [0x31f0, 0x31ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa960, 0xa97f],
  [0xac00, 0xd7ff],
  [0xf900, 0xfaff],
  [0xff66, 0xffdc],
  [0x20000, 0x3ffff],
];

const WORD_CHAR = /[\p{L}\p{N}\p{M}\p{Co}]/u;
const MARK = /\p{M}/u;
const LATIN_ACCENTS = /[̀-ͯ]/g;

/** One word of a text, folded for matching, and where it stands in the text. */
export interface WordSpan {
  word: string;
  start: number;
  end: number;
}

/** A text's words, folded: lower case, and Latin letters without their accents. */
export function wordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  let open: WordSpan | null = null;
  let openAlone = false;
  let latin = false;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    const size = cp > 0xffff ? 2 : 1;
    const ch = text.slice(i, i + size);
    if (!WORD_CHAR.test(ch)) {
      open = null;
    } else {
      if (!MARK.test(ch)) latin = cp < 0x250 || (cp >= 0x1e00 && cp <= 0x1eff);
      let folded = ch.normalize("NFD");
      if (latin) folded = folded.replace(LATIN_ACCENTS, "");
      folded = folded.toLowerCase();
      const alone = UNSPACED_RANGES.some(([first, last]) => cp >= first && cp <= last);
      if (open && !alone && !openAlone) {
        open.word += folded;
        open.end = i + size;
      } else if (folded) {
        open = { word: folded, start: i, end: i + size };
        openAlone = alone;
        spans.push(open);
      }
    }
    i += size;
  }
  return spans;
}

/**
 * A keyword as it is compared: its words, folded, one space between. Two
 * keywords with the same key are the same keyword; one whose key is empty
 * has no words and can never be found.
 */
export const keywordKey = (keyword: string) =>
  wordSpans(keyword)
    .map((span) => span.word)
    .join(" ");

/** Each place in `text` a keyword stands, in order, the longest keyword first where two start together. */
export function keywordMatches(
  text: string,
  keywords: readonly string[],
): { keyword: string; start: number; end: number }[] {
  if (keywords.length === 0) return [];
  const wanted = keywords
    .map((keyword) => ({ keyword, words: wordSpans(keyword).map((span) => span.word) }))
    .filter((k) => k.words.length > 0)
    .sort((a, b) => b.words.length - a.words.length);
  const words = wordSpans(text);
  const found: { keyword: string; start: number; end: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    const hit = wanted.find((k) => k.words.every((word, j) => words[i + j]?.word === word));
    if (!hit) continue;
    const last = i + hit.words.length - 1;
    found.push({ keyword: hit.keyword, start: words[i]!.start, end: words[last]!.end });
    i = last;
  }
  return found;
}

/** The first of a person's keywords that a message's text holds, or null. */
export const keywordIn = (text: string, keywords: readonly string[]): string | null =>
  keywordMatches(text, keywords)[0]?.keyword ?? null;
