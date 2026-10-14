import { useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { PlatformContext } from "../context.js";
import type { Platform } from "../platform.js";
import { inTone, type Emoji, type Liking } from "./emojiSet.js";

/**
 * What someone has chosen about emoji, kept on this device: the skin tone
 * theirs are drawn in, and which they use, for the picker's first row.
 */
export const SKIN_TONES = [
  "Default",
  "Light",
  "Medium-light",
  "Medium",
  "Medium-dark",
  "Dark",
] as const;

/** What the first row holds until someone's own choices fill it. */
const STARTERS = [
  "👍",
  "❤️",
  "😂",
  "🎉",
  "🙏",
  "👀",
  "✅",
  "🙌",
  "🔥",
  "😊",
  "🤔",
  "👏",
  "🚀",
  "💯",
  "😢",
  "😍",
  "👋",
  "😅",
];
/** Two rows of the picker. */
export const FREQUENT_COUNT = STARTERS.length;
/** How many emoji a device remembers the use of. */
const REMEMBERED = 60;
const KEY = "emoji";

interface Choices {
  /** 0 as drawn, 1 to 5 light to dark. */
  tone: number;
  /** For each emoji used, in its default tone: how often, and when last. */
  used: Record<string, [count: number, last: number]>;
}

export interface EmojiPreferences extends Choices {
  setTone: (tone: number) => void;
  /** Counts one use of an emoji, given in its default tone. */
  countUse: (char: string) => void;
}

function choicesFrom(saved: unknown): Choices {
  const choices: Choices = { tone: 0, used: {} };
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return choices;
  const { tone, used } = saved as Record<string, unknown>;
  if (typeof tone === "number" && Number.isInteger(tone) && tone >= 0 && tone < SKIN_TONES.length)
    choices.tone = tone;
  if (used && typeof used === "object" && !Array.isArray(used))
    for (const [char, value] of Object.entries(used).slice(0, REMEMBERED)) {
      if (!Array.isArray(value) || char.length > 64) continue;
      const [count, last] = value as unknown[];
      if (typeof count === "number" && count > 0 && typeof last === "number")
        choices.used[char] = [Math.floor(count), last];
    }
  return choices;
}

/** Most used first, the latest of equals before the rest. */
const byUse = (a: [string, [number, number]], b: [string, [number, number]]) =>
  b[1][0] - a[1][0] || b[1][1] - a[1][1];

/** The emoji for the picker's first row: someone's own, then the starters to fill it. */
export function frequentEmoji(used: Choices["used"]): string[] {
  const own = Object.entries(used)
    .sort(byUse)
    .map(([char]) => char);
  return [...own, ...STARTERS.filter((char) => !(char in used))].slice(0, FREQUENT_COUNT);
}

/**
 * How much an emoji is favoured here, for ordering what a search or a colon
 * finds: how often it was used, and a little for the common ones that start
 * the picker, so a first ":ta" still offers :tada: first.
 */
export function likedBy(used: Choices["used"]): Liking {
  return (emoji) => (used[emoji.char]?.[0] ?? 0) + (STARTERS.includes(emoji.char) ? 0.5 : 0);
}

function createPreferences(platform: Platform | null): StoreApi<EmojiPreferences> {
  // Changes made before what was saved has been read are made again on top of it.
  let early: ((choices: Choices) => Choices)[] | null = [];
  const save = () => {
    const { tone, used } = store.getState();
    void platform?.storage.set(KEY, { tone, used }).catch(() => {
      // Still in effect here; there is nothing more to do about it.
    });
  };
  const change = (apply: (choices: Choices) => Choices) => {
    store.setState(apply(store.getState()));
    if (early) early.push(apply);
    else save();
  };
  const store = createStore<EmojiPreferences>(() => ({
    tone: 0,
    used: {},
    setTone: (tone) => change((choices) => ({ ...choices, tone })),
    countUse: (char) =>
      change((choices) => {
        const used = { ...choices.used, [char]: [(choices.used[char]?.[0] ?? 0) + 1, Date.now()] };
        const kept = Object.entries(used as Choices["used"])
          .sort(byUse)
          .slice(0, REMEMBERED);
        return { ...choices, used: Object.fromEntries(kept) };
      }),
  }));
  void Promise.resolve()
    .then(() => platform?.storage.get<unknown>(KEY))
    .catch(() => null)
    .then((saved) => {
      const made = early ?? [];
      early = null;
      store.setState(made.reduce((choices, apply) => apply(choices), choicesFrom(saved)));
      if (made.length) save();
    });
  return store;
}

const stores = new WeakMap<Platform, StoreApi<EmojiPreferences>>();
/** Where there is no platform, as in a test of one component, choices last as long as the page. */
let unsaved: StoreApi<EmojiPreferences> | null = null;

export function emojiPreferences(platform: Platform | null): StoreApi<EmojiPreferences> {
  if (!platform) return (unsaved ??= createPreferences(null));
  let store = stores.get(platform);
  if (!store) stores.set(platform, (store = createPreferences(platform)));
  return store;
}

/** An emoji as this device writes it: in its skin tone, and counted as used. */
export function writeEmoji(platform: Platform | null, emoji: Emoji): string {
  const store = emojiPreferences(platform);
  store.getState().countUse(emoji.char);
  return inTone(emoji, store.getState().tone);
}

/** This device's emoji choices, read once and shared by every picker. */
export function useEmojiPreferences(): EmojiPreferences {
  return useStore(emojiPreferences(useContext(PlatformContext)));
}
