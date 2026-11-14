import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { HttpError } from "./httpError.js";

/** scrypt's parameters: N is 2^ln, r the block size, p the parallelization. */
export interface PasswordCost {
  ln: number;
  r: number;
  p: number;
}

/**
 * OWASP's password storage cheat sheet lists N=2^16, r=8, p=2 as equal to
 * its N=2^17, r=8, p=1. Node runs p in turn, so this takes the same time but
 * half the memory (64 MiB), which matters on a small machine signing two
 * people in at once.
 */
export const DEFAULT_PASSWORD_COST: PasswordCost = { ln: 16, r: 8, p: 2 };

/** What made a hash stored without its parameters: Node's defaults. */
const BARE_HASH_COST: PasswordCost = { ln: 14, r: 8, p: 1 };

const KEY_LENGTH = 64;
const PREFIX = "$scrypt$";

/**
 * The most a stored hash may ask of this machine: 256 MiB and about twice
 * the default's work. Whoever can write the users table cannot make a
 * sign-in allocate more than that.
 */
function withinBounds({ ln, r, p }: PasswordCost): boolean {
  const n = 2 ** ln;
  return (
    Number.isInteger(ln) &&
    Number.isInteger(r) &&
    Number.isInteger(p) &&
    ln >= 1 &&
    ln <= 20 &&
    r >= 1 &&
    r <= 32 &&
    p >= 1 &&
    p <= 16 &&
    n * r <= 2 ** 21 &&
    n * r * p <= 2 ** 22
  );
}

function parseCost(text: string): PasswordCost | null {
  const match = /^ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})$/.exec(text);
  if (!match) return null;
  const cost = { ln: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  return withinBounds(cost) ? cost : null;
}

const formatCost = ({ ln, r, p }: PasswordCost) => `ln=${ln},r=${r},p=${p}`;

let configured: PasswordCost | undefined;

/**
 * The cost new hashes are made at. OWNBASE_PASSWORD_COST (`ln=17,r=8,p=1`)
 * replaces the default for the whole process: a host raises it, and test
 * runs lower it so that thousands of sign-ins stay quick.
 */
export function passwordCost(): PasswordCost {
  if (!configured) {
    const text = process.env.OWNBASE_PASSWORD_COST;
    const parsed = text ? parseCost(text) : DEFAULT_PASSWORD_COST;
    if (!parsed)
      throw new Error(
        "OWNBASE_PASSWORD_COST must look like ln=16,r=8,p=2, with N=2^ln at most 2^20 and memory at most 256 MiB.",
      );
    configured = parsed;
  }
  return configured;
}

/** The cost and key a stored value names, or null for one nothing can match. */
function parseStored(stored: string): { cost: PasswordCost; key: Buffer } | null {
  if (stored.startsWith(PREFIX)) {
    const [cost, key, ...rest] = stored.slice(PREFIX.length).split("$");
    const parsed = parseCost(cost ?? "");
    if (!parsed || rest.length || !/^[0-9a-f]{128}$/.test(key ?? "")) return null;
    return { cost: parsed, key: Buffer.from(key!, "hex") };
  }
  if (!/^[0-9a-f]{128}$/.test(stored)) return null;
  return { cost: BARE_HASH_COST, key: Buffer.from(stored, "hex") };
}

/**
 * How many password derivations this process runs at once. Each scrypt job
 * takes substantial memory; past this a sign-in is refused with auth_busy
 * rather than queued, so one burst cannot exhaust the machine.
 */
const DERIVATIONS_AT_ONCE = 2;
let deriving = 0;

async function derive(password: string, salt: string, cost: PasswordCost): Promise<Buffer> {
  if (deriving >= DERIVATIONS_AT_ONCE)
    throw new HttpError(
      429,
      "auth_busy",
      "The workspace is handling other sign-ins. Try again in a moment.",
    );
  deriving++;
  try {
    const { ln, r, p } = cost;
    const N = 2 ** ln;
    // Node refuses a job needing more than maxmem (32 MiB unless given); this
    // is exactly what it needs.
    const maxmem = 128 * r * (N + p + 2);
    // Off the event loop, so calls and chat stay responsive meanwhile.
    return await new Promise((resolve, reject) => {
      scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem }, (err, key) =>
        err ? reject(err) : resolve(key),
      );
    });
  } finally {
    deriving--;
  }
}

/**
 * A new salt and the hash to store, which names the cost that made it so the
 * cost can be raised later without anyone resetting a password.
 */
export async function hashPassword(
  password: string,
  cost: PasswordCost = passwordCost(),
): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt, cost);
  return { hash: `${PREFIX}${formatCost(cost)}$${key.toString("hex")}`, salt };
}

/**
 * Whether `password` made `storedHash`, at whatever cost the stored value
 * names. A value that names no cost was made at Node's defaults. One that
 * cannot be read, or asks too much, matches nothing.
 */
export async function verifyPassword(
  password: string,
  salt: string,
  storedHash: string,
): Promise<boolean> {
  const stored = parseStored(storedHash);
  if (!stored) return false;
  const actual = await derive(password, salt, stored.cost);
  return actual.length === stored.key.length && timingSafeEqual(actual, stored.key);
}

/** Whether a stored hash was made at a cost other than today's, so is worth making again. */
export function needsRehash(storedHash: string): boolean {
  const stored = parseStored(storedHash);
  if (!stored) return false;
  return formatCost(stored.cost) !== formatCost(passwordCost());
}

export function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
