/**
 * When an account allows notifications (K12), as Slack's "Allow
 * notifications" does: every day, on weekdays, or hours of its own for each
 * day. Outside them notifications pause by themselves, as a pause does. The
 * hours are on the account's own clock, so 9:00 stays 9:00 across a
 * daylight-saving change.
 */

/** Kept as a plain type so the app's first screen does not carry the list; rest.ts checks it. */
export type NotifyScheduleKind = "every-day" | "weekdays" | "custom";

/**
 * One day's hours, "HH:MM" on a 24-hour clock. A `to` at or before `from`
 * runs past midnight into the next day, so 22:00 to 07:00 is one night and
 * 00:00 to 00:00 is the whole day.
 */
export interface NotifyHours {
  from: string;
  to: string;
}

export interface NotifySchedule {
  /** What was chosen, so the editor shows it again; `days` alone decides. */
  kind: NotifyScheduleKind;
  /** Seven days, Sunday first; null for a day with no notifications at all. */
  days: (NotifyHours | null)[];
  /** "Turn on for 1 hour": notifications stay on until this epoch ms whatever the hours say. */
  onUntil?: number | null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const minutesOf = (time: string) => {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return hour * 60 + minute;
};

/** This runtime's own zone: the device's in the app, the host's on the server. */
export const runtimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Clocks by zone. Only zones the runtime knows reach here, the server's
 * having checked an account's, so there are at most a few hundred.
 */
const clocks = new Map<string, Intl.DateTimeFormat>();

/** The weekday, 0 for Sunday, and the minutes since midnight, on a wall clock in `zone`. */
function clockAt(instant: number, zone: string): [weekday: number, minutes: number] {
  let clock = clocks.get(zone);
  if (!clock) {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
    });
    clocks.set(zone, clock);
  }
  let weekday = 0;
  let minutes = 0;
  for (const part of clock.formatToParts(instant)) {
    if (part.type === "weekday") weekday = WEEKDAYS.indexOf(part.value);
    else if (part.type === "hour") minutes += Number(part.value) * 60;
    else if (part.type === "minute") minutes += Number(part.value);
  }
  return [weekday, minutes];
}

/**
 * Whether the schedule lets notifications through at `now`: always with no
 * schedule, or one turned on for a while. `timeZone` is the account's;
 * without one, this runtime's own.
 */
export function scheduleAllows(
  schedule: NotifySchedule | null | undefined,
  timeZone: string | null | undefined,
  now: number,
): boolean {
  // One with no hours on any day the server refuses; it would never open.
  if (!schedule?.days.some(Boolean) || (schedule.onUntil ?? 0) > now) return true;
  const [weekday, at] = clockAt(now, timeZone || runtimeZone());
  const today = schedule.days[weekday];
  if (today) {
    const from = minutesOf(today.from);
    const to = minutesOf(today.to);
    if (from < to ? at >= from && at < to : at >= from) return true;
  }
  // Last night's hours, run past midnight.
  const yesterday = schedule.days[(weekday + 6) % 7];
  return !!yesterday && minutesOf(yesterday.to) <= minutesOf(yesterday.from)
    ? at < minutesOf(yesterday.to)
    : false;
}
