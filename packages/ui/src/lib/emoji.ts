import { useEffect, useState } from "react";

/**
 * The emoji table, its search and this device's emoji choices, fetched on
 * first use: with every emoji it is far too big for the page every visit
 * downloads. The workspace asks for it as it opens, so it is usually here
 * before anyone types a colon.
 */
export type EmojiKit = typeof import("./emojiSet.js") & typeof import("./emojiPreferences.js");

let kit: EmojiKit | null = null;
let loading: Promise<EmojiKit> | null = null;

export function loadEmoji(): Promise<EmojiKit> {
  return (loading ??= Promise.all([import("./emojiSet.js"), import("./emojiPreferences.js")]).then(
    ([set, preferences]) => (kit = { ...set, ...preferences }),
    (error: unknown) => {
      // Asked for again next time, as after a dropped connection.
      loading = null;
      throw error;
    },
  ));
}

/** The kit once it has arrived, or null. It is asked for while `wanted`. */
export function useEmoji(wanted: boolean): EmojiKit | null {
  const [, arrived] = useState(false);
  useEffect(() => {
    if (!wanted || kit) return;
    let current = true;
    loadEmoji().then(
      () => current && arrived(true),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [wanted]);
  return kit;
}

// What a message of emoji alone is made of: pictographs, flags' letters, skin
// tones, keycaps, and the joiners and selectors between them.
const EMOJI_ALONE =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[#*0-9]️?⃣|[‍️\u{E0020}-\u{E007F}]|\s)+$/u;

/**
 * A message of nothing but a few emoji, which Slack and Discord show large.
 * A long run of them stays the size of text.
 */
export function onlyEmoji(text: string): boolean {
  return text.length <= 64 && EMOJI_ALONE.test(text) && /[^\s️]/u.test(text);
}
