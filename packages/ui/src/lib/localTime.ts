import { useEffect, useState } from "react";
import { currentZoneName, type User } from "@ownbase/protocol";
import { readerLocale } from "./readerLocale.js";

/**
 * Someone's local time (E9): the time in their zone, as this reader writes
 * times, and whether it is not the reader's own.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The time of day at `at` in a zone, such as "9:42 PM"; null for a zone this device does not know. */
export function timeIn(timeZone: string, at: number): string | null {
  const key = `${readerLocale() ?? ""} ${timeZone}`;
  let format = formatters.get(key);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(readerLocale(), {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      });
    } catch {
      return null;
    }
    formatters.set(key, format);
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

/** A zone as the profile's list offers it. */
export interface ZoneChoice {
  zone: string;
  /** "(UTC+05:30) Kolkata · India Standard Time". */
  label: string;
  /** Minutes ahead of UTC at the moment the list was made, for its order. */
  offset: number;
  /** What a search of the list matches, in lower case. */
  words: string;
}

/** Minutes ahead of UTC from Intl's "GMT+05:30", "GMT-8" or plain "GMT". */
function offsetMinutes(name: string): number {
  const found = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!found) return 0;
  const minutes = Number(found[2]) * 60 + Number(found[3] ?? 0);
  return found[1] === "-" ? -minutes : minutes;
}

function partOf(zone: string, at: number, style: "longOffset" | "long"): string {
  try {
    const parts = new Intl.DateTimeFormat(readerLocale(), {
      timeZone: zone,
      timeZoneName: style,
    }).formatToParts(at);
    return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/**
 * Zones as Slack lists them: the offset first, then the city and the zone's
 * name in the reader's language, in order of the offset and then the city.
 * Chromium names some zones only by their offset; those keep just the city.
 */
export function zoneChoices(zones: readonly string[], at = Date.now()): ZoneChoice[] {
  return zones
    .map((zone) => {
      const offset = offsetMinutes(partOf(zone, at, "longOffset"));
      const sign = offset < 0 ? "-" : "+";
      const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
      const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
      const utc = offset === 0 ? "UTC" : `UTC${sign}${hours}:${minutes}`;
      const city = zoneLabel(zone).split("/").at(-1) ?? zone;
      const long = partOf(zone, at, "long");
      const named = long && !/^(GMT|UTC)/.test(long) ? ` · ${long}` : "";
      const label = `(${utc}) ${city}${named}`;
      return { zone, label, offset, words: `${label} ${zoneLabel(zone)}`.toLowerCase() };
    })
    .sort((a, b) => a.offset - b.offset || a.label.localeCompare(b.label));
}
