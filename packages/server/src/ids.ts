import { randomBytes } from "node:crypto";

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The 10-char Crockford-base32 timestamp a ULID starts with. */
function timePart(now: number): string {
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ENC[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  return ts;
}

/** Sixteen random base32 digits, as numbers. */
function randomDigits(): number[] {
  return Array.from(randomBytes(16), (byte) => byte % 32);
}

const encode = (digits: number[]): string => digits.map((digit) => ENC[digit]).join("");

/** Compact ULID: 10-char Crockford-base32 timestamp + 16 random chars. Lexicographically time-sortable. */
export function ulid(now = Date.now()): string {
  return timePart(now) + encode(randomDigits());
}

let lastOrdered: { now: number; digits: number[] } | null = null;

/**
 * A ULID for what is kept in the order it was made, as messages are: clients
 * and paging both order them by id. Two made in the same millisecond would
 * otherwise sort by their random halves, either way round. Here the second
 * takes the first's random half plus one, so they sort as they were made.
 *
 * Not for anything that has to be hard to guess: within a millisecond, the
 * next one is this one plus one.
 */
export function orderedUlid(now = Date.now()): string {
  let digits = randomDigits();
  if (lastOrdered?.now === now) {
    const next = [...lastOrdered.digits];
    let place = next.length - 1;
    while (place >= 0 && next[place] === 31) next[place--] = 0;
    // Counted past the last value there is: one in 2^80, and then a fresh draw.
    if (place >= 0) {
      next[place]! += 1;
      digits = next;
    }
  }
  lastOrdered = { now, digits };
  return timePart(now) + encode(digits);
}

export function inviteCode(): string {
  const rand = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ENC[rand[i]! % 32];
  return out;
}

/** Long random secret for bot tokens and webhook URLs. */
export function secretToken(prefix = ""): string {
  return prefix + randomBytes(24).toString("hex");
}
