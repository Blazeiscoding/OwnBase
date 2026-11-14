/**
 * Characters of writing systems that put no spaces between words. Korean puts
 * spaces between phrases, but often runs a compound and its endings together,
 * so it is here too.
 *
 * Written out as code points, not `\p{Script=...}`, so the same text is split
 * the same way by every Node that will ever open the workspace: the index was
 * built by whichever ran the upgrade and is searched by whichever runs now,
 * and a workspace folder can move between the desktop app's Electron and the
 * host's Node. `Intl.Segmenter` was turned down for the same reason (its
 * dictionaries change with ICU), and because it splits a run of katakana one
 * way inside a sentence and another way when it is searched for alone.
 */
const UNSPACED_RANGES: [first: number, last: number][] = [
  [0x0e00, 0x0eff], // Thai, Lao
  [0x1000, 0x109f], // Myanmar
  [0x1100, 0x11ff], // Hangul jamo
  [0x1780, 0x17ff], // Khmer
  [0x3040, 0x30ff], // Hiragana, Katakana
  [0x3130, 0x318f], // Hangul compatibility jamo
  [0x31f0, 0x31ff], // Katakana for Ainu
  [0x3400, 0x4dbf], // Chinese characters, extension A
  [0x4e00, 0x9fff], // Chinese characters
  [0xa960, 0xa97f], // Hangul jamo, extended A
  [0xac00, 0xd7ff], // Hangul syllables, jamo extended B
  [0xf900, 0xfaff], // Chinese compatibility characters
  [0xff66, 0xffdc], // Half-width katakana and Hangul
  [0x20000, 0x3ffff], // Rarer Chinese characters
];
const UNSPACED_CLASS = `[${UNSPACED_RANGES.map(
  ([first, last]) => `\\u{${first.toString(16)}}-\\u{${last.toString(16)}}`,
).join("")}]`;
const UNSPACED = new RegExp(UNSPACED_CLASS, "u");
const EACH_UNSPACED = new RegExp(UNSPACED_CLASS, "gu");

/**
 * Text as the search index holds it, and as a search is matched against it:
 * each character of the writing systems above is a word of its own, so a
 * search for several of them, side by side, is a phrase that finds them in
 * the middle of a sentence. Every other character is left as it is, so the
 * index's words for anything else are the ones SQLite's tokenizer has always
 * made.
 *
 * The migration that built the index and the triggers that keep it call this
 * through SQL (`ownbase_search_text`), so changing what it returns needs a
 * migration that rebuilds the index.
 */
export function searchText(text: string): string {
  return UNSPACED.test(text) ? text.replace(EACH_UNSPACED, " $& ") : text;
}
