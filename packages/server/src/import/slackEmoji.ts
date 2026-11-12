import table from "./slackEmoji.json";

/**
 * Slack names a reaction by its shortcode, `+1` or `thumbsup`, with a skin
 * tone as `+1::skin-tone-3`. This app keeps the emoji itself. The table is
 * written by scripts/generate-emoji.mjs from the data the picker uses, whose
 * shortcodes are Slack's.
 */
const names: Record<string, string> = {
  ...table.names,
  // Slack's own name for 🙂 before Unicode had one, still in exports from then.
  simple_smile: "🙂",
};
const tones: Record<string, string[]> = table.tones;

const TONED = /^(.+)::skin-tone-([2-6])$/;
/** A name that is already an emoji, as an export of this app writes one it has no name for. */
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** The emoji a Slack reaction name stands for, or null for a custom or unknown one. */
export function emojiForSlackName(name: string): string | null {
  const toned = TONED.exec(name);
  if (toned) return tones[toned[1]!]?.[Number(toned[2]) - 2] ?? names[toned[1]!] ?? null;
  if (Object.hasOwn(names, name)) return names[name]!;
  return PICTOGRAPH.test(name) ? name : null;
}

let byEmoji: Map<string, string> | null = null;

/** The name Slack would give a reaction: its first shortcode, or the emoji itself when it has none. */
export function slackNameForEmoji(emoji: string): string {
  if (!byEmoji) {
    // The shortcodes come before the other names, so each emoji keeps its first.
    byEmoji = new Map();
    for (const [name, plain] of Object.entries(names))
      if (!byEmoji.has(plain)) byEmoji.set(plain, name);
    for (const [name, skins] of Object.entries(tones))
      skins.forEach((skin, i) => {
        if (!byEmoji!.has(skin)) byEmoji!.set(skin, `${name}::skin-tone-${i + 2}`);
      });
  }
  return byEmoji.get(emoji) ?? emoji;
}
