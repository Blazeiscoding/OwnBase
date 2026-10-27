import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  featuresOn,
  GRACE_MS,
  LICENSE_PREFIX,
  publicKeyFrom,
  readLicense,
  type LicenseClaims,
} from "../src/license.js";

/**
 * Enterprise licenses (P6): good ones are read, and a changed one, one signed
 * by another key, or one that is not a license at all is refused with a
 * reason. One that has ended keeps its features for 14 days, then not.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 27, 12);

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, raw: publicKey.export({ format: "jwk" }).x! };
}

const claims = (over: Partial<LicenseClaims> = {}): LicenseClaims => ({
  id: "lic-1",
  licensee: "Acme Ltd",
  plan: "enterprise",
  members: 200,
  features: ["sso", "scim"],
  issuedAt: NOW - 30 * DAY,
  expiresAt: NOW + 335 * DAY,
  ...over,
});

function issue(privateKey: KeyObject, body: unknown): string {
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  const signature = sign(null, Buffer.from(`${LICENSE_PREFIX}.${payload}`), privateKey);
  return `${LICENSE_PREFIX}.${payload}.${signature.toString("base64url")}`;
}

const ours = keyPair();
const trusted = [ours.publicKey];

describe("reading a license", () => {
  it("accepts one this build's key signed, and turns on its features", () => {
    const license = readLicense(issue(ours.privateKey, claims()), trusted, NOW);
    expect(license).toEqual({ state: "active", claims: claims() });
    expect([...featuresOn(license)]).toEqual(["sso", "scim"]);
    // Whitespace around it, as a file saved by an editor has, changes nothing.
    expect(readLicense(`\n ${issue(ours.privateKey, claims())} \r\n`, trusted, NOW).state).toBe(
      "active",
    );
    // Any of several trusted keys will do: an older one keeps its licenses good.
    expect(
      readLicense(issue(ours.privateKey, claims()), [keyPair().publicKey, ours.publicKey], NOW)
        .state,
    ).toBe("active");
  });

  it("refuses one changed after it was signed", () => {
    const good = issue(ours.privateKey, claims());
    const [prefix, , signature] = good.split(".");
    const more = Buffer.from(JSON.stringify(claims({ members: 5000 }))).toString("base64url");
    expect(readLicense(`${prefix}.${more}.${signature}`, trusted, NOW)).toEqual({
      state: "invalid",
      reason: "This license was not issued by OwnBase, or was changed after it was.",
    });
    const flipped = signature!.slice(0, -2) + (signature!.endsWith("AA") ? "BA" : "AA");
    expect(readLicense(`${prefix}.${good.split(".")[1]}.${flipped}`, trusted, NOW).state).toBe(
      "invalid",
    );
  });

  it("refuses one signed by a key this build does not trust", () => {
    const theirs = keyPair();
    expect(readLicense(issue(theirs.privateKey, claims()), trusted, NOW)).toMatchObject({
      state: "invalid",
      reason: "This license was not issued by OwnBase, or was changed after it was.",
    });
    expect(readLicense(issue(ours.privateKey, claims()), [], NOW)).toEqual({
      state: "invalid",
      reason: "This build of OwnBase trusts no license key yet.",
    });
  });

  it("keeps an ended license's features for 14 days, then turns them off", () => {
    const ended = issue(ours.privateKey, claims({ expiresAt: NOW - DAY }));
    const grace = readLicense(ended, trusted, NOW);
    expect(grace).toEqual({
      state: "grace",
      claims: claims({ expiresAt: NOW - DAY }),
      graceEndsAt: NOW - DAY + GRACE_MS,
    });
    expect([...featuresOn(grace)]).toEqual(["sso", "scim"]);
    expect(readLicense(ended, trusted, NOW - DAY + GRACE_MS - 1).state).toBe("grace");
    const expired = readLicense(ended, trusted, NOW - DAY + GRACE_MS);
    expect(expired.state).toBe("expired");
    expect([...featuresOn(expired)]).toEqual([]);
    // Active up to the last millisecond.
    expect(readLicense(ended, trusted, NOW - DAY - 1).state).toBe("active");
  });

  it("says there is none for nothing, and refuses what is not a license", () => {
    for (const nothing of [null, undefined, "", "  \n"])
      expect(readLicense(nothing, trusted, NOW)).toEqual({ state: "none" });
    const good = issue(ours.privateKey, claims());
    const [, payload, signature] = good.split(".");
    const reasons = (text: string) => {
      const license = readLicense(text, trusted, NOW);
      return license.state === "invalid" ? license.reason : license.state;
    };
    expect(reasons("hello")).toBe("This is not an OwnBase license.");
    expect(reasons(`OWNBASE-LICENSE-2.${payload}.${signature}`)).toBe(
      "This is not an OwnBase license.",
    );
    expect(reasons(`${LICENSE_PREFIX}.${payload}`)).toBe("This is not an OwnBase license.");
    expect(reasons(`${LICENSE_PREFIX}.${payload}.${signature}.more`)).toBe(
      "This is not an OwnBase license.",
    );
    expect(reasons(`${LICENSE_PREFIX}.${payload}.not base64!`)).toBe("This license is damaged.");
    expect(reasons(`${LICENSE_PREFIX}..${signature}`)).toBe("This license is damaged.");
    // Signed, but not JSON, or JSON without what a license covers.
    expect(reasons(signedText(Buffer.from("not json").toString("base64url")))).toBe(
      "This license is damaged.",
    );
    for (const missing of [
      { ...claims(), members: 0 },
      { ...claims(), members: 2.5 },
      { ...claims(), licensee: " " },
      { ...claims(), features: "sso" },
      { ...claims(), features: [""] },
      { ...claims(), expiresAt: claims().issuedAt },
      (({ id, ...rest }) => rest)(claims()),
    ])
      expect(reasons(issue(ours.privateKey, missing))).toBe(
        "This license is missing what it covers.",
      );
  });

  it("does not believe one dated well ahead of the server's clock", () => {
    const ahead = issue(
      ours.privateKey,
      claims({ issuedAt: NOW + 2 * DAY, expiresAt: NOW + 400 * DAY }),
    );
    expect(readLicense(ahead, trusted, NOW)).toEqual({
      state: "invalid",
      reason: "This license is dated in the future. Check this computer's clock.",
    });
    // A clock a few hours out still reads it.
    const soon = issue(ours.privateKey, claims({ issuedAt: NOW + 3 * 60 * 60 * 1000 }));
    expect(readLicense(soon, trusted, NOW).state).toBe("active");
  });
});

function signedText(payload: string): string {
  const signature = sign(null, Buffer.from(`${LICENSE_PREFIX}.${payload}`), ours.privateKey);
  return `${LICENSE_PREFIX}.${payload}.${signature.toString("base64url")}`;
}

describe("ee/scripts/license.mjs", () => {
  const script = fileURLToPath(new URL("../scripts/license.mjs", import.meta.url));
  let folder: string | undefined;
  /** Where keygen must refuse to write; removed in case a broken guard let it. */
  const inRepo = fileURLToPath(new URL("../never-here.pem", import.meta.url));
  afterEach(() => {
    if (folder) rmSync(folder, { recursive: true, force: true });
    folder = undefined;
    rmSync(inRepo, { force: true });
  });
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: "pipe" });

  it("makes a key pair and issues a license the server accepts", () => {
    folder = mkdtempSync(join(tmpdir(), "ownbase-license-"));
    const key = join(folder, "signing.pem");
    const made = run("keygen", "--private", key);
    const publicRaw = /"([A-Za-z0-9_-]{43})",/.exec(made)?.[1];
    expect(publicRaw).toBeDefined();
    const out = join(folder, "acme.license");
    run(
      "issue",
      "--private",
      key,
      "--licensee",
      "Acme Ltd",
      "--members",
      "200",
      "--days",
      "365",
      "--features",
      "sso, scim",
      "--id",
      "lic-acme",
      "--out",
      out,
    );
    const license = readLicense(readFileSync(out, "utf8"), [publicKeyFrom(publicRaw!)]);
    expect(license).toMatchObject({
      state: "active",
      claims: {
        id: "lic-acme",
        licensee: "Acme Ltd",
        plan: "enterprise",
        members: 200,
        features: ["sso", "scim"],
      },
    });
    expect(run("inspect", out)).toContain('"licensee": "Acme Ltd"');
    // A key is never overwritten, and never written into the repository.
    expect(() => run("keygen", "--private", key)).toThrow(/already exists/);
    expect(() => run("keygen", "--private", inRepo)).toThrow(/inside the repository/);
  });
});
