import type { Channel } from "@ownbase/protocol";
import { describe, expect, it } from "vitest";
import { parseClock, parseRemind, parseUntil } from "../src/lib/remind.js";
import { ordinal } from "../src/lib/repeat.js";

const channel = (id: string, type: Channel["type"], name: string) =>
  ({ id, type, name, archived: false }) as unknown as Channel;
const here = {
  channelId: "C_GENERAL",
  channels: {
    C_GENERAL: channel("C_GENERAL", "public", "general"),
    C_TEAM: channel("C_TEAM", "public", "team"),
    D1: channel("D1", "dm", ""),
  },
  timeZone: "Europe/London",
  // Wednesday 25 November 2026, noon in London.
  now: Date.parse("2026-11-25T12:00:00Z"),
};
const parse = (args: string) => parseRemind(args, here);

describe("/remind's accepted forms", () => {
  it("reads a channel, a message, a rule and a time", () => {
    expect(parse("#team Standup notes every weekday at 9am")).toEqual({
      ok: true,
      channelId: "C_TEAM",
      text: "Standup notes",
      rule: { every: "weekday", time: "09:00", until: null },
    });
  });

  it("takes a picked channel mention, quotes round the message, and this conversation when none is named", () => {
    expect(parse('<#C_TEAM> "Standup notes" every day at 17:30')).toMatchObject({
      channelId: "C_TEAM",
      text: "Standup notes",
      rule: { every: "day", time: "17:30" },
    });
    expect(parse("Water the plants every Monday at noon")).toMatchObject({
      channelId: "C_GENERAL",
      text: "Water the plants",
      rule: { every: "week", weekday: 1, time: "12:00" },
    });
  });

  it("keeps an 'every' that belongs to the message", () => {
    expect(parse("#team Check every dashboard every weekday at 9")).toMatchObject({
      text: "Check every dashboard",
      rule: { every: "weekday", time: "09:00" },
    });
  });

  it("reads each rule", () => {
    const rule = (words: string) => {
      const parsed = parse(`#team hi every ${words} at 9`);
      return parsed.ok ? parsed.rule : parsed.said;
    };
    expect(rule("day")).toMatchObject({ every: "day" });
    expect(rule("weekdays")).toMatchObject({ every: "weekday" });
    expect(rule("week on Friday")).toMatchObject({ every: "week", weekday: 5 });
    expect(rule("tue")).toMatchObject({ every: "week", weekday: 2 });
    expect(rule("Sundays")).toMatchObject({ every: "week", weekday: 0 });
    expect(rule("month on the 31st")).toMatchObject({ every: "month", monthDay: 31 });
    expect(rule("month on 1")).toMatchObject({ every: "month", monthDay: 1 });
  });

  it("reads times on either clock", () => {
    expect(parseClock("9")).toBe("09:00");
    expect(parseClock("9:30 pm")).toBe("21:30");
    expect(parseClock("12am")).toBe("00:00");
    expect(parseClock("12 p.m.")).toBe("12:00");
    expect(parseClock("midnight")).toBe("00:00");
    expect(parseClock("23:59")).toBe("23:59");
  });

  it("reads an end date, written in numbers or in words, the next one when the year is left out", () => {
    expect(parse("#team hi every day at 9 until 2026-12-31")).toMatchObject({
      rule: { until: "2026-12-31" },
    });
    expect(parseUntil("31 December", here.timeZone, here.now)).toBe("2026-12-31");
    expect(parseUntil("Dec 31, 2027", here.timeZone, here.now)).toBe("2027-12-31");
    // March has passed this year, so it is next year's.
    expect(parseUntil("1st March", here.timeZone, here.now)).toBe("2027-03-01");
  });
});

describe("/remind's refusals", () => {
  const said = (args: string) => {
    const parsed = parse(args);
    return parsed.ok ? null : parsed.said;
  };

  it("shows how to write it when it is empty or has no rule", () => {
    expect(said("")).toMatch(/^Write it like this: \/remind #channel/);
    expect(said("#team Standup notes at 9")).toMatch(/^Write it like this/);
  });

  it("points reminders for yourself to Remind me", () => {
    expect(said("me to stretch every day at 3pm")).toMatch(/choose Remind me on a message/);
    expect(said("@sam stretch every day at 3pm")).toMatch(/posts to a channel/);
  });

  it("says which part it could not read", () => {
    expect(said("#nowhere hi every day at 9")).toBe(
      "There is no channel called #nowhere that you can see.",
    );
    expect(said("#team hi every fortnight at 9")).toMatch(/^"every fortnight" is not a repeat/);
    expect(said("#team hi every day at 25:00")).toMatch(/^"at 25:00" is not a time/);
    expect(said("#team hi every day at 13pm")).toMatch(/is not a time/);
    expect(said("#team hi every month on the 32nd at 9")).toMatch(/is not a repeat/);
    expect(said("#team hi every day at 9 until 31 February")).toMatch(/is not a date/);
    expect(said('#team "" every day at 9')).toBe("Write the message to post after the channel.");
  });
});

describe("ordinals", () => {
  it("are written as in English", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "31st",
    ]);
  });
});
