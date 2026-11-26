import { describe, expect, it } from "vitest";
import { notifyDecision, reminderNotifyDecision, type NotifyInputs } from "../src/notify.js";
import { type NotifyHours, type NotifySchedule } from "../src/notifySchedule.js";
import { scheduleQuietUntil } from "../src/scheduleResume.js";

const at = (iso: string) => Date.parse(iso);
const hours = (from: string, to: string): NotifyHours => ({ from, to });
const WORK = hours("09:00", "18:00");

const weekdays: NotifySchedule = {
  kind: "weekdays",
  days: [null, WORK, WORK, WORK, WORK, WORK, null],
};
const everyDay = (from: string, to: string): NotifySchedule => ({
  kind: "every-day",
  days: Array.from({ length: 7 }, () => hours(from, to)),
});

describe("scheduleQuietUntil", () => {
  it("never holds anything back without a schedule", () => {
    expect(scheduleQuietUntil(null, "Asia/Kolkata", at("2026-11-23T14:30:00Z"))).toBeNull();
    expect(scheduleQuietUntil(undefined, "Asia/Kolkata", at("2026-11-23T14:30:00Z"))).toBeNull();
  });

  it("reads weekdays 9 to 18 on the account's own clock", () => {
    // Monday 10:00 and 17:59 in Kolkata (UTC+5:30): inside.
    expect(scheduleQuietUntil(weekdays, "Asia/Kolkata", at("2026-11-23T04:30:00Z"))).toBeNull();
    expect(scheduleQuietUntil(weekdays, "Asia/Kolkata", at("2026-11-23T12:29:00Z"))).toBeNull();
    // Monday 20:00: quiet until Tuesday 09:00.
    expect(scheduleQuietUntil(weekdays, "Asia/Kolkata", at("2026-11-23T14:30:00Z"))).toBe(
      at("2026-11-24T03:30:00Z"),
    );
    // 18:00 itself is outside; 08:59 too, until 09:00 the same day.
    expect(scheduleQuietUntil(weekdays, "Asia/Kolkata", at("2026-11-23T12:30:00Z"))).toBe(
      at("2026-11-24T03:30:00Z"),
    );
    expect(scheduleQuietUntil(weekdays, "Asia/Kolkata", at("2026-11-23T03:29:00Z"))).toBe(
      at("2026-11-23T03:30:00Z"),
    );
  });

  it("is quiet over a weekend until Monday morning", () => {
    // Friday 20:00 in Kolkata.
    expect(scheduleQuietUntil(weekdays, "Asia/Kolkata", at("2026-11-27T14:30:00Z"))).toBe(
      at("2026-11-30T03:30:00Z"),
    );
  });

  it("gives the same instant a different answer in another zone", () => {
    // 14:30 UTC is 20:00 in Kolkata but 09:30 in New York.
    expect(scheduleQuietUntil(weekdays, "America/New_York", at("2026-11-23T14:30:00Z"))).toBeNull();
  });

  it("runs hours that end before they start past midnight", () => {
    const nights = everyDay("22:00", "07:00");
    // 23:30 and, the next morning, 03:00 are inside; 08:00 waits for 22:00.
    expect(scheduleQuietUntil(nights, "UTC", at("2026-11-23T23:30:00Z"))).toBeNull();
    expect(scheduleQuietUntil(nights, "UTC", at("2026-11-24T03:00:00Z"))).toBeNull();
    expect(scheduleQuietUntil(nights, "UTC", at("2026-11-24T08:00:00Z"))).toBe(
      at("2026-11-24T22:00:00Z"),
    );
    // A night belongs to the day it starts on: Monday night only.
    const mondayNight: NotifySchedule = {
      kind: "custom",
      days: [null, hours("22:00", "07:00"), null, null, null, null, null],
    };
    expect(scheduleQuietUntil(mondayNight, "UTC", at("2026-11-24T06:59:00Z"))).toBeNull();
    expect(scheduleQuietUntil(mondayNight, "UTC", at("2026-11-23T03:00:00Z"))).toBe(
      at("2026-11-23T22:00:00Z"),
    );
  });

  it("takes 00:00 to 00:00 as the whole day", () => {
    const sundays: NotifySchedule = {
      kind: "custom",
      days: [hours("00:00", "00:00"), null, null, null, null, null, null],
    };
    expect(scheduleQuietUntil(sundays, "UTC", at("2026-11-29T00:00:00Z"))).toBeNull();
    expect(scheduleQuietUntil(sundays, "UTC", at("2026-11-29T23:59:00Z"))).toBeNull();
    expect(scheduleQuietUntil(sundays, "UTC", at("2026-11-30T00:00:00Z"))).toBe(
      at("2026-12-06T00:00:00Z"),
    );
  });

  it("keeps 9:00 at 9:00 when the clocks go forward in London", () => {
    const days = everyDay("09:00", "18:00");
    // Saturday 28 March 2026, 20:00 GMT. Sunday 09:00 is BST, 08:00 UTC.
    expect(scheduleQuietUntil(days, "Europe/London", at("2026-03-28T20:00:00Z"))).toBe(
      at("2026-03-29T08:00:00Z"),
    );
    // 08:30 UTC that Sunday is 09:30 on the clock: inside.
    expect(scheduleQuietUntil(days, "Europe/London", at("2026-03-29T08:30:00Z"))).toBeNull();
    // 17:30 UTC is 18:30 on the clock: outside.
    expect(scheduleQuietUntil(days, "Europe/London", at("2026-03-29T17:30:00Z"))).toBe(
      at("2026-03-30T08:00:00Z"),
    );
  });

  it("opens an hour the clocks skip at the time after it", () => {
    const early = everyDay("01:30", "05:00");
    // 01:30 on 29 March 2026 never shows in London: it opens at 02:30 BST.
    expect(scheduleQuietUntil(early, "Europe/London", at("2026-03-29T00:30:00Z"))).toBe(
      at("2026-03-29T01:30:00Z"),
    );
  });

  it("stays out of the way while turned on for a while", () => {
    const now = at("2026-11-23T14:30:00Z");
    const on = { ...weekdays, onUntil: now + 3_600_000 };
    expect(scheduleQuietUntil(on, "Asia/Kolkata", now)).toBeNull();
    expect(scheduleQuietUntil(on, "Asia/Kolkata", now + 3_600_000)).not.toBeNull();
  });

  it("reads the schedule on this runtime's clock when the account has no zone", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const instant of [at("2026-11-23T04:30:00Z"), at("2026-11-23T14:30:00Z")])
      expect(scheduleQuietUntil(weekdays, undefined, instant)).toBe(
        scheduleQuietUntil(weekdays, zone, instant),
      );
  });
});

describe("notifyDecision with a schedule", () => {
  const evening = at("2026-11-23T14:30:00Z"); // Monday 20:00 in Kolkata
  const inputs = (over: Partial<NotifyInputs> = {}): NotifyInputs => ({
    selfId: "me",
    groupIds: [],
    message: { userId: "them", text: "<@me> are you there", threadRootId: null, replyTo: null },
    senderBlocked: false,
    channelType: "public",
    prefs: { muted: false, notifyLevel: "all", notifyChosen: true },
    notifyDefault: "mentions",
    threadMuted: false,
    dndUntil: null,
    now: evening,
    live: true,
    schedule: weekdays,
    timeZone: "Asia/Kolkata",
    ...over,
  });

  it("holds a mention back outside the hours, and lets it through inside", () => {
    expect(notifyDecision(inputs())).toEqual({ notify: false, reason: "schedule" });
    expect(
      notifyDecision(inputs({ channelType: "dm", message: { ...inputs().message } })).reason,
    ).toBe("schedule");
    expect(notifyDecision(inputs({ now: at("2026-11-23T04:30:00Z") }))).toEqual({
      notify: true,
      reason: "mention",
    });
    expect(notifyDecision(inputs({ schedule: null }))).toEqual({ notify: true, reason: "mention" });
  });

  it("says a pause, not the schedule, while both hold", () => {
    expect(notifyDecision(inputs({ dndUntil: evening + 60_000 })).reason).toBe("dnd");
  });

  it("holds a reminder back outside the hours", () => {
    expect(reminderNotifyDecision(null, evening, weekdays, "Asia/Kolkata")).toEqual({
      notify: false,
      reason: "schedule",
    });
    expect(reminderNotifyDecision(null, evening)).toEqual({ notify: true, reason: "reminder" });
  });
});
