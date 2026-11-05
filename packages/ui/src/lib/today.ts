import { useSyncExternalStore } from "react";

/**
 * Today, as the start of the local calendar day, for whatever says "Today",
 * "Yesterday" or "Mon 3:41 PM": they are true only on the day they were
 * drawn. A window left open overnight kept calling yesterday's messages
 * "Today" until it was reloaded. One timer for every reader, set for the
 * next midnight, and looked at again when the window comes back (a computer
 * that slept through midnight) and every hour (a clock or zone change).
 */
export function startOfToday(now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const HOUR = 3_600_000;
const listeners = new Set<() => void>();
let seen = startOfToday();
let timer: ReturnType<typeof setTimeout> | undefined;

function check() {
  const today = startOfToday();
  if (today !== seen) {
    seen = today;
    for (const listener of [...listeners]) listener();
  }
  schedule();
}

function schedule() {
  clearTimeout(timer);
  timer = undefined;
  if (listeners.size === 0) return;
  const now = Date.now();
  const midnight = new Date(seen);
  midnight.setDate(midnight.getDate() + 1);
  // A moment past midnight, so the day has turned when it is read.
  timer = setTimeout(check, Math.max(1_000, Math.min(midnight.getTime() - now + 500, HOUR)));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    seen = startOfToday();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    schedule();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.removeEventListener("focus", check);
    document.removeEventListener("visibilitychange", check);
    schedule();
  };
}

/** Today's start; the component reading it draws again when the day turns. */
export function useToday(): number {
  return useSyncExternalStore(subscribe, startOfToday, startOfToday);
}
