import { afterEach, describe, expect, it } from "vitest";
import { formatFull, formatTime, formatWhen } from "../src/lib/format.js";
import { timeIn } from "../src/lib/localTime.js";
import { readerLocale, setReaderLocale } from "../src/lib/readerLocale.js";
import { formatScheduleTime } from "../src/lib/schedule.js";
import { dayLabel } from "../src/lib/searchFilters.js";
import { resumeTime } from "../src/lib/snooze.js";

/**
 * The desktop app sets the system's regional format, since Chromium writes
 * times in its UI language: an English install on a Windows set to 24-hour
 * times showed "3:05 PM". Every time and date follows the locale it sets.
 */
afterEach(() => setReaderLocale(undefined));

const afternoon = new Date(2026, 2, 14, 15, 5).getTime();
const browsers = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

describe("the reader's locale", () => {
  it("writes times on the 24-hour clock when the system does", () => {
    expect(formatTime(afternoon)).toBe(browsers.format(afternoon));
    setReaderLocale("en-US-u-hc-h23");
    expect(formatTime(afternoon)).toBe("15:05");
    expect(formatWhen(afternoon, afternoon + 60_000)).toBe("15:05");
    expect(formatFull(afternoon)).toContain("15:05");
    expect(formatScheduleTime(afternoon, new Date(afternoon))).toBe("Today at 15:05");
    expect(resumeTime(afternoon, new Date(afternoon))).toBe("15:05");
    expect(timeIn("UTC", Date.UTC(2026, 2, 14, 15, 5))).toBe("15:05");
  });

  it("writes dates in the system's regional style", () => {
    setReaderLocale("en-GB");
    expect(dayLabel("2026-03-14")).toBe("14/03/2026");
    expect(formatWhen(new Date(2025, 9, 3).getTime(), afternoon)).toBe("3 Oct 2025");
  });

  it("keeps the browser's own for a locale it cannot use", () => {
    setReaderLocale("not a locale!");
    expect(readerLocale()).toBeUndefined();
    expect(formatTime(afternoon)).toBe(browsers.format(afternoon));
  });
});
