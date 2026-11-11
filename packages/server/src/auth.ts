import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { HttpError } from "./httpError.js";

/**
 * How many password derivations this process runs at once. Each scrypt job
 * takes substantial memory; past this a sign-in is refused with auth_busy
 * rather than queued, so one burst cannot exhaust the machine.
 */
const DERIVATIONS_AT_ONCE = 2;
let deriving = 0;

async function derive(password: string, salt: string): Promise<Buffer> {
  if (deriving >= DERIVATIONS_AT_ONCE)
    throw new HttpError(
      429,
      "auth_busy",
      "The workspace is handling other sign-ins. Try again in a moment.",
    );
  deriving++;
  try {
    // Off the event loop, so calls and chat stay responsive meanwhile.
    return await new Promise((resolve, reject) => {
      scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
    });
  } finally {
    deriving--;
  }
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await derive(password, salt)).toString("hex");
  return { hash, salt };
}

export async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
): Promise<boolean> {
  const actual = await derive(password, salt);
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
