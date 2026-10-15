import { formatDay, formatTime, sameDay } from "./format.js";

/** How long a status lasts before it clears itself (UX-61). */
export type ClearAfter = "never" | "30m" | "1h" | "today" | "week";

export const CLEAR_AFTER: readonly { id: ClearAfter; label: string }[] = [
  { id: "never", label: "Don't clear" },
  { id: "30m", label: "30 minutes" },
  { id: "1h", label: "1 hour" },
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
];

/** Statuses people set most, offered wherever a status is chosen, each for as long as it usually lasts. */
export const STATUS_PRESETS: readonly { emoji: string; text: string; clearAfter: ClearAfter }[] = [
  { emoji: "💬", text: "In a meeting", clearAfter: "1h" },
  { emoji: "🎧", text: "Heads down", clearAfter: "today" },
  { emoji: "🍜", text: "Out for lunch", clearAfter: "1h" },
  { emoji: "🌴", text: "On holiday", clearAfter: "never" },
  { emoji: "🤒", text: "Off sick", clearAfter: "today" },
];

/**
 * When a status chosen now ends, in epoch ms, or null for one that stays.
 * Today ends at its last moment, and this week at Sunday's, on this device's
 * clock, so each is said as that day: "until 11:59 PM", "until Sunday".
 */
export function statusEnd(clearAfter: ClearAfter, now = new Date()): number | null {
  if (clearAfter === "never") return null;
  if (clearAfter === "30m") return now.getTime() + 30 * 60_000;
  if (clearAfter === "1h") return now.getTime() + 60 * 60_000;
  const days = clearAfter === "today" ? 1 : 8 - (now.getDay() || 7);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days).getTime() - 1;
}

/** When a status ends, as its owner reads it: "until 3:41 PM" today, else "until Sunday, October 18". */
export function statusUntil(ends: number, now = Date.now()): string {
  return `until ${sameDay(ends, now) ? formatTime(ends) : formatDay(ends)}`;
}
