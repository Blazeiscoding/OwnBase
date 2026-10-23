import { useEffect, useState } from "react";
import { currentZoneName, type User } from "@slackoss/protocol";

/**
 * Someone's local time (E9): the time in their zone, as this reader writes
 * times, and whether it is not the reader's own.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The time of day at `at` in a zone, such as "9:42 PM"; null for a zone this device does not know. */
export function timeIn(timeZone: string, at: number): string | null {
  let format = formatters.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      });
    } catch {
      return null;
    }
    formatters.set(timeZone, format);
  }
  return format.format(at);
}

/**
 * This reader's zone: the one their account keeps, or else this device's,
 * under its current name, where Chromium gives India's as "Asia/Calcutta".
 */
export function readerTimeZone(self: User | null | undefined): string {
  if (self?.timeZone) return self.timeZone;
  try {
    return currentZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return "UTC";
  }
}

/** A zone as people write it: "America/New York" for "America/New_York". */
export function zoneLabel(timeZone: string): string {
  return currentZoneName(timeZone).replaceAll("_", " ");
}

/**
 * Someone's time now, and whether their clock reads otherwise than the
 * reader's; null when their zone is not known.
 */
export function theirTime(
  user: User | undefined,
  self: User | null | undefined,
  at: number,
): { time: string; differs: boolean } | null {
  if (!user?.timeZone) return null;
  const time = timeIn(user.timeZone, at);
  if (!time) return null;
  return { time, differs: time !== timeIn(readerTimeZone(self), at) };
}

/** The time now, changing as each minute starts, for a clock shown on screen. */
export function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    return () => clearTimeout(timer);
  }, []);
  return now;
}
