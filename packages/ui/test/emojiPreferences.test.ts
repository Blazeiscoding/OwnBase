import { describe, expect, it, vi } from "vitest";
import {
  FREQUENT_COUNT,
  emojiPreferences,
  frequentEmoji,
  writeEmoji,
} from "../src/lib/emojiPreferences.js";
import { emojiNamed } from "../src/lib/emojiSet.js";
import type { Platform } from "../src/platform.js";

/** A device whose storage holds `saved`, answering when `answer` is resolved if given. */
function device(saved: unknown = null, answer?: Promise<void>) {
  const set = vi.fn(async (_key: string, _value: unknown) => {});
  const platform = {
    storage: {
      get: async () => {
        await answer;
        return saved;
      },
      set,
    },
  } as unknown as Platform;
  return { platform, set };
}

const settled = () => new Promise((done) => setTimeout(done, 0));

describe("this device's emoji choices", () => {
  it("fill the first row with common emoji until someone's own fill it", () => {
    const starters = frequentEmoji({});
    expect(starters).toHaveLength(FREQUENT_COUNT);
    expect(starters.slice(0, 3)).toEqual(["👍", "❤️", "😂"]);
    const own = frequentEmoji({ "🌮": [5, 1], "🔥": [2, 9], "👍": [2, 3] });
    // Most used first, the latest of equals before the other.
    expect(own.slice(0, 4)).toEqual(["🌮", "🔥", "👍", "❤️"]);
    expect(own).toHaveLength(FREQUENT_COUNT);
    expect(new Set(own).size).toBe(own.length);
  });

  it("keep the skin tone and what was used on this device", async () => {
    const { platform, set } = device();
    const store = emojiPreferences(platform);
    await settled();
    store.getState().setTone(3);
    store.getState().countUse("🚀");
    store.getState().countUse("🚀");
    expect(set).toHaveBeenLastCalledWith("emoji", {
      tone: 3,
      used: { "🚀": [2, expect.any(Number)] },
    });
    const again = emojiPreferences(device(set.mock.lastCall![1]).platform);
    await settled();
    expect(again.getState().tone).toBe(3);
    expect(frequentEmoji(again.getState().used)[0]).toBe("🚀");
  });

  it("keep a choice made before what was saved has been read", async () => {
    let answer!: () => void;
    const { platform, set } = device(
      { tone: 2, used: { "🔥": [5, 1] } },
      new Promise((done) => (answer = done)),
    );
    const store = emojiPreferences(platform);
    store.getState().countUse("🚀");
    expect(set).not.toHaveBeenCalled();
    answer();
    await settled();
    expect(store.getState().tone).toBe(2);
    expect(Object.keys(store.getState().used).sort()).toEqual(["🔥", "🚀"]);
    expect(set).toHaveBeenCalledOnce();
  });

  it("start afresh from what cannot be read", async () => {
    const store = emojiPreferences(device({ tone: 99, used: "lots" }).platform);
    await settled();
    expect(store.getState().tone).toBe(0);
    expect(store.getState().used).toEqual({});
  });

  it("write an emoji in the tone chosen, and count it", async () => {
    const { platform } = device({ tone: 4, used: {} });
    await settled();
    emojiPreferences(platform);
    await settled();
    expect(writeEmoji(platform, emojiNamed("wave")!)).toBe("👋🏾");
    expect(writeEmoji(platform, emojiNamed("tada")!)).toBe("🎉");
    expect(emojiPreferences(platform).getState().used["👋"]?.[0]).toBe(1);
  });
});
