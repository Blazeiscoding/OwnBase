import { describe, expect, it } from "vitest";
import {
  carryEarlierLoginItem,
  HIDDEN_ARG,
  type LaunchItem,
  loginItemOptions,
  loginItemProblem,
  openedAtLogin,
} from "../src/main/loginItem.js";

describe("opening with the computer", () => {
  it("registers the hidden argument only where the OS passes it back", () => {
    expect(loginItemOptions("win32")).toEqual({ args: [HIDDEN_ARG] });
    // Electron ignores login-item arguments on macOS; it reports the launch instead.
    expect(loginItemOptions("darwin")).toEqual({});
  });

  it("knows a sign-in launch on Windows by its argument", () => {
    expect(openedAtLogin("win32", ["OwnBase.exe", HIDDEN_ARG], {})).toBe(true);
    expect(openedAtLogin("win32", ["OwnBase.exe"], { wasOpenedAtLogin: true })).toBe(false);
  });

  it("knows a sign-in launch on macOS by what the OS says, with no argument", () => {
    expect(openedAtLogin("darwin", ["OwnBase"], { wasOpenedAtLogin: true })).toBe(true);
    expect(openedAtLogin("darwin", ["OwnBase"], { wasOpenedAtLogin: false })).toBe(false);
    expect(openedAtLogin("darwin", ["OwnBase"], {})).toBe(false);
  });

  it("says when a registration did not take, and why when macOS is waiting to be allowed", () => {
    expect(loginItemProblem("darwin", true, { openAtLogin: true, status: "enabled" })).toBeNull();
    expect(loginItemProblem("darwin", false, { openAtLogin: false })).toBeNull();
    expect(
      loginItemProblem("darwin", true, { openAtLogin: false, status: "requires-approval" }),
    ).toMatch(/Login Items/);
    expect(loginItemProblem("win32", true, { openAtLogin: false })).toMatch(/did not add/);
  });
});

describe("opening with the computer after the name changed", () => {
  const folder = "C:\\Users\\ada\\AppData\\Local\\Programs\\@slackossdesktop";
  const exe = `${folder}\\OwnBase.exe`;
  /** Windows' sign-in entries, and what the app asked of them. */
  function registry(items: LaunchItem[]) {
    const entries = [...items];
    const asked: unknown[] = [];
    return {
      entries,
      asked,
      login: {
        get: (options: { path: string; args: string[] }) => ({
          launchItems: entries.filter(
            (item) => item.path.toLowerCase() === options.path.toLowerCase(),
          ),
        }),
        set: (settings: {
          openAtLogin: boolean;
          name?: string;
          path?: string;
          args?: string[];
        }) => {
          asked.push(settings);
          const at = entries.findIndex((item) => item.name === settings.name);
          if (!settings.openAtLogin && at >= 0) entries.splice(at, 1);
        },
      },
    };
  }
  const tandem = (over: Partial<LaunchItem> = {}): LaunchItem => ({
    name: "electron.app.Tandem",
    path: `${folder}\\Tandem.exe`,
    args: [HIDDEN_ARG],
    scope: "user",
    enabled: true,
    ...over,
  });

  it("moves an entry left under Tandem.exe to this app, hidden as before", () => {
    const { entries, asked, login } = registry([tandem()]);
    expect(carryEarlierLoginItem("win32", exe, login)).toBe(true);
    expect(entries).toEqual([]);
    expect(asked).toEqual([
      {
        openAtLogin: false,
        name: "electron.app.Tandem",
        path: `${folder}\\Tandem.exe`,
        args: [HIDDEN_ARG],
      },
      { openAtLogin: true, args: [HIDDEN_ARG] },
    ]);
  });

  it("removes one that was switched off in Windows' settings, and adds none", () => {
    const { entries, asked, login } = registry([
      tandem({ enabled: false }),
      tandem({ name: "electron.app.Gatherline", path: `${folder}\\Gatherline.exe` }),
    ]);
    // The Gatherline one was on, so this app's own goes in once.
    expect(carryEarlierLoginItem("win32", exe, login)).toBe(true);
    expect(entries).toEqual([]);
    expect(asked.filter((s) => (s as { openAtLogin: boolean }).openAtLogin)).toHaveLength(1);

    const off = registry([tandem({ enabled: false })]);
    expect(carryEarlierLoginItem("win32", exe, off.login)).toBe(false);
    expect(off.entries).toEqual([]);
    expect(off.asked).toEqual([
      {
        openAtLogin: false,
        name: "electron.app.Tandem",
        path: `${folder}\\Tandem.exe`,
        args: [HIDDEN_ARG],
      },
    ]);
  });

  it("leaves alone the machine's entries, other folders, and other systems", () => {
    const machine = registry([tandem({ scope: "machine" })]);
    expect(carryEarlierLoginItem("win32", exe, machine.login)).toBe(false);
    expect(machine.entries).toHaveLength(1);

    const elsewhere = registry([tandem({ path: "D:\\Old\\Tandem.exe" })]);
    expect(carryEarlierLoginItem("win32", exe, elsewhere.login)).toBe(false);
    expect(elsewhere.entries).toHaveLength(1);

    const mac = registry([tandem()]);
    expect(
      carryEarlierLoginItem(
        "darwin",
        "/Applications/OwnBase.app/Contents/MacOS/OwnBase",
        mac.login,
      ),
    ).toBe(false);
    expect(mac.asked).toEqual([]);
  });
});
