import type { Channel, ID, User } from "@ownbase/protocol";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// One formatter each, in the reader's own locale, made once: the time is
// formatted for every message on screen.
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

export function formatTime(ts: number): string {
  return timeFormat.format(ts);
}

/** The whole date and time, for a hint on a time that shows only the hour. */
export function formatFull(ts: number): string {
  return fullFormat.format(ts);
}

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const shortDateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const longDateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * When something happened, as people say it, for lists of messages from
 * many days: "3:41 PM" today, "Yesterday 3:41 PM", "Mon 3:41 PM" within the
 * week, "Oct 3" this year and "Oct 3, 2025" before. One rule for every list,
 * so Activity, search and Saved agree.
 */
export function formatWhen(ts: number, now = Date.now()): string {
  const then = new Date(ts);
  const today = new Date(now);
  // Days are counted on the calendar, since a day with a clock change is
  // not 24 hours long.
  const daysBefore = (n: number) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - n).getTime();
  if (ts >= daysBefore(0)) return timeFormat.format(ts);
  if (ts >= daysBefore(1)) return `Yesterday ${timeFormat.format(ts)}`;
  if (ts >= daysBefore(6)) return `${weekdayFormat.format(ts)} ${timeFormat.format(ts)}`;
  if (then.getFullYear() === today.getFullYear()) return shortDateFormat.format(ts);
  return longDateFormat.format(ts);
}

export function formatDay(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return dayFormat.format(d);
}

export function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** DMs and group DMs are titled by the other members' names. */
export function channelTitle(
  channel: Channel,
  users: Record<ID, User>,
  selfId: ID | undefined,
): string {
  if (channel.type === "public" || channel.type === "private") return channel.name;
  const others = (channel.memberIds ?? []).filter((id) => id !== selfId);
  if (others.length === 0) return users[selfId ?? ""]?.displayName ?? "You";
  return others.map((id) => users[id]?.displayName ?? "unknown").join(", ");
}

const AVATAR_HUES = [18, 42, 96, 152, 200, 258, 312, 340];

/**
 * Dark enough on every hue for white initials to clear 4.5:1; cyan is the
 * closest. An alpha below 1 gives the same hue as a tint, for backgrounds.
 */
export function avatarColor(userId: ID, alpha = 1): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  const hue = AVATAR_HUES[h % AVATAR_HUES.length];
  return alpha < 1 ? `oklch(0.52 0.13 ${hue} / ${alpha})` : `oklch(0.52 0.13 ${hue})`;
}

/**
 * A workspace's own colour, for its tile: one hue from its name, a shade
 * lighter at the top, so two workspaces look different and the same one
 * always the same.
 */
export function workspaceGradient(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = AVATAR_HUES[h % AVATAR_HUES.length];
  return `linear-gradient(180deg, oklch(0.54 0.13 ${hue}), oklch(0.48 0.13 ${hue}))`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}
