import { minutesOf, runtimeZone, scheduleAllows, type NotifySchedule } from "./notifySchedule.js";
import { instantOfWallClock, wallClockAt } from "./repeat.js";

/**
 * When a notification schedule (K12) opens next, for the app to say so. Kept
 * apart from the check itself, which every notification makes, so the app
 * loads the calendar arithmetic only where it shows the time.
 */

const DAY = 86_400_000;

/**
 * When notifications come back, while the schedule holds them at `now`;
 * otherwise null.
 */
export function scheduleQuietUntil(
  schedule: NotifySchedule | null | undefined,
  timeZone: string | null | undefined,
  now: number,
): number | null {
  if (!schedule || scheduleAllows(schedule, timeZone, now)) return null;
  const zone = timeZone || runtimeZone();
  const [year, month, day] = wallClockAt(now, zone);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  // The next day whose hours start after now; a week on at most.
  for (let ahead = 0; ahead <= 7; ahead++) {
    const hours = schedule.days[(weekday + ahead) % 7];
    if (!hours) continue;
    const date = new Date(Date.UTC(year, month - 1, day) + ahead * DAY);
    const from = minutesOf(hours.from);
    const opens = instantOfWallClock(
      [
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        Math.floor(from / 60),
        from % 60,
      ],
      zone,
    );
    if (opens > now) return opens;
  }
  return null;
}
