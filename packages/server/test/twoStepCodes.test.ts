import { describe, expect, it } from "vitest";
import {
  base32,
  checkCode,
  codeFor,
  fromBase32,
  newRecoveryCodes,
  newTwoStepSecret,
  normalRecoveryCode,
  otpauthUri,
  stepAt,
} from "../src/twoStep.js";

/** RFC 6238's own key for SHA-1, "12345678901234567890", in base32. */
const RFC_SECRET = base32(Buffer.from("12345678901234567890", "ascii"));

describe("two-step codes", () => {
  it("are the codes RFC 6238 gives for its test times", () => {
    for (const [seconds, code] of [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ] as const) {
      expect(codeFor(RFC_SECRET, stepAt(seconds * 1000), 8)).toBe(code);
      // Six digits are the last six of eight.
      expect(codeFor(RFC_SECRET, stepAt(seconds * 1000))).toBe(code.slice(2));
    }
  });

  it("keep a key through base32 both ways, whatever its case and spacing", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    expect(fromBase32(base32(bytes))).toEqual(bytes);
    const secret = newTwoStepSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(fromBase32(secret.toLowerCase().replace(/(.{4})/g, "$1 "))).toHaveLength(20);
  });

  it("take a code one step either side of now, and none further", () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    expect(checkCode(RFC_SECRET, codeFor(RFC_SECRET, step), now, null)).toBe(step);
    expect(checkCode(RFC_SECRET, codeFor(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(checkCode(RFC_SECRET, codeFor(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(checkCode(RFC_SECRET, codeFor(RFC_SECRET, step - 2), now, null)).toBeNull();
    expect(checkCode(RFC_SECRET, codeFor(RFC_SECRET, step + 2), now, null)).toBeNull();
    // Spaced as an app shows it.
    const spaced = codeFor(RFC_SECRET, step).replace(/(\d{3})/, "$1 ");
    expect(checkCode(RFC_SECRET, spaced, now, null)).toBe(step);
    expect(checkCode(RFC_SECRET, "12345", now, null)).toBeNull();
    expect(checkCode(RFC_SECRET, "abcdef", now, null)).toBeNull();
  });

  it("refuse a code for a step already used, or before it", () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    const code = codeFor(RFC_SECRET, step);
    expect(checkCode(RFC_SECRET, code, now, step)).toBeNull();
    expect(checkCode(RFC_SECRET, codeFor(RFC_SECRET, step - 1), now, step - 1)).toBeNull();
    expect(checkCode(RFC_SECRET, codeFor(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
  });

  it("name the workspace and the handle for the app", () => {
    const uri = otpauthUri(RFC_SECRET, "Rocket Team", "maya");
    expect(uri).toBe(
      `otpauth://totp/Rocket%20Team%20on%20Tandem%3Amaya?secret=${RFC_SECRET}&issuer=Rocket%20Team%20on%20Tandem&algorithm=SHA1&digits=6&period=30`,
    );
  });

  it("make ten different recovery codes nobody misreads", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/);
    expect(normalRecoveryCode(" K7MQ-3hxv ")).toBe("k7mq3hxv");
  });
});
