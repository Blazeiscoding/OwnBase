import { describe, expect, it } from "vitest";
import {
  addTrustedAddress,
  normalizeWorkspaceAddress,
  readTrustedAddresses,
} from "../src/trustedAddresses.js";

/**
 * The addresses at which a workspace may use one account's work on this
 * device (Q02). Approving one is a single change a store makes for every
 * window, so it is plain data in, plain data out.
 */
const home = "http://192.168.1.20:8543";
const tunnel = "https://rocket-team.trycloudflare.com";
const stored = (...addresses: string[]) => ({ version: 1, addresses });

describe("approving an address", () => {
  it("is the first one where none is stored", () => {
    expect(addTrustedAddress(null, home)).toEqual({
      value: stored(home),
      addresses: [home],
    });
    expect(addTrustedAddress(undefined, home).addresses).toEqual([home]);
  });

  it("joins those already there, once", () => {
    expect(addTrustedAddress(stored(home), tunnel)).toEqual({
      value: stored(home, tunnel),
      addresses: [home, tunnel],
    });
    expect(addTrustedAddress(stored(home, tunnel), home).addresses).toEqual([home, tunnel]);
    // A list stored with a repeat is written back without it.
    expect(addTrustedAddress(stored(home, home), tunnel).value).toEqual(stored(home, tunnel));
  });

  it("leaves what it cannot read as it is, and says so", () => {
    for (const unreadable of [
      { version: 2, addresses: [home] },
      { version: 1, addresses: [] },
      { version: 1, addresses: ["http://192.168.1.20:8543/"] },
      { version: 1, addresses: [home, 7] },
      "text",
      [home],
    ]) {
      expect(addTrustedAddress(unreadable, tunnel)).toEqual({ value: unreadable, addresses: null });
    }
  });

  it("refuses an address not written as one, and changes nothing", () => {
    for (const address of [`${home}/`, "ftp://192.168.1.20", "http://a@b.example", "not a url"]) {
      expect(addTrustedAddress(stored(home), address)).toEqual({
        value: stored(home),
        addresses: null,
      });
    }
    expect(addTrustedAddress(null, "not a url")).toEqual({ value: null, addresses: null });
  });
});

describe("reading the addresses", () => {
  it("gives each once, or null for anything but a list of them", () => {
    expect(readTrustedAddresses(stored(home, tunnel, home))).toEqual([home, tunnel]);
    expect(readTrustedAddresses(null)).toBeNull();
    expect(readTrustedAddresses({ version: 1 })).toBeNull();
  });

  it("keeps protocol, port and path, which can each name another server", () => {
    expect(normalizeWorkspaceAddress("http://192.168.1.20:8543/")).toBe(home);
    expect(normalizeWorkspaceAddress("https://chat.example/team/")).toBe(
      "https://chat.example/team",
    );
    expect(() => normalizeWorkspaceAddress("http://chat.example/?a=1")).toThrow();
  });
});
