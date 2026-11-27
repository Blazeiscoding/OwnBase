import { describe, expect, it } from "vitest";
import { keywordIn, keywordKey, keywordMatches, wordSpans } from "../src/keywords.js";

describe("keyword matching (K11)", () => {
  it("ignores case", () => {
    expect(keywordIn("The RELEASE is out", ["release"])).toBe("release");
    expect(keywordIn("the release is out", ["Release"])).toBe("Release");
  });

  it("ignores the accents on Latin letters, written either way", () => {
    expect(keywordIn("Réunion à 3h", ["reunion"])).toBe("reunion");
    expect(keywordIn("Reunion at 3", ["réunion"])).toBe("réunion");
    // An e followed by a combining acute accent.
    expect(keywordIn("Réunion", ["reunion"])).toBe("reunion");
  });

  it("keeps the marks that make other scripts' letters", () => {
    // A Devanagari vowel sign is part of the word, not an accent.
    expect(keywordIn("किताब पढ़ो", ["किताब"])).toBe("किताब");
    expect(keywordIn("किताब पढ़ो", ["कताब"])).toBeNull();
  });

  it("finds whole words only", () => {
    expect(keywordIn("released yesterday", ["release"])).toBeNull();
    expect(keywordIn("prerelease build", ["release"])).toBeNull();
    expect(keywordIn("ship the release!", ["release"])).toBe("release");
    expect(keywordIn("(release)", ["release"])).toBe("release");
    // Punctuation inside ends a word, as the search index reads it.
    expect(keywordIn("release_notes", ["release"])).toBe("release");
  });

  it("finds a phrase as its words side by side, whatever lies between them", () => {
    expect(keywordIn("read the release notes", ["release notes"])).toBe("release notes");
    expect(keywordIn("release, notes", ["release notes"])).toBe("release notes");
    expect(keywordIn("notes on the release", ["release notes"])).toBeNull();
    expect(keywordIn("release the notes", ["release notes"])).toBeNull();
  });

  it("matches writing without spaces character by character, as search does", () => {
    expect(keywordIn("新製品の発表会は金曜日", ["発表"])).toBe("発表");
    expect(keywordIn("新製品の発表会は金曜日", ["発会"])).toBeNull();
    expect(keywordIn("오늘 회의실에서", ["회의"])).toBe("회의");
    expect(keywordIn("ประชุมวันนี้", ["ประชุม"])).toBe("ประชุม");
  });

  it("finds a keyword in a link or a group's name, as the search index holds them", () => {
    expect(keywordIn("see <https://example.com/release|the notes>", ["release"])).toBe("release");
    expect(keywordIn("ask <!subteam^G1|@design>", ["design"])).toBe("design");
  });

  it("finds nothing with no keywords, or none with words in them", () => {
    expect(keywordIn("release", [])).toBeNull();
    expect(keywordIn("!!! release", ["!!!"])).toBeNull();
  });

  it("says where each keyword stands, the longer first where two start together", () => {
    const text = "Release notes, then the release.";
    expect(keywordMatches(text, ["release", "release notes"])).toEqual([
      { keyword: "release notes", start: 0, end: 13 },
      { keyword: "release", start: 24, end: 31 },
    ]);
  });

  it("gives positions in the text as written, past characters outside the basic plane", () => {
    const text = "😀 Réunion";
    const [span] = wordSpans(text);
    expect(span).toEqual({ word: "reunion", start: 3, end: 10 });
  });

  it("knows two keywords that differ only in case, accents or spacing as one", () => {
    expect(keywordKey("  Réunion   Notes ")).toBe(keywordKey("reunion notes"));
    expect(keywordKey("?!")).toBe("");
  });
});
