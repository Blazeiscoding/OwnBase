import { describe, expect, it } from "vitest";
import type { RepeatRule } from "../src/entities.js";
import { firstRepeat, instantOfWallClock, nextRepeat, repeatAnchors } from "../src/repeat.js";

const at = (iso: string) => Date.parse(iso);
const iso = (instant: number | null) => (instant === null ? null : new Date(instant).toISOString());
const rule = (r: Partial<RepeatRule> & Pick<RepeatRule, "every">): RepeatRule => ({
  time: "09:00",
  timeZone: "Europe/London",
  until: null,
  ...r,
});
/** The next `count` sends after `from`. */
function sends(r: RepeatRule, from: number, count: number): (string | null)[] {
  const out: (string | null)[] = [];
  let last: number | null = from;
  for (let i = 0; i < count && last !== null; i++) {
    last = nextRepeat(r, last);
    out.push(iso(last));
  }
  return out;
}

describe("every weekday at 9:00", () => {
  it("goes Monday to Friday at 9:00 in London, across the clocks going forward on the last Sunday of March", () => {
    // Friday 27 March 2026, 9:00 GMT. The clocks go forward on Sunday the 29th.
    expect(sends(rule({ every: "weekday" }), at("2026-03-27T09:00:00Z"), 6)).toEqual([
      "2026-03-30T08:00:00.000Z", // Monday, 9:00 BST
      "2026-03-31T08:00:00.000Z",
      "2026-04-01T08:00:00.000Z",
      "2026-04-02T08:00:00.000Z",
      "2026-04-03T08:00:00.000Z", // Friday
      "2026-04-06T08:00:00.000Z", // and Monday again
    ]);
  });

  it("stays at 9:00 in London when the clocks go back on the last Sunday of October", () => {
    // Friday 23 October 2026, 9:00 BST. The clocks go back on Sunday the 25th.
    expect(sends(rule({ every: "weekday" }), at("2026-10-23T08:00:00Z"), 2)).toEqual([
      "2026-10-26T09:00:00.000Z", // Monday, 9:00 GMT
      "2026-10-27T09:00:00.000Z",
    ]);
  });

  it("goes at 9:00 in Asia/Kolkata, which has no daylight saving", () => {
    expect(
      sends(rule({ every: "weekday", timeZone: "Asia/Kolkata" }), at("2026-03-27T03:30:00Z"), 3),
    ).toEqual(["2026-03-30T03:30:00.000Z", "2026-03-31T03:30:00.000Z", "2026-04-01T03:30:00.000Z"]);
  });

  it("starts on the Monday when the first time chosen is a Saturday", () => {
    expect(iso(firstRepeat(rule({ every: "weekday" }), at("2026-03-28T09:00:00Z")))).toBe(
      "2026-03-30T08:00:00.000Z",
    );
    // A weekday's own time is the first send itself.
    expect(iso(firstRepeat(rule({ every: "weekday" }), at("2026-03-27T09:00:00Z")))).toBe(
      "2026-03-27T09:00:00.000Z",
    );
  });
});

describe("every day", () => {
  it("is 23 hours apart over the night the clocks go forward, and 25 over the night they go back", () => {
    expect(sends(rule({ every: "day" }), at("2026-03-28T09:00:00Z"), 2)).toEqual([
      "2026-03-29T08:00:00.000Z",
      "2026-03-30T08:00:00.000Z",
    ]);
    expect(sends(rule({ every: "day" }), at("2026-10-24T08:00:00Z"), 2)).toEqual([
      "2026-10-25T09:00:00.000Z",
      "2026-10-26T09:00:00.000Z",
    ]);
  });

  it("goes at the hour after when its time is skipped, and the first time when it is shown twice", () => {
    // 01:30 does not happen in London on 29 March 2026: the clocks go from 01:00 to 02:00.
    expect(iso(nextRepeat(rule({ every: "day", time: "01:30" }), at("2026-03-28T12:00:00Z")))).toBe(
      "2026-03-29T01:30:00.000Z", // 02:30 BST
    );
    // 01:30 happens twice on 25 October 2026; the first is in BST.
    expect(iso(nextRepeat(rule({ every: "day", time: "01:30" }), at("2026-10-24T12:00:00Z")))).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    // And it goes once that day, not again an hour later.
    expect(iso(nextRepeat(rule({ every: "day", time: "01:30" }), at("2026-10-25T00:30:00Z")))).toBe(
      "2026-10-26T01:30:00.000Z",
    );
  });

  it("counts days on the rule's own calendar, not UTC's", () => {
    // 00:20 on 2 March in India is still 1 March in UTC.
    const kolkata = rule({ every: "day", time: "00:15", timeZone: "Asia/Kolkata" });
    expect(iso(nextRepeat(kolkata, at("2026-03-01T18:50:00Z")))).toBe("2026-03-02T18:45:00.000Z");
  });

  it("stops after its end date, which it still goes on", () => {
    const short = rule({ every: "day", until: "2026-03-03" });
    expect(sends(short, at("2026-03-01T09:00:00Z"), 3)).toEqual([
      "2026-03-02T09:00:00.000Z",
      "2026-03-03T09:00:00.000Z",
      null,
    ]);
  });
});

describe("every week and every month", () => {
  it("goes every week on its day", () => {
    expect(sends(rule({ every: "week", weekday: 1 }), at("2026-03-25T12:00:00Z"), 2)).toEqual([
      "2026-03-30T08:00:00.000Z",
      "2026-04-06T08:00:00.000Z",
    ]);
  });

  it("goes on the last day of a month shorter than its date, and back on the 31st after", () => {
    const monthly = rule({ every: "month", monthDay: 31, timeZone: "Asia/Kolkata" });
    expect(sends(monthly, at("2026-01-31T03:30:00Z"), 4)).toEqual([
      "2026-02-28T03:30:00.000Z", // February
      "2026-03-31T03:30:00.000Z",
      "2026-04-30T03:30:00.000Z", // April has 30
      "2026-05-31T03:30:00.000Z",
    ]);
    // In a leap year February has a 29th.
    expect(iso(nextRepeat(monthly, at("2028-01-31T03:30:00Z")))).toBe("2028-02-29T03:30:00.000Z");
  });

  it("goes on the 30th in February's last day too, and only once that month", () => {
    const monthly = rule({ every: "month", monthDay: 30 });
    expect(sends(monthly, at("2026-02-01T00:00:00Z"), 2)).toEqual([
      "2026-02-28T09:00:00.000Z",
      "2026-03-30T08:00:00.000Z",
    ]);
  });
});

describe("the wall clock", () => {
  it("reads a chosen first send as the rule's time, weekday and date", () => {
    // Monday 30 March 2026, 9:00 in London.
    expect(repeatAnchors(at("2026-03-30T08:00:00Z"), "Europe/London")).toEqual({
      time: "09:00",
      weekday: 1,
      monthDay: 30,
    });
  });

  it("turns a wall-clock time back into the instant it shows", () => {
    expect(iso(instantOfWallClock([2026, 7, 1, 9, 0], "Europe/London"))).toBe(
      "2026-07-01T08:00:00.000Z",
    );
    expect(iso(instantOfWallClock([2026, 7, 1, 9, 0], "Asia/Calcutta"))).toBe(
      "2026-07-01T03:30:00.000Z",
    );
  });
});
