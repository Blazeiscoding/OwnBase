import { currentZoneName, type RepeatEvery, type RepeatRule } from "@ownbase/protocol";
import { readerLocale } from "./readerLocale.js";

/**
 * Repeating scheduled messages in words (K14): the Repeat choices Send later
 * offers, and the line Scheduled shows for one.
 */

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** "1st", "2nd", "23rd", "31st". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** This device's zone, under its current name. */
export const deviceZone = () => currentZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone);

/** "9:00 AM", or "09:00" where the reader's clock has 24 hours. */
function clockTime(time: string): string {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return new Date(Date.UTC(2000, 0, 1, hour, minute)).toLocaleTimeString(readerLocale(), {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** How often, without the time: "Every weekday", "Every month on the 31st". */
export function repeatEveryText(every: RepeatEvery, weekday?: number, monthDay?: number): string {
  switch (every) {
    case "day":
      return "Every day";
    case "weekday":
      return "Every weekday";
    case "week":
      return weekday === undefined ? "Every week" : `Every week on ${WEEKDAYS[weekday]}`;
    case "month":
      return monthDay === undefined ? "Every month" : `Every month on the ${ordinal(monthDay)}`;
  }
}

/**
 * "Every weekday at 9:00 AM", with its zone when it is not this device's and
 * its last day when it has one.
 */
export function describeRepeat(rule: RepeatRule): string {
  const zone = rule.timeZone === deviceZone() ? "" : ` (${rule.timeZone.replaceAll("_", " ")})`;
  const until = rule.until
    ? `, until ${new Date(`${rule.until}T12:00:00Z`).toLocaleDateString(readerLocale(), {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })}`
    : "";
  return `${repeatEveryText(rule.every, rule.weekday, rule.monthDay)} at ${clockTime(rule.time)}${zone}${until}`;
}
