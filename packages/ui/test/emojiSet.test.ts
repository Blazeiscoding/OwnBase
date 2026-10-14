import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  categories,
  emojiFor,
  emojiNamed,
  emojiStartingWith,
  inTone,
  searchEmoji,
} from "../src/lib/emojiSet.js";
import { likedBy } from "../src/lib/emojiPreferences.js";
import { onlyEmoji } from "../src/lib/emoji.js";

const root = join(process.cwd(), "../..");
const chars = (list: { char: string }[]) => list.map((emoji) => emoji.char);

describe("the emoji table", () => {
  it("holds every emoji under Slack's sections, in Slack's order", () => {
    expect(categories.map((category) => category.name)).toEqual([
      "Smileys & People",
      "Animals & Nature",
      "Food & Drink",
      "Activity",
      "Travel & Places",
      "Objects",
      "Symbols",
      "Flags",
    ]);
    expect(categories.reduce((sum, category) => sum + category.emoji.length, 0)).toBeGreaterThan(
      1800,
    );
  });

  it("lists the flags as Unicode does, not by shortcode", () => {
    const flags = chars(categories.at(-1)!.emoji);
    // By shortcode, China and Germany ("cn", "de") came before Afghanistan ("flag-af").
    expect(flags.slice(0, 10)).toEqual([
      "🏁",
      "🚩",
      "🎌",
      "🏴",
      "🏳️",
      "🏳️‍🌈",
      "🏳️‍⚧️",
      "🏴‍☠️",
      "🇦🇨",
      "🇦🇩",
    ]);
    expect(flags.indexOf("🇨🇳")).toBeGreaterThan(flags.indexOf("🇦🇫"));
    expect(flags.at(-1)).toBe("🏴󠁧󠁢󠁷󠁬󠁳󠁿");
  });

  it("knows each emoji by the shortcodes Slack knows it by, with or without colons", () => {
    expect(emojiNamed("tada")?.char).toBe("🎉");
    expect(emojiNamed(":+1:")?.char).toBe("👍");
    expect(emojiNamed("thumbsup")?.char).toBe("👍");
    expect(emojiNamed("THUMBSUP")?.char).toBe("👍");
    expect(emojiNamed("not_an_emoji")).toBeUndefined();
  });

  it("knows an emoji written in any skin tone, and writes it in one", () => {
    const thumbs = emojiNamed("+1")!;
    expect(emojiFor("👍🏽")).toBe(thumbs);
    expect(inTone(thumbs, 0)).toBe("👍");
    expect(inTone(thumbs, 3)).toBe("👍🏽");
    expect(inTone(thumbs, 5)).toBe("👍🏿");
    // One with no tones is itself in any of them.
    expect(inTone(emojiNamed("tada")!, 5)).toBe("🎉");
  });
});

describe("searching the emoji", () => {
  const liked = likedBy({});

  it("finds an emoji by every word typed, the shortcode itself first", () => {
    expect(chars(searchEmoji("red heart", liked))).toEqual(["❤️"]);
    expect(searchEmoji("heart", liked)[0]?.char).toBe("❤️");
    expect(searchEmoji(":rocket:", liked)[0]?.char).toBe("🚀");
    expect(searchEmoji("zzzz", liked)).toEqual([]);
  });

  it("finds an emoji pasted in", () => {
    expect(chars(searchEmoji("🚀"))).toEqual(["🚀"]);
  });

  it("puts the common one first of those found as well, as :tada: for party", () => {
    expect(chars(searchEmoji("party", liked).slice(0, 2))).toEqual(["🎉", "🥳"]);
  });

  it("completes the start of a word after a colon, and only the start", () => {
    expect(emojiStartingWith("ta", liked)[0]?.id).toBe("tada");
    expect(chars(emojiStartingWith("ar", liked))).not.toContain("❤️");
    expect(emojiStartingWith("ta", liked).length).toBeLessThanOrEqual(8);
  });

  it("puts first what this person uses", () => {
    const used = likedBy({ "🌮": [3, 1] });
    expect(emojiStartingWith("ta", used)[0]?.id).toBe("taco");
  });
});

describe("a message of emoji alone", () => {
  it("is a few emoji, in any tone, flag, keycap or sequence, and nothing else", () => {
    for (const text of ["🎉", "🎉🎉 🚀", "👍🏽", "🇮🇳🇺🇸", "👨‍💻", "1️⃣", "❤️", "🏴󠁧󠁢󠁥󠁮󠁧󠁿"])
      expect(onlyEmoji(text), text).toBe(true);
    for (const text of ["hi 🎉", "123", "#1", "", "  ", "🎉".repeat(40)])
      expect(onlyEmoji(text), text).toBe(false);
  });
});

describe("the emoji files", () => {
  it("are what scripts/generate-emoji.mjs writes, so none was edited by hand", async () => {
    const { OUTPUTS } = (await import(
      pathToFileURL(join(root, "scripts/generate-emoji.mjs")).href
    )) as {
      OUTPUTS: Record<
        string,
        { write: () => string | Buffer; current: (file: string, wanted?: unknown) => boolean }
      >;
    };
    const stale = Object.entries(OUTPUTS)
      .filter(([path, output]) => {
        const file = join(root, path);
        // The font is checked by its tables, without packing it again.
        const wanted = output.current.length > 1 ? output.write() : undefined;
        return !output.current(file, wanted);
      })
      .map(([path]) => path);
    expect(stale).toEqual([]);
  }, 60_000);

  it("load the font only where it can be drawn, and only for emoji", () => {
    const css = readFileSync(join(process.cwd(), "src/emoji.css"), "utf8");
    expect(css).toMatch(/@supports \(font-tech\(color-COLRv1\)\) \{\s*@font-face/);
    expect(css).toContain("font-display: block;");
    expect(css).toContain('src: url("../fonts/noto-color-emoji.woff2")');
    expect(css).toContain("U+1f1e6-1f1ff");
  });
});
