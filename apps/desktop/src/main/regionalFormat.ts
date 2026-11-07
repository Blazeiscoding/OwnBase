/**
 * The system's regional format for dates and times. Chromium writes them in
 * its UI language, so an English install on a Windows set to 24-hour times
 * (or to Indian or British dates) showed "3:05 PM" and "March 14". The page
 * is handed a locale that says what the system does instead.
 */

export type HourCycle = "h23" | "h12";

/** A time pattern such as Windows' "HH:mm" or "h:mm tt": H is 24-hour, h is 12-hour. */
export function hourCycleFromPattern(pattern: string): HourCycle | null {
  const bare = pattern.replace(/'[^']*'/g, "");
  if (bare.includes("H")) return "h23";
  if (bare.includes("h")) return "h12";
  return null;
}

/** The short time format in `reg query "HKCU\Control Panel\International" /v sShortTime` output. */
export function windowsShortTime(output: string): string | null {
  return /^\s*sShortTime\s+REG_SZ\s+(.+?)\s*$/m.exec(output)?.[1] ?? null;
}

/** Runs a program and gives back what it printed, or rejects. */
export type RunProgram = (command: string, args: string[]) => Promise<string>;

/**
 * Whether the system writes times on the 24- or 12-hour clock, where it says
 * so beyond its locale: Windows' short time format, and macOS's 24-hour switch.
 * Null where it cannot be read, which leaves it to the locale.
 */
export async function systemHourCycle(
  platform: NodeJS.Platform,
  run: RunProgram,
): Promise<HourCycle | null> {
  try {
    if (platform === "win32") {
      const pattern = windowsShortTime(
        await run("reg.exe", ["query", "HKCU\\Control Panel\\International", "/v", "sShortTime"]),
      );
      return pattern ? hourCycleFromPattern(pattern) : null;
    }
    if (platform === "darwin") {
      const forced = async (key: string) =>
        (await run("defaults", ["read", "-g", key]).catch(() => "")).trim() === "1";
      if (await forced("AppleICUForce24HourTime")) return "h23";
      if (await forced("AppleICUForce12HourTime")) return "h12";
    }
  } catch {
    // Unreadable: the locale decides.
  }
  return null;
}

const language = (tag: string) => tag.split("-")[0]!.toLowerCase();

/**
 * The locale to write dates and times in: the system's regional format when
 * it is in the app's language (en-IN for an English app in India), else the
 * app's own, with the system's clock. Null when that is what the page would
 * use anyway, or nothing usable is known.
 */
export function readerLocale(options: {
  appLocale: string;
  systemLocale: string;
  hourCycle: HourCycle | null;
}): string | null {
  const app = options.appLocale.replaceAll("_", "-");
  const system = options.systemLocale.replaceAll("_", "-");
  const base = system && app && language(system) === language(app) ? system : app;
  if (!base) return null;
  try {
    const locale = new Intl.Locale(base, options.hourCycle ? { hourCycle: options.hourCycle } : {});
    const tag = locale.toString();
    return tag === app ? null : tag;
  } catch {
    return null;
  }
}
