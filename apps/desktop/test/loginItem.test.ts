import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HIDDEN_ARG,
  autostartFile,
  desktopExec,
  linuxLoginItem,
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

describe("opening with the computer on Linux", () => {
  const made: string[] = [];
  const home = () => {
    const dir = mkdtempSync(join(tmpdir(), "ownbase-autostart-"));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("is an entry in the autostart folder the desktop reads at sign-in", () => {
    expect(autostartFile({}, "/home/sam")).toBe("/home/sam/.config/autostart/ownbase.desktop");
    expect(autostartFile({ XDG_CONFIG_HOME: "/data/config" }, "/home/sam")).toBe(
      "/data/config/autostart/ownbase.desktop",
    );
    // A relative XDG_CONFIG_HOME is invalid, and ignored as the spec says.
    expect(autostartFile({ XDG_CONFIG_HOME: "config" }, "/home/sam")).toBe(
      "/home/sam/.config/autostart/ownbase.desktop",
    );
  });

  it("starts the app it was turned on from, hidden, and stops when turned off", () => {
    const file = join(home(), "autostart", "ownbase.desktop");
    const item = linuxLoginItem(file, "/home/sam/Apps/OwnBase.AppImage");
    expect(item.get()).toBe(false);
    item.set(true);
    expect(item.get()).toBe(true);
    const entry = readFileSync(file, "utf8");
    expect(entry).toMatch(/^\[Desktop Entry\]$/m);
    expect(entry).toMatch(/^Type=Application$/m);
    expect(entry).toMatch(/^Exec="\/home\/sam\/Apps\/OwnBase\.AppImage" --hidden$/m);
    expect(openedAtLogin("linux", ["/home/sam/Apps/OwnBase.AppImage", HIDDEN_ARG], {})).toBe(true);
    item.set(false);
    expect(item.get()).toBe(false);
    item.set(false);
  });

  it("counts an entry the desktop's own settings turned off as off", () => {
    const file = join(home(), "ownbase.desktop");
    const item = linuxLoginItem(file, "/opt/OwnBase/ownbase");
    item.set(true);
    writeFileSync(file, `${readFileSync(file, "utf8")}Hidden=true${String.fromCharCode(10)}`);
    expect(item.get()).toBe(false);
    item.set(true);
    writeFileSync(file, `${readFileSync(file, "utf8")}X-GNOME-Autostart-enabled=false`);
    expect(item.get()).toBe(false);
  });

  it("quotes the path as the desktop entry spec asks", () => {
    expect(desktopExec("/opt/OwnBase/ownbase")).toBe('"/opt/OwnBase/ownbase"');
    expect(desktopExec("/home/sam/My Apps/OwnBase.AppImage")).toBe(
      '"/home/sam/My Apps/OwnBase.AppImage"',
    );
    // A field code is %, and inside quotes ", `, $ and \ are escaped, then
    // each backslash again, as a string value.
    expect(desktopExec('/a/100%/"b"/$c/`d`/e\\f')).toBe(
      '"/a/100%%/\\\\"b\\\\"/\\\\$c/\\\\`d\\\\`/e\\\\\\\\f"',
    );
    expect(() => desktopExec("/a\nb")).toThrow();
  });
});
