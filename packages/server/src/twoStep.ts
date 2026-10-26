import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Two-step sign-in (E11): time-based codes from an authenticator app, as RFC
 * 6238 has them (HMAC-SHA1, six digits, thirty-second steps), and recovery
 * codes for when the app is gone. Made with node:crypto alone, as everything
 * on this server is.
 */

/** How long one code lasts, in seconds. */
export const TWO_STEP_PERIOD = 30;
/** How many digits a code has. */
export const TWO_STEP_DIGITS = 6;
/** How many recovery codes a set holds. */
export const RECOVERY_CODES = 10;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Bytes as RFC 4648 base32, without padding, as authenticator apps take a key. */
export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** A base32 key back as bytes; spaces, case and padding do not matter. */
export function fromBase32(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret for an authenticator app: twenty random bytes, in base32. */
export function newTwoStepSecret(): string {
  return base32(randomBytes(20));
}

/** The time step a moment falls in. */
export function stepAt(now: number): number {
  return Math.floor(now / 1000 / TWO_STEP_PERIOD);
}

/** The code for one time step (RFC 4226's truncation), `digits` long. */
export function codeFor(secret: string, step: number, digits = TWO_STEP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", fromBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  const number = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(number % 10 ** digits).padStart(digits, "0");
}

/**
 * The step a code answers, if it is right for now or one step either side,
 * which allows for a clock a little out and a code typed as it changes; null
 * otherwise. A step at or before `after`, the last one accepted, is refused,
 * so a code seen over someone's shoulder cannot be used again.
 */
export function checkCode(
  secret: string,
  code: string,
  now: number,
  after: number | null,
): number | null {
  const typed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) return null;
  const current = stepAt(now);
  for (const step of [current - 1, current, current + 1]) {
    if (after !== null && step <= after) continue;
    if (timingSafeEqual(Buffer.from(codeFor(secret, step)), Buffer.from(typed))) return step;
  }
  return null;
}

/**
 * What an authenticator app scans: the key, and the names it shows the code
 * under, the workspace and the handle.
 */
export function otpauthUri(secret: string, workspace: string, handle: string): string {
  const issuer = `${workspace} on OwnBase`;
  const label = encodeURIComponent(`${issuer}:${handle}`);
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TWO_STEP_DIGITS),
    period: String(TWO_STEP_PERIOD),
  });
  return `otpauth://totp/${label}?${query.toString().replace(/\+/g, "%20")}`;
}

/** Letters and digits nobody reads as another: no 0, o, 1, l or i. */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** A set of recovery codes, each like "k7mq-3hxv". */
export function newRecoveryCodes(): string[] {
  const one = () =>
    Array.from({ length: 8 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join(
      "",
    );
  return Array.from({ length: RECOVERY_CODES }, () => {
    const code = one();
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  });
}

/** A recovery code as typed, made comparable: case, spaces and the dash do not matter. */
export function normalRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, "");
}
