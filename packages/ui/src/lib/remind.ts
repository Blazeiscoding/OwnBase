import { dayKey, wallClockAt, type Channel, type ID, type RepeatRule } from "@ownbase/protocol";
import { WEEKDAYS } from "./repeat.js";

/**
 * `/remind #channel <message> every <rule> at <time> [until <date>]` (K14),
 * read in plain words. It posts the message to the channel on that rule, as
 * Slack's channel reminders do; reminding yourself is Remind me on a message.
 *
 * - The channel comes first: `#name` or a picked mention. Left out, it is this
 *   conversation.
 * - The rule: `day`, `weekday`, `<weekday>` or `week on <weekday>` (Monday,
 *   Mon, Mondays), `month on the 15th` (or `month on 15`).
 * - The time: `9`, `9am`, `9:30`, `9:30 pm`, `17:00`, `noon`, `midnight`.
 * - The end: `until 2026-12-31`, `until 31 December`, `until Dec 31 2026`.
 *
 * The message is everything between the channel and the last ` every `, so it
 * may say "every" itself, and may be in quotes, which are taken off.
 */

export type RemindParse =
  | { ok: true; channelId: ID; text: string; rule: Omit<RepeatRule, "timeZone"> }
  | { ok: false; said: string };

const USAGE = "Write it like this: /remind #channel Standup notes every weekday at 9:00";

const DAY_NAMES = WEEKDAYS.map((d) => d.toLowerCase());
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** A weekday by name, its first three letters, or plural: 0 for Sunday. */
function weekdayOf(word: string): number | null {
  const w = word.toLowerCase().replace(/s$/, "");
  const found = DAY_NAMES.findIndex((d) => d === w || d.slice(0, 3) === w);
  return found === -1 ? null : found;
}

/** "9", "9am", "9:30 pm", "17:00", "noon": as "HH:MM", or null. */
export function parseClock(words: string): string | null {
  const w = words.trim().toLowerCase().replace(/\./g, "");
  if (w === "noon") return "12:00";
  if (w === "midnight") return "00:00";
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(w);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const half = match[3];
  if (minute > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === "pm" ? 12 : 0);
  } else if (hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** How often, from what follows "every". */
function parseEvery(words: string): Pick<RepeatRule, "every" | "weekday" | "monthDay"> | null {
  const w = words.trim().toLowerCase().replace(/\s+/g, " ");
  if (w === "day" || w === "days") return { every: "day" };
  if (w === "weekday" || w === "weekdays" || w === "work day" || w === "workday")
    return { every: "weekday" };
  const weekly = /^(?:week on )?([a-z]+)$/.exec(w);
  const weekday = weekly ? weekdayOf(weekly[1]!) : null;
  if (weekday !== null) return { every: "week", weekday };
  const monthly = /^month on (?:the |day )?(\d{1,2})(?:st|nd|rd|th)?$/.exec(w);
  const monthDay = monthly ? Number(monthly[1]) : 0;
  if (monthDay >= 1 && monthDay <= 31) return { every: "month", monthDay };
  return null;
}

/** An end date: ISO, "31 December [2026]" or "Dec 31[,] [2026]"; without a year, the next one. */
export function parseUntil(words: string, timeZone: string, now = Date.now()): string | null {
  const w = words.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  const [ty, tm, td] = wallClockAt(now, timeZone);
  const today = dayKey(ty, tm, td);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
  let year: number | null;
  let month: number;
  let day: number;
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else {
    const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)(?: (\d{4}))?$/.exec(w);
    const monthFirst = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(w);
    const [dayWord, monthWord, yearWord] = dayFirst
      ? [dayFirst[1]!, dayFirst[2]!, dayFirst[3]]
      : monthFirst
        ? [monthFirst[2]!, monthFirst[1]!, monthFirst[3]]
        : [];
    if (!dayWord || !monthWord) return null;
    const m = MONTHS.findIndex((name) => name === monthWord || name.slice(0, 3) === monthWord);
    if (m === -1) return null;
    [year, month, day] = [yearWord ? Number(yearWord) : null, m + 1, Number(dayWord)];
  }
  const fits = (y: number) => {
    const probe = new Date(Date.UTC(y, month - 1, day));
    return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
  };
  if (year === null) {
    year = ty;
    if (!fits(year) || dayKey(year, month, day) < today) year += 1;
  }
  return fits(year) ? dayKey(year, month, day) : null;
}

/** A /remind command's words, or why they cannot be read. */
export function parseRemind(
  args: string,
  here: { channelId: ID; channels: Record<ID, Channel>; timeZone: string; now?: number },
): RemindParse {
  let rest = args.trim();
  if (!rest) return { ok: false, said: USAGE };
  const [first = ""] = rest.split(/\s+/, 1);
  if (/^(me|@\S*|<@[^>]+>)$/i.test(first))
    return {
      ok: false,
      said: "/remind posts to a channel. To remind yourself, choose Remind me on a message.",
    };
  let channelId = here.channelId;
  const picked = /^<#([^>|]+)(?:\|[^>]*)?>/.exec(rest);
  const named = /^#([^\s]+)/.exec(rest);
  if (picked) {
    channelId = picked[1]!;
    rest = rest.slice(picked[0].length);
  } else if (named) {
    const name = named[1]!.toLowerCase();
    const found = Object.values(here.channels).find((c) => c.name?.toLowerCase() === name);
    if (!found)
      return { ok: false, said: `There is no channel called #${named[1]} that you can see.` };
    channelId = found.id;
    rest = rest.slice(named[0].length);
  }
  if (!here.channels[channelId]) return { ok: false, said: "That channel is not one you can see." };

  const shape = /^\s*([\s\S]+)\s+every\s+(.+?)\s+at\s+(.+?)(?:\s+until\s+(.+))?$/i.exec(rest);
  if (!shape) return { ok: false, said: USAGE };
  const text = shape[1]!
    .trim()
    .replace(/^"([\s\S]*)"$/, "$1")
    .replace(/^“([\s\S]*)”$/, "$1")
    .trim();
  if (!text) return { ok: false, said: "Write the message to post after the channel." };
  const every = parseEvery(shape[2]!);
  if (!every)
    return {
      ok: false,
      said: `"every ${shape[2]}" is not a repeat /remind knows. Use every day, every weekday, every Monday or every month on the 15th.`,
    };
  const time = parseClock(shape[3]!);
  if (!time)
    return {
      ok: false,
      said: `"at ${shape[3]}" is not a time /remind can read. Use a time like 9:00, 9am or 17:30.`,
    };
  const until = shape[4] ? parseUntil(shape[4], here.timeZone, here.now) : null;
  if (shape[4] && !until)
    return {
      ok: false,
      said: `"until ${shape[4]}" is not a date /remind can read. Use a date like 2026-12-31 or 31 December.`,
    };
  return { ok: true, channelId, text, rule: { ...every, time, until } };
}
