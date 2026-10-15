import { describe, expect, it } from "vitest";
import { formatWhen } from "../src/lib/format.js";

/**
 * One rule for when something happened, in every list (UX-05): the time
 * today, "Yesterday" and the time, the weekday within the week, then the date,
 * with the year only when it is another one. The expectations are built from
 * the same locale's formatters, so they hold wherever the tests run.
 */
const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dateWithYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

// Thursday 15 October 2026, 10:30 in the reader's own zone.
const now = new Date(2026, 9, 15, 10, 30).getTime();
const at = (day: number, hour: number, minute = 0, month = 9, year = 2026) =>
  new Date(year, month, day, hour, minute).getTime();

describe("formatWhen", () => {
  it("says only the time for earlier today, from midnight on", () => {
    expect(formatWhen(at(15, 9, 5), now)).toBe(time.format(at(15, 9, 5)));
    expect(formatWhen(at(15, 0, 0), now)).toBe(time.format(at(15, 0, 0)));
  });

  it("says Yesterday with the time, up to the last minute before midnight", () => {
    expect(formatWhen(at(14, 23, 59), now)).toBe(`Yesterday ${time.format(at(14, 23, 59))}`);
    expect(formatWhen(at(14, 0, 0), now)).toBe(`Yesterday ${time.format(at(14, 0, 0))}`);
  });

  it("says the weekday with the time within the week", () => {
    const monday = at(12, 16, 45);
    expect(formatWhen(monday, now)).toBe(`${weekday.format(monday)} ${time.format(monday)}`);
    // Six days back is still this week's weekday; a seventh would repeat today's name.
    const friday = at(9, 8, 0);
    expect(formatWhen(friday, now)).toBe(`${weekday.format(friday)} ${time.format(friday)}`);
  });

  it("says the date for older days this year, and the year before this one", () => {
    const lastThursday = at(8, 23, 0);
    expect(formatWhen(lastThursday, now)).toBe(date.format(lastThursday));
    const lastYear = at(3, 12, 0, 9, 2025);
    expect(formatWhen(lastYear, now)).toBe(dateWithYear.format(lastYear));
  });

  it("says the time from midnight on, and the weekday from six calendar days back", () => {
    expect(formatWhen(at(15, 0, 0) - 60_000, now)).toMatch(/^Yesterday /);
    expect(formatWhen(at(9, 0, 0), now)).toBe(
      `${weekday.format(at(9, 0, 0))} ${time.format(at(9, 0, 0))}`,
    );
    expect(formatWhen(at(9, 0, 0) - 60_000, now)).toBe(date.format(at(9, 0, 0) - 60_000));
  });

  it("counts days on the calendar across a clock change, not in 24-hour steps", () => {
    // Each test file has a process of its own, and this one puts the zone back.
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // US clocks went back an hour on Sunday 1 November 2026: that day was 25 hours long.
      const mondayMorning = new Date(2026, 10, 2, 0, 30).getTime();
      const sundayMorning = new Date(2026, 10, 1, 0, 30).getTime();
      expect(formatWhen(sundayMorning, mondayMorning)).toMatch(/^Yesterday /);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});
