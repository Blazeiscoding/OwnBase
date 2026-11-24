import { readerLocale } from "./readerLocale.js";
import { zoneLabel } from "./localTime.js";

// Apart from localTime, which the first screen needs: only the profile's form uses this.

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
