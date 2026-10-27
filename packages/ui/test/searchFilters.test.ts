import { describe, expect, it } from "vitest";
import { FILE_TYPES, parseSearchQuery, type User } from "@ownbase/protocol";
import {
  DATE_PRESETS,
  FILE_TYPE_LABELS,
  dayLabel,
  filterLabel,
  filterToken,
  kindOf,
  localDay,
  takeFilters,
  withFilter,
} from "../src/lib/searchFilters.js";

/**
 * Search's filters as chips (UX-51): a typed modifier becomes the one way of
 * writing it, joins the filters without repeats, leaves the field once it is
 * finished, and is named on its chip in words.
 */
const priya: User = {
  id: "U_PRIYA",
  handle: "Priya",
  displayName: "Priya Shah",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};
const users = { [priya.id]: priya };
/** A day in the reader's own date style, as the chips say it. */
const day = (year: number, month: number, date: number) =>
  new Intl.DateTimeFormat(undefined, { timeZone: "UTC" }).format(Date.UTC(year, month - 1, date));

describe("a typed word as a filter", () => {
  it("writes each modifier one way", () => {
    expect(filterToken("from:@Priya")).toBe("from:priya");
    expect(filterToken("FROM:priya")).toBe("from:priya");
    expect(filterToken("in:#Design")).toBe("in:design");
    expect(filterToken("has:LINK")).toBe("has:link");
    expect(filterToken("has:file")).toBe("has:file");
    expect(filterToken("type:PDF")).toBe("type:pdf");
    expect(filterToken("after:2026-01-01")).toBe("after:2026-01-01");
    expect(filterToken("before:2026-02-28")).toBe("before:2026-02-28");
  });

  it("is no filter for plain words, empty modifiers and ones that cannot be read", () => {
    for (const word of [
      "launch",
      "from:",
      "from:@",
      "fromage:brie",
      "has:pizza",
      "type:gif",
      "after:2026-02-31",
      "before:2026-0",
      "before:tomorrow",
    ])
      expect(filterToken(word), word).toBeNull();
  });

  it("names its kind", () => {
    expect(kindOf("from:priya")).toBe("from");
    expect(kindOf("after:2026-01-01")).toBe("after");
    expect(kindOf("type:pdf")).toBe("type");
  });
});

describe("adding a filter", () => {
  it("adds people, places and kinds up, each once", () => {
    let filters: string[] = [];
    for (const token of [
      "from:sam",
      "from:priya",
      "in:design",
      "has:file",
      "type:pdf",
      "type:image",
    ])
      filters = withFilter(filters, token);
    expect(filters).toEqual([
      "from:sam",
      "from:priya",
      "in:design",
      "has:file",
      "type:pdf",
      "type:image",
    ]);
    expect(withFilter(filters, "from:sam")).toEqual(filters);
    expect(withFilter(filters, "type:pdf")).toEqual(filters);
  });

  it("replaces a day with another of its kind, and keeps the other side", () => {
    const filters = ["after:2026-01-01", "from:sam", "before:2026-03-01"];
    expect(withFilter(filters, "after:2026-02-01")).toEqual([
      "from:sam",
      "before:2026-03-01",
      "after:2026-02-01",
    ]);
    expect(withFilter(filters, "before:2026-04-01")).toEqual([
      "after:2026-01-01",
      "from:sam",
      "before:2026-04-01",
    ]);
    expect(withFilter(["before:2026-03-01"], "after:2026-02-01")).toEqual([
      "before:2026-03-01",
      "after:2026-02-01",
    ]);
  });

  it("leaves the filters it was given as they were", () => {
    const filters = ["from:sam", "after:2026-01-01"];
    const added = withFilter(filters, "after:2026-02-01");
    const again = withFilter(filters, "from:sam");
    expect(filters).toEqual(["from:sam", "after:2026-01-01"]);
    expect(added).not.toBe(filters);
    expect(again).not.toBe(filters);
  });
});

describe("taking filters out of what is typed", () => {
  it("leaves text with no modifiers alone", () => {
    expect(takeFilters("launch notes", 6)).toEqual({ text: "launch notes", caret: 6, tokens: [] });
  });

  it("takes a modifier once a space follows it and the caret has left it", () => {
    expect(takeFilters("from:@priya ", 12)).toEqual({ text: "", caret: 0, tokens: ["from:priya"] });
    expect(takeFilters("launch from:@priya ", 19)).toEqual({
      text: "launch ",
      caret: 7,
      tokens: ["from:priya"],
    });
    expect(takeFilters("from:@priya launch", 18)).toEqual({
      text: "launch",
      caret: 6,
      tokens: ["from:priya"],
    });
  });

  it("leaves a modifier still being written: at the end, or with the caret on it", () => {
    // Nothing after it yet.
    expect(takeFilters("launch from:@pri", 16).tokens).toEqual([]);
    // The caret anywhere from its first letter to just after its last.
    for (const caret of [0, 5, 11])
      expect(takeFilters("from:@priya launch", caret), `caret ${caret}`).toEqual({
        text: "from:@priya launch",
        caret,
        tokens: [],
      });
  });

  it("leaves a modifier that cannot be read where the hints can point at it", () => {
    expect(takeFilters("after:2026-02-31 launch", 23)).toEqual({
      text: "after:2026-02-31 launch",
      caret: 23,
      tokens: [],
    });
    expect(takeFilters("has:pizza launch", 16).tokens).toEqual([]);
  });

  it("takes several at once, in the order they were typed", () => {
    expect(takeFilters("from:@sam in:#design launch has:file ", 37)).toEqual({
      text: "launch ",
      caret: 7,
      tokens: ["from:sam", "in:design", "has:file"],
    });
  });

  it("keeps the caret where it was in the words around what it takes", () => {
    // Before the modifier: it stays put.
    expect(takeFilters("launch from:@priya big", 3)).toEqual({
      text: "launch big",
      caret: 3,
      tokens: ["from:priya"],
    });
    // After it: it moves back by what went.
    expect(takeFilters("launch from:@priya big", 21)).toEqual({
      text: "launch big",
      caret: 9,
      tokens: ["from:priya"],
    });
    // In the spaces that went with it: where the modifier began.
    expect(takeFilters("from:@priya   launch", 13)).toEqual({
      text: "launch",
      caret: 0,
      tokens: ["from:priya"],
    });
    expect(takeFilters("big from:@priya   launch", 17)).toEqual({
      text: "big launch",
      caret: 4,
      tokens: ["from:priya"],
    });
  });

  it("takes every modifier with `all`, as Enter does, finished or not", () => {
    expect(takeFilters("launch from:@priya", 18, true)).toEqual({
      text: "launch ",
      caret: 7,
      tokens: ["from:priya"],
    });
    expect(takeFilters("from:@pri", 4, true)).toEqual({ text: "", caret: 0, tokens: ["from:pri"] });
    // Still not one that cannot be read.
    expect(takeFilters("launch before:2026-0", 20, true)).toEqual({
      text: "launch before:2026-0",
      caret: 20,
      tokens: [],
    });
  });
});

describe("a calendar day from today", () => {
  it("counts days where the reader is, across months and years", () => {
    expect(localDay(0, new Date(2026, 9, 16, 23, 59))).toBe("2026-10-16");
    expect(localDay(0, new Date(2026, 9, 16, 0, 1))).toBe("2026-10-16");
    expect(localDay(-1, new Date(2026, 0, 1, 0, 5))).toBe("2025-12-31");
    expect(localDay(-7, new Date(2026, 2, 3, 12))).toBe("2026-02-24");
    expect(localDay(-1, new Date(2028, 2, 1, 9))).toBe("2028-02-29");
    expect(localDay(-30, new Date(2026, 9, 16, 12))).toBe("2026-09-16");
    expect(localDay(1, new Date(2026, 11, 31, 18))).toBe("2027-01-01");
  });

  it("gives each Date choice the day whose next one starts the span, today among it", () => {
    const now = new Date(2026, 9, 16, 15, 30);
    const startOf = (offset: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).getTime();
    const after = (offset: number) => parseSearchQuery(`after:${localDay(offset, now)}`).after;
    expect(DATE_PRESETS.map((preset) => preset.label)).toEqual([
      "Today",
      "Last 7 days",
      "Last 30 days",
    ]);
    const [today, week, month] = DATE_PRESETS;
    expect(after(today.offset)).toBe(startOf(0));
    expect(after(week.offset)).toBe(startOf(-6));
    expect(after(month.offset)).toBe(startOf(-29));
  });
});

describe("what a chip says", () => {
  it("names a person by display name, matching the handle in any case", () => {
    expect(filterLabel("from:priya", users)).toBe("From Priya Shah");
    expect(filterLabel("from:ghost", users)).toBe("From @ghost");
    expect(filterLabel("from:priya", {})).toBe("From @priya");
  });

  it("names places and kinds", () => {
    expect(filterLabel("in:design", users)).toBe("In #design");
    expect(filterLabel("has:link", users)).toBe("Has a link");
    expect(filterLabel("has:file", users)).toBe("Has a file");
    expect(filterLabel("type:pdf", users)).toBe("PDFs");
    expect(filterLabel("type:image", users)).toBe("Images");
    expect(filterLabel("type:spreadsheet", users)).toBe("Spreadsheets");
  });

  it("has a name for every kind of file there is", () => {
    expect(Object.keys(FILE_TYPE_LABELS).sort()).toEqual([...FILE_TYPES].sort());
    for (const type of FILE_TYPES)
      expect(filterLabel(`type:${type}`, users)).toBe(FILE_TYPE_LABELS[type]);
  });

  it("names a Date choice by its own name, and any other day in the reader's style", () => {
    const now = new Date(2026, 9, 16, 12);
    expect(filterLabel("after:2026-10-15", users, now)).toBe("Today");
    expect(filterLabel("after:2026-10-09", users, now)).toBe("Last 7 days");
    expect(filterLabel("after:2026-09-16", users, now)).toBe("Last 30 days");
    expect(filterLabel("after:2026-03-08", users, now)).toBe(`After ${day(2026, 3, 8)}`);
    // A bound before a day is never one of the choices, which are all since a day.
    expect(filterLabel("before:2026-10-15", users, now)).toBe(`Before ${day(2026, 10, 15)}`);
  });

  it("says a day as written, wherever the reader is", () => {
    expect(dayLabel("2026-03-08")).toBe(day(2026, 3, 8));
    expect(dayLabel("2026-01-01")).toBe(day(2026, 1, 1));
    expect(dayLabel("2026-12-31")).toBe(day(2026, 12, 31));
  });
});
