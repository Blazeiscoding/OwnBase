import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { encode } from "uqr";
import type { Invite } from "@slackoss/protocol";
import {
  describeExpiry,
  describeUses,
  onlyOnItsNetwork,
  reusableInvite,
} from "../src/lib/invites.js";
import { QrCode } from "../src/components/QrCode.js";

/**
 * Which invite the dialog shows again instead of making another (UX-43), how
 * it says how long one lasts and how many it lets in, and its QR code.
 */
const NOW = Date.UTC(2026, 9, 15, 12, 0);
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const invite = (over: Partial<Invite>): Invite => ({
  code: "CODE",
  createdBy: "U_ME",
  createdAt: 0,
  expiresAt: NOW + 7 * DAY,
  maxUses: null,
  uses: 0,
  status: "active",
  ...over,
});

describe("the invite shown again", () => {
  it("is the newest of this person's that works like a new one", () => {
    const older = invite({ code: "OLDER", createdAt: 1 });
    const newer = invite({ code: "NEWER", createdAt: 2, expiresAt: null });
    expect(reusableInvite([older, newer], "U_ME", NOW)?.code).toBe("NEWER");
  });

  it("is never someone else's, a limited one, one ending within a day, or one that stopped working", () => {
    const candidates = [
      invite({ code: "THEIRS", createdBy: "U_ALEX", createdAt: 9 }),
      invite({ code: "LIMITED", maxUses: 10, createdAt: 9 }),
      invite({ code: "ENDING", expiresAt: NOW + 23 * HOUR, createdAt: 9 }),
      invite({ code: "REVOKED", status: "revoked", revokedAt: NOW - 1, createdAt: 9 }),
      invite({ code: "EXPIRED", status: "expired", createdAt: 9 }),
      invite({ code: "BLOCKED", status: "creator_not_permitted", createdAt: 9 }),
    ];
    expect(reusableInvite(candidates, "U_ME", NOW)).toBeNull();
    expect(reusableInvite([...candidates, invite({ code: "FINE" })], "U_ME", NOW)?.code).toBe(
      "FINE",
    );
  });

  it("counts one from an older server, without a status, as working", () => {
    const { status: _gone, ...old } = invite({ code: "OLD" });
    expect(reusableInvite([old], "U_ME", NOW)?.code).toBe("OLD");
  });
});

describe("how long an invite lasts", () => {
  it("is said in the largest unit, rounded up", () => {
    expect(describeExpiry(null, NOW)).toBe("Never expires");
    expect(describeExpiry(NOW + 7 * DAY - 5, NOW)).toBe("Expires in 7 days");
    expect(describeExpiry(NOW + DAY - 5, NOW)).toBe("Expires in 1 day");
    expect(describeExpiry(NOW + 25 * HOUR, NOW)).toBe("Expires in 2 days");
    expect(describeExpiry(NOW + 3 * HOUR, NOW)).toBe("Expires in 3 hours");
    expect(describeExpiry(NOW + HOUR - 5, NOW)).toBe("Expires in 1 hour");
    expect(describeExpiry(NOW + 90_000, NOW)).toBe("Expires in 2 minutes");
    expect(describeExpiry(NOW + 1, NOW)).toBe("Expires in 1 minute");
    expect(describeExpiry(NOW, NOW)).toBe("Expired");
  });

  it("says how many it still lets in", () => {
    expect(describeUses(null, 12)).toBe("Any number of people");
    expect(describeUses(5, 2)).toBe("3 of 5 uses left");
    expect(describeUses(1, 0)).toBe("1 of 1 use left");
    expect(describeUses(3, 7)).toBe("0 of 3 uses left");
  });
});

describe("an address that only its own network reaches", () => {
  it("is a private, link-local or Tailscale address, or a .local name", () => {
    for (const url of [
      "http://10.0.0.7:8543",
      "http://192.168.1.20:8543",
      "http://172.16.0.4",
      "http://172.31.255.1",
      "http://169.254.10.10",
      "http://100.101.102.103:8543",
      "http://studio.local:8543",
      "http://[fd12:3456::1]:8543",
      "http://[fe80::1]:8543",
    ])
      expect(onlyOnItsNetwork(url), url).toBe(true);
  });

  it("is not a public address or name, even one that starts like a private one", () => {
    for (const url of [
      "https://chat.team.dev",
      "http://172.32.0.1",
      "http://100.128.0.1",
      "http://203.0.113.5:8543",
      "https://fc-barcelona.example",
      "https://fdroid.example",
      "http://[2001:db8::1]",
      "not a url",
    ])
      expect(onlyOnItsNetwork(url), url).toBe(false);
  });
});

describe("a QR code", () => {
  it("draws every dark module of the link's code, inside a quiet zone, dark on white", () => {
    const link = "http://192.168.1.20:8543/#/join/ABCD1234";
    const { container } = render(<QrCode value={link} label="QR code for the invite link" />);
    const svg = container.querySelector("svg")!;
    const { data, size } = encode(link, { ecc: "M", border: 0 });
    expect(svg.getAttribute("viewBox")).toBe(`-4 -4 ${size + 8} ${size + 8}`);
    expect(svg.querySelector("rect")!.getAttribute("fill")).toBe("#fff");
    const path = svg.querySelector("path")!;
    expect(path.getAttribute("fill")).toBe("#000");
    const drawn = path.getAttribute("d")!.match(/M\d+ \d+/g)!;
    expect(drawn).toHaveLength(data.flat().filter(Boolean).length);
    expect(drawn).toContain(`M0 0`); // a finder pattern's corner
  });
});
