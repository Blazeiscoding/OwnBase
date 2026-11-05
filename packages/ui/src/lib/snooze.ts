import { formatScheduleTime, tomorrowMorning } from "./schedule.js";
import { readerLocale } from "./readerLocale.js";

/** "9:00 AM" today, otherwise "tomorrow at 9:00 AM" or the day it falls on. */
export function resumeTime(until: number, now: Date): string {
  const when = new Date(until);
  if (when.toDateString() === now.toDateString())
    return when.toLocaleTimeString(readerLocale(), { hour: "numeric", minute: "2-digit" });
  return formatScheduleTime(until, now).replace(/^Tomorrow/, "tomorrow");
}

/** Worked out when the menu opens, so tomorrow means the next morning, not twelve hours. */
export function snoozeOptions(now: Date) {
  const morning = tomorrowMorning(now).getTime();
  return [
    { label: "30 minutes", until: () => Date.now() + 30 * 60_000 },
    { label: "1 hour", until: () => Date.now() + 60 * 60_000 },
    { label: `Until ${resumeTime(morning, now)}`, until: () => morning },
  ];
}
