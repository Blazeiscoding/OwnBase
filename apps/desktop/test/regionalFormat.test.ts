import { describe, expect, it, vi } from "vitest";
import {
  hourCycleFromPattern,
  readerLocale,
  systemHourCycle,
  windowsShortTime,
} from "../src/main/regionalFormat.js";

describe("the system's regional format", () => {
  it("reads the clock from a time pattern", () => {
    expect(hourCycleFromPattern("HH:mm")).toBe("h23");
    expect(hourCycleFromPattern("H:mm")).toBe("h23");
    expect(hourCycleFromPattern("h:mm tt")).toBe("h12");
    expect(hourCycleFromPattern("hh:mm tt")).toBe("h12");
    expect(hourCycleFromPattern("HH'h'mm")).toBe("h23");
    expect(hourCycleFromPattern("mm")).toBeNull();
  });

  it("finds Windows' short time format in what reg prints", () => {
    const output =
      "\r\nHKEY_CURRENT_USER\\Control Panel\\International\r\n    sShortTime    REG_SZ    HH:mm\r\n\r\n";
    expect(windowsShortTime(output)).toBe("HH:mm");
    expect(windowsShortTime("ERROR: nothing here")).toBeNull();
  });

  it("asks Windows for its short time format", async () => {
    const run = vi.fn(async () => "    sShortTime    REG_SZ    h:mm tt\r\n");
    expect(await systemHourCycle("win32", run)).toBe("h12");
    expect(run).toHaveBeenCalledWith("reg.exe", [
      "query",
      "HKCU\\Control Panel\\International",
      "/v",
      "sShortTime",
    ]);
  });

  it("asks macOS whether it forces a clock", async () => {
    const answers: Record<string, string> = { AppleICUForce24HourTime: "1\n" };
    const run = async (_command: string, args: string[]) => {
      const answer = answers[args[2]!];
      if (answer === undefined) throw new Error("does not exist");
      return answer;
    };
    expect(await systemHourCycle("darwin", run)).toBe("h23");
    delete answers.AppleICUForce24HourTime;
    expect(await systemHourCycle("darwin", run)).toBeNull();
  });

  it("leaves the clock to the locale where it cannot be read", async () => {
    const failing = async () => {
      throw new Error("denied");
    };
    expect(await systemHourCycle("win32", failing)).toBeNull();
    expect(await systemHourCycle("linux", failing)).toBeNull();
  });

  it("writes in the system's locale when it is the app's language, on the system's clock", () => {
    expect(readerLocale({ appLocale: "en-US", systemLocale: "en-IN", hourCycle: "h23" })).toBe(
      "en-IN-u-hc-h23",
    );
    expect(readerLocale({ appLocale: "en-US", systemLocale: "en_GB", hourCycle: null })).toBe(
      "en-GB",
    );
  });

  it("keeps the app's language when the system's format is in another", () => {
    expect(readerLocale({ appLocale: "en-US", systemLocale: "de-DE", hourCycle: "h23" })).toBe(
      "en-US-u-hc-h23",
    );
  });

  it("changes nothing when the page would write the same anyway", () => {
    expect(readerLocale({ appLocale: "en-US", systemLocale: "en-US", hourCycle: null })).toBeNull();
    expect(readerLocale({ appLocale: "", systemLocale: "", hourCycle: "h23" })).toBeNull();
  });
});
