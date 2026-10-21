/** Preset times offered when scheduling a message. */
export interface SchedulePreset {
  label: string;
  at: Date;
}

/** Value for datetime-local inputs, without converting the local clock to UTC. */
export function localDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Next occurrence of `hour` on the given day offset, at minute 0. */
function at(hour: number, dayOffset = 0, base = new Date()): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** 9:00 on the next calendar day, in this device's time zone. */
export function tomorrowMorning(now = new Date()): Date {
  return at(9, 1, now);
}

/**
 * Presets relative to now: a short delay, later today if there's still day
 * left, then tomorrow and the start of next week.
 */
export function schedulePresets(now = new Date()): SchedulePreset[] {
  const out: SchedulePreset[] = [
    { label: "In 30 minutes", at: new Date(now.getTime() + 30 * 60_000) },
    { label: "In an hour", at: new Date(now.getTime() + 60 * 60_000) },
  ];

  // "This evening" is only meaningful while it is still ahead.
  const evening = at(18, 0, now);
  if (evening.getTime() > now.getTime() + 60 * 60_000) {
    out.push({ label: "This evening", at: evening });
  }

  out.push({ label: "Tomorrow morning", at: tomorrowMorning(now) });

  // Monday, skipping to next week if today is already Monday.
  const monday = at(9, (8 - now.getDay()) % 7 || 7, now);
  out.push({ label: "Monday morning", at: monday });

  return out;
}

/**
 * A reminder's presets (E4): soon, later today, tomorrow morning, and the
 * start of next week (Monday, a week on if today is Monday).
 */
export function reminderPresets(now = new Date()): SchedulePreset[] {
  return [
    { label: "In 20 minutes", at: new Date(now.getTime() + 20 * 60_000) },
    { label: "In 1 hour", at: new Date(now.getTime() + 60 * 60_000) },
    { label: "In 3 hours", at: new Date(now.getTime() + 3 * 60 * 60_000) },
    { label: "Tomorrow morning", at: tomorrowMorning(now) },
    { label: "Next week", at: at(9, (8 - now.getDay()) % 7 || 7, now) },
  ];
}

/**
 * When a reminder is for, to follow "Remind me" or "Reminder set for":
 * "today at 3:00 PM", "tomorrow at 9:00 AM" or "Mon, Jan 5 at 9:00 AM".
 */
export function formatReminderTime(ts: number, today = new Date()): string {
  return formatScheduleShort(ts, today).replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase());
}

/**
 * "Tomorrow at 9:00 AM" or "Mon, Jan 5 at 9:00 AM": a scheduled time short
 * enough to name on the button that schedules it. The year is said only when
 * it is not this one.
 */
export function formatScheduleShort(ts: number, today = new Date()): string {
  const date = new Date(ts);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `Today at ${time}`;
  if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow at ${time}`;
  const day = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day} at ${time}`;
}

/** "Tomorrow at 9:00 AM" — how a scheduled time reads in the UI. */
export function formatScheduleTime(ts: number, today = new Date()): string {
  const date = new Date(ts);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `Today at ${time}`;
  if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow at ${time}`;
  return `${date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })} at ${time}`;
}
