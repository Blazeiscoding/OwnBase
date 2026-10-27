import { describe, expect, it } from "vitest";
import {
  HIDDEN_ARG,
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
