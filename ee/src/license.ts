import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * OwnBase Enterprise licenses (P6): one line of text, checked offline.
 *
 *   OWNBASE-LICENSE-1.<claims>.<signature>
 *
 * The claims are JSON in base64url; the signature is Ed25519, in base64url,
 * over everything before the last dot. Only a key in `TRUSTED_LICENSE_KEYS`
 * (keys.ts) makes a license good, so a license cannot be made without the
 * private key, which never leaves its keeper. ee/scripts/license.mjs makes
 * keys and issues licenses in the same format.
 */
export const LICENSE_PREFIX = "OWNBASE-LICENSE-1";

/** How long Enterprise features keep working after a license's end. */
export const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
/** A license dated this far ahead of the server's clock is not believed. */
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** What a license says. */
export interface LicenseClaims {
  /** Tells licenses apart, for whoever issued them. */
  id: string;
  /** Who it is for, as the notices and the status name them. */
  licensee: string;
  plan: string;
  /** Members it covers. Past it the owner is told; nobody is locked out. */
  members: number;
  /** The Enterprise features it turns on, such as "sso" or "scim". */
  features: string[];
  issuedAt: number;
  expiresAt: number;
}

export type LicenseState =
  | { state: "none" }
  | { state: "invalid"; reason: string }
  | { state: "active"; claims: LicenseClaims }
  /** Past its end, its features still on until `graceEndsAt`. */
  | { state: "grace"; claims: LicenseClaims; graceEndsAt: number }
  | { state: "expired"; claims: LicenseClaims };

/** A public key from its base64url raw form, as keys.ts and license.mjs write it. */
export function publicKeyFrom(raw: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw }, format: "jwk" });
}

function invalid(reason: string): LicenseState {
  return { state: "invalid", reason };
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** The claims, if `value` has every field a license needs, as it needs them. */
function claimsFrom(value: unknown): LicenseClaims | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (!isText(c.id, 100) || !isText(c.licensee, 200) || !isText(c.plan, 40)) return null;
  if (typeof c.members !== "number" || !Number.isSafeInteger(c.members) || c.members < 1)
    return null;
  if (!Array.isArray(c.features) || !c.features.every((feature) => isText(feature, 40)))
    return null;
  if (!isTime(c.issuedAt) || !isTime(c.expiresAt) || c.expiresAt <= c.issuedAt) return null;
  return {
    id: c.id,
    licensee: c.licensee,
    plan: c.plan,
    members: c.members,
    features: [...(c.features as string[])],
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
  };
}

/**
 * Reads a license and says where it stands at `now`. Never throws: a license
 * that is not one is `invalid`, with the reason in words for its owner.
 */
export function readLicense(
  text: string | null | undefined,
  trusted: readonly KeyObject[],
  now = Date.now(),
): LicenseState {
  if (text === null || text === undefined || text.trim() === "") return { state: "none" };
  const parts = text.trim().split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX)
    return invalid("This is not an OwnBase license.");
  const [, payload, signature] = parts as [string, string, string];
  const base64url = /^[A-Za-z0-9_-]+$/;
  if (!base64url.test(payload) || !base64url.test(signature))
    return invalid("This license is damaged.");
  const signed = Buffer.from(`${LICENSE_PREFIX}.${payload}`, "utf8");
  const bytes = Buffer.from(signature, "base64url");
  if (!trusted.some((key) => bytes.length === 64 && verify(null, signed, key, bytes)))
    return invalid(
      trusted.length === 0
        ? "This build of OwnBase trusts no license key yet."
        : "This license was not issued by OwnBase, or was changed after it was.",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return invalid("This license is damaged.");
  }
  const claims = claimsFrom(parsed);
  if (!claims) return invalid("This license is missing what it covers.");
  if (claims.issuedAt > now + CLOCK_SKEW_MS)
    return invalid("This license is dated in the future. Check this computer's clock.");
  if (now < claims.expiresAt) return { state: "active", claims };
  const graceEndsAt = claims.expiresAt + GRACE_MS;
  if (now < graceEndsAt) return { state: "grace", claims, graceEndsAt };
  return { state: "expired", claims };
}

/** The Enterprise features on at this moment: a license's, while it is active or in grace. */
export function featuresOn(license: LicenseState): ReadonlySet<string> {
  return license.state === "active" || license.state === "grace"
    ? new Set(license.claims.features)
    : new Set();
}
