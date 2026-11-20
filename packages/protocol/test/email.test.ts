import { describe, expect, it } from "vitest";
import { emailAddress, isEmailAddress } from "../src/index.js";

describe("an email address as people type one (G10)", () => {
  it("is something@somewhere.tld, without spaces, brackets or a second @", () => {
    for (const ok of ["maya@example.com", "sam.r+chat@mail.example.co.uk", "a@b.c"])
      expect(isEmailAddress(ok)).toBe(true);
    for (const bad of [
      "",
      "maya",
      "maya@",
      "@example.com",
      "maya@example",
      "maya@example.",
      "maya@.com",
      "maya@@example.com",
      "maya@exa@mple.com",
      "maya lin@example.com",
      "Maya <maya@example.com>",
      `${"a".repeat(250)}@b.cd`,
    ])
      expect(isEmailAddress(bad)).toBe(false);
  });

  it("is what requests check, trimmed", () => {
    expect(emailAddress.parse("  maya@example.com ")).toBe("maya@example.com");
    expect(emailAddress.safeParse("maya@example").success).toBe(false);
  });
});
