import { describe, expect, it } from "vitest";
import { hostWithPort, isIconVersion, isLinkableAddress } from "../src/discovery.js";

describe("building an address from a discovered host and port", () => {
  it("puts an IPv6 literal in brackets, and nothing else", () => {
    expect(hostWithPort("192.168.1.20", 8543)).toBe("192.168.1.20:8543");
    expect(hostWithPort("rocket.local", 8543)).toBe("rocket.local:8543");
    expect(hostWithPort("2001:db8::1", 8543)).toBe("[2001:db8::1]:8543");
    expect(hostWithPort("::1", 9000)).toBe("[::1]:9000");
    // Already bracketed is not bracketed twice.
    expect(hostWithPort("[2001:db8::1]", 8543)).toBe("[2001:db8::1]:8543");
  });

  it("builds something a URL can read back", () => {
    const url = new URL(`http://${hostWithPort("2001:db8::1", 8543)}`);
    expect(url.hostname).toBe("[2001:db8::1]");
    expect(url.port).toBe("8543");
  });

  it("refuses link-local IPv6, whose interface no link can name", () => {
    expect(isLinkableAddress("192.168.1.20")).toBe(true);
    expect(isLinkableAddress("2001:db8::1")).toBe(true);
    expect(isLinkableAddress("fd12:3456::1")).toBe(true);
    expect(isLinkableAddress("fe80::1")).toBe(false);
    expect(isLinkableAddress("FEBF::1")).toBe(false);
    expect(isLinkableAddress("fe80::1%en0")).toBe(false);
    expect(isLinkableAddress("")).toBe(false);
  });
});

describe("an icon version from an announcement", () => {
  it("is taken only in the form a server makes one", () => {
    expect(isIconVersion("0123456789abcdef")).toBe(true);
    expect(isIconVersion("0123456789ABCDEF")).toBe(false);
    expect(isIconVersion("0123456789abcde")).toBe(false);
    expect(isIconVersion("0123456789abcdef0")).toBe(false);
    expect(isIconVersion("../../admin/abcd")).toBe(false);
    expect(isIconVersion("")).toBe(false);
    expect(isIconVersion(undefined)).toBe(false);
    expect(isIconVersion(1234567890123456)).toBe(false);
  });
});
