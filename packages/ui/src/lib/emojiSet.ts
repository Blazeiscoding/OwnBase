import data from "./emojiData.json";

/**
 * Every emoji the app offers, with the name Slack knows each by. The table is
 * about 130 kB, so this module is fetched on first use (see emoji.ts) rather
 * than with the page. scripts/generate-emoji.mjs writes the table.
 */
export interface Emoji {
  /** As drawn, in the default skin tone. */
  char: string;
  /** Its shortcode without the colons: "tada" for 🎉. */
  id: string;
  /** What a screen reader and the picker's footer call it. */
  name: string;
  /** In the five skin tones, light to dark, for an emoji that has them. */
  tones?: string[];
  /** Its shortcode and the other shortcodes that mean it, such as "thumbsup" for "+1". */
  names: string[];
  /** The words of its shortcodes and of its name. */
  parts: string[];
  /** Other words it is found by. */
  keywords: string[];
}

export interface EmojiCategory {
  id: string;
  name: string;
  emoji: Emoji[];
}

type Row = [char: string, id: string, name: string, keywords: string, tones?: string[]];

const aliases = new Map<string, string[]>();
for (const [alias, id] of Object.entries(data.aliases as Record<string, string>))
  aliases.set(id, [...(aliases.get(id) ?? []), alias]);

export const categories: EmojiCategory[] = (
  data.categories as unknown as [string, string, Row[]][]
).map(([id, name, rows]) => ({
  id,
  name,
  emoji: rows.map(([char, id, name, keywords, tones]) => {
    const names = [id, ...(aliases.get(id) ?? [])];
    return {
      char,
      id,
      name,
      tones,
      names,
      parts: [...names.flatMap((n) => n.split(/[_-]/)), ...name.toLowerCase().split(/[^a-z0-9]+/)]
        .filter(Boolean)
        .filter((part, i, parts) => parts.indexOf(part) === i),
      keywords: keywords ? keywords.split(" ") : [],
    };
  }),
}));

const all = categories.flatMap((category) => category.emoji);
const byName = new Map<string, Emoji>();
const byChar = new Map<string, Emoji>();
for (const emoji of all) {
  for (const name of emoji.names) byName.set(name, emoji);
  for (const char of [emoji.char, ...(emoji.tones ?? [])]) byChar.set(char, emoji);
}

/** The emoji a shortcode names, with or without its colons. */
export function emojiNamed(shortcode: string): Emoji | undefined {
  return byName.get(shortcode.replace(/^:|:$/g, "").toLowerCase());
}

/** The emoji a character is, in whatever skin tone it was written. */
export function emojiFor(char: string): Emoji | undefined {
  return byChar.get(char);
}

/** An emoji in a skin tone: 0 as drawn, 1 to 5 light to dark. One with no tones is itself. */
export function inTone(emoji: Emoji, tone: number): string {
  return emoji.tones?.[tone - 1] ?? emoji.char;
}

/**
 * How well a word finds an emoji, lower being closer, or -1 for not at all:
 * its shortcode exactly; a shortcode, or a word of a shortcode or of its name,
 * starting so; a keyword starting so; and with `anywhere`, the word inside a
 * shortcode. "party" finds :partying_face: and :tada: (Party Popper) equally.
 */
function closeness(emoji: Emoji, word: string, anywhere: boolean): number {
  if (emoji.names.includes(word)) return 0;
  if (emoji.names.some((name) => name.startsWith(word))) return 1;
  if (emoji.parts.some((part) => part.startsWith(word))) return 1;
  if (emoji.keywords.some((keyword) => keyword.startsWith(word))) return 2;
  if (anywhere && emoji.names.some((name) => name.includes(word))) return 3;
  return -1;
}

/** How much someone favours an emoji, higher first: see likedBy in emojiPreferences.ts. */
export type Liking = (emoji: Emoji) => number;

/**
 * Of emoji found equally well, the one liked more comes first, then the one
 * with the shorter shortcode, so ":ta" offers :tada: before :tangerine:.
 */
function ranked(words: string[], limit: number, anywhere: boolean, liked?: Liking): Emoji[] {
  if (words.length === 0) return [];
  const found: [score: number, liking: number, order: number, emoji: Emoji][] = [];
  all.forEach((emoji, order) => {
    let score = 0;
    for (const word of words) {
      const close = closeness(emoji, word, anywhere);
      if (close < 0) return;
      score += close;
    }
    found.push([score, liked?.(emoji) ?? 0, order, emoji]);
  });
  return found
    .sort((a, b) => a[0] - b[0] || b[1] - a[1] || a[3].id.length - b[3].id.length || a[2] - b[2])
    .slice(0, limit)
    .map(([, , , emoji]) => emoji);
}

/**
 * Emoji for what was typed into a picker's search, the closest first: every
 * word has to find the emoji. An emoji pasted in finds itself.
 */
export function searchEmoji(query: string, liked?: Liking, limit = 126): Emoji[] {
  const pasted = byChar.get(query.trim());
  if (pasted) return [pasted];
  return ranked(
    query
      .toLowerCase()
      .split(/[\s:]+/)
      .filter(Boolean),
    limit,
    true,
    liked,
  );
}

/**
 * Emoji for a word typed after a colon, as ":ta" offers :tada:. A word's
 * start only, so ":ar" does not offer a heart.
 */
export function emojiStartingWith(word: string, liked?: Liking, limit = 8): Emoji[] {
  return ranked([word.toLowerCase()], limit, false, liked);
}
