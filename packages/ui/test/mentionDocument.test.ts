import type { Channel, User } from "@ownbase/protocol";
import { describe, expect, it } from "vitest";
import {
  projectMentions,
  replaceShown,
  shownEdit,
  shownPosition,
  storedPosition,
} from "../src/lib/mentionDocument.js";

const person = (id: string, displayName: string): User => ({
  id,
  handle: id.toLowerCase(),
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});

const names = {
  users: { U_SAM: person("U_SAM", "Sam Rivera"), U_SAM2: person("U_SAM2", "Sam Rivera") },
  channels: { C_GEN: { id: "C_GEN", name: "general" } as Channel },
};

/** Applies a box's change to stored text, as the composer does. */
function type(stored: string, after: string, caret?: number) {
  const doc = projectMentions(stored, names);
  const edit = shownEdit(doc.shown, after, caret);
  return replaceShown(doc, edit.start, edit.end, edit.inserted).stored;
}

describe("what a message box shows for its stored text", () => {
  it("reads mentions as names and keeps the stored text exactly", () => {
    const stored = "Hi <@U_SAM>, <!here> and <!channel> see <#C_GEN> <!everyone>";
    const doc = projectMentions(stored, names);
    expect(doc.shown).toBe("Hi @Sam Rivera, @here and @channel see #general @channel");
    expect(doc.segments.map((s) => s.stored).join("")).toBe(stored);
  });

  it("keeps the id of a person or channel it cannot name", () => {
    const doc = projectMentions("ask <@U_GONE> in <#C_HIDDEN>", names);
    expect(doc.shown).toBe("ask @unknown in #unknown");
    expect(replaceShown(doc, 0, 0, "").stored).toBe("ask <@U_GONE> in <#C_HIDDEN>");
  });

  it("tells two people with the same name apart by what it stores", () => {
    const doc = projectMentions("<@U_SAM> <@U_SAM2>", names);
    expect(doc.shown).toBe("@Sam Rivera @Sam Rivera");
    expect(type(doc.stored, `${doc.shown}!`)).toBe("<@U_SAM> <@U_SAM2>!");
  });
});

describe("an edit to what the box shows", () => {
  it("keeps a mention typed beside, before or after", () => {
    expect(type("<@U_SAM>", "@Sam Rivera ok")).toBe("<@U_SAM> ok");
    expect(type("<@U_SAM>", "hey @Sam Rivera", 4)).toBe("hey <@U_SAM>");
  });

  it("turns a mention whose label is edited into ordinary text, never another mention", () => {
    expect(type("<@U_SAM> hi", "@Sam Rivra hi", 8)).toBe("@Sam Rivra hi");
    expect(type("<!here> now", "@her now", 4)).toBe("@her now");
  });

  it("never makes a typed or pasted name a mention", () => {
    expect(type("", "@Sam Rivera")).toBe("@Sam Rivera");
    expect(type("", "@here")).toBe("@here");
  });

  it("removes a whole mention selected and deleted", () => {
    const doc = projectMentions("a <@U_SAM> b", names);
    expect(replaceShown(doc, 2, 13, "").stored).toBe("a  b");
  });

  it("finds where a letter went when the same letter is beside it", () => {
    // "aa" -> "aaa" with the caret after the first: the new letter is the first.
    expect(shownEdit("aa", "aaa", 1)).toEqual({ start: 0, end: 0, inserted: "a" });
    expect(shownEdit("aa", "aaa", 3)).toEqual({ start: 2, end: 2, inserted: "a" });
    // Which mention keeps its place depends on it.
    const three = "@Sam Rivera@Sam Rivera@Sam Rivera";
    expect(type("<@U_SAM>@Sam Rivera", three, 11)).toBe("@Sam Rivera<@U_SAM>@Sam Rivera");
    expect(type("<@U_SAM>@Sam Rivera", three, 22)).toBe("<@U_SAM>@Sam Rivera@Sam Rivera");
  });

  it("inserts a completed mention as its token", () => {
    const doc = projectMentions("Hi @sa", names);
    const next = replaceShown(doc, 3, 6, "<@U_SAM> ");
    expect(next).toEqual({ stored: "Hi <@U_SAM> ", caret: 12 });
    expect(projectMentions(next.stored, names).shown).toBe("Hi @Sam Rivera ");
  });
});

describe("positions between what is shown and what is stored", () => {
  const doc = projectMentions("x <@U_SAM> y", names);
  it("map plain text one to one and a mention's edges to its token's", () => {
    expect(storedPosition(doc, 1)).toBe(1);
    expect(storedPosition(doc, 2)).toBe(2);
    expect(storedPosition(doc, 13)).toBe(10);
    expect(storedPosition(doc, 15)).toBe(12);
    expect(shownPosition(doc, 10)).toBe(13);
    expect(shownPosition(doc, 12)).toBe(15);
  });

  it("widen a selection inside a mention to all of it", () => {
    expect(storedPosition(doc, 5, "start")).toBe(2);
    expect(storedPosition(doc, 5, "end")).toBe(10);
    expect(shownPosition(doc, 4, "start")).toBe(2);
    expect(shownPosition(doc, 4, "end")).toBe(13);
  });
});
