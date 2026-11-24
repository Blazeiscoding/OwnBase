import type { RepeatRule } from "./entities.js";

/**
 * When a repeating scheduled message goes next (K14). The server queues the
 * next send with it after each one; the app uses it to say when the first
 * goes. Both work from the rule's own zone, never the machine's.
 */

const DAY = 86_400_000;

/** A calendar day and a time of day on a wall clock: year, month 1–12, day, hour, minute. */
type Wall = [year: number, month: number, day: number, hour: number, minute: number];

/** How many zones keep a formatter, the least recently used going first. */
const FORMATTERS_KEPT = 32;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (found) formatters.delete(timeZone);
  else
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
  formatters.set(timeZone, found);
  if (formatters.size > FORMATTERS_KEPT) formatters.delete(formatters.keys().next().value!);
  return found;
}

/** What a wall clock in `timeZone` shows at `instant`. */
export function wallClockAt(instant: number, timeZone: string): Wall {
  const wall: Wall = [0, 0, 0, 0, 0];
  for (const part of formatter(timeZone).formatToParts(instant)) {
    if (part.type === "year") wall[0] = Number(part.value);
    else if (part.type === "month") wall[1] = Number(part.value);
    else if (part.type === "day") wall[2] = Number(part.value);
    else if (part.type === "hour") wall[3] = Number(part.value);
    else if (part.type === "minute") wall[4] = Number(part.value);
  }
  return wall;
}

const asUtc = ([year, month, day, hour, minute]: Wall) =>
  Date.UTC(year, month - 1, day, hour, minute);

/** How far ahead of UTC `timeZone` is at `instant`, to the minute. */
const offsetAt = (instant: number, timeZone: string) =>
  asUtc(wallClockAt(instant, timeZone)) - Math.floor(instant / 60_000) * 60_000;

/**
 * The instant a wall clock in `timeZone` shows `wall`. A time the clocks skip
 * when they go forward is read on the clock from before, so 01:30 on that
 * night is 02:30; a time shown twice when they go back is the first.
 */
export function instantOfWallClock(wall: Wall, timeZone: string): number {
  const asIf = asUtc(wall);
  // A zone changes its offset at most once in a day, so the offsets a day
  // either side are the only two this time can be on.
  const before = asIf - offsetAt(asIf - DAY, timeZone);
  const after = asIf - offsetAt(asIf + DAY, timeZone);
  const shows = (instant: number) => asUtc(wallClockAt(instant, timeZone)) === asIf;
  const fits = [before, after].filter(shows);
  return fits.length > 0 ? Math.min(...fits) : before;
}

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");
/** A calendar day as "YYYY-MM-DD". */
export const dayKey = (year: number, month: number, day: number) =>
  `${year}-${pad(month)}-${pad(day)}`;

/** The hour and minute of a rule's "HH:MM". */
export function repeatTime(rule: Pick<RepeatRule, "time">): [hour: number, minute: number] {
  const [hour = 0, minute = 0] = rule.time.split(":").map(Number);
  return [hour, minute];
}

/** Whether a rule goes out on a calendar day, `weekday` 0 for Sunday. */
function goesOn(rule: RepeatRule, year: number, month: number, day: number, weekday: number) {
  switch (rule.every) {
    case "day":
      return true;
    case "weekday":
      return weekday >= 1 && weekday <= 5;
    case "week":
      return weekday === rule.weekday;
    case "month":
      // The 31st is a shorter month's last day.
      return day === Math.min(rule.monthDay ?? 1, daysInMonth(year, month));
  }
}

/**
 * The first time the rule goes after `after`, or null once its end date has
 * passed. Days are counted on the rule's own calendar, so a day that a
 * daylight-saving change makes 23 or 25 hours long moves nothing.
 */
export function nextRepeat(rule: RepeatRule, after: number): number | null {
  const [hour, minute] = repeatTime(rule);
  const [year, month, day] = wallClockAt(after, rule.timeZone);
  // A month rule goes at least once in any 31 days; the rest go within a week.
  for (let i = 0; i <= 62; i++) {
    const date = new Date(Date.UTC(year, month - 1, day + i));
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    if (rule.until && dayKey(y, m, d) > rule.until) return null;
    if (!goesOn(rule, y, m, d, date.getUTCDay())) continue;
    const at = instantOfWallClock([y, m, d, hour, minute], rule.timeZone);
    if (at > after) return at;
  }
  return null;
}

/** The first time the rule goes at or after `from`: when a new one is first sent. */
export const firstRepeat = (rule: RepeatRule, from: number): number | null =>
  nextRepeat(rule, from - 1);

/**
 * The parts of a rule a chosen first send decides: its time of day, its day
 * of the week and its date, as the Repeat choices offer them.
 */
export function repeatAnchors(
  at: number,
  timeZone: string,
): { time: string; weekday: number; monthDay: number } {
  const [year, month, day, hour, minute] = wallClockAt(at, timeZone);
  return {
    time: `${pad(hour)}:${pad(minute)}`,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    monthDay: day,
  };
}
