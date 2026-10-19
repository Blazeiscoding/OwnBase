/**
 * How often one caller may do one kind of thing.
 *
 * `burst` is what someone can do at once after sitting idle — opening the app
 * fires a handful of requests together, and a limit that forbade that would be
 * a bug rather than a defence. `perMinute` is the rate it refills at, which is
 * what actually bounds sustained abuse.
 */
export interface LimitRule {
  burst: number;
  perMinute: number;
}

/** Everything this server rations, and what it keys each one on. */
export interface Limits {
  /**
   * Failed sign-in and password attempts against one handle. Tight, because
   * this is the one an attacker repeats: guessing a password is the whole
   * point. Only wrong guesses count, so someone who knows their own password
   * never meets this however often they sign in.
   */
  authByHandle: LimitRule;
  /**
   * Sign-in attempts from one address. Deliberately loose. A workspace on an
   * office LAN reaches the server from a single NAT address, so everyone
   * arriving at nine o'clock shares this budget; tightening it would lock out
   * the whole company to slow one attacker who can simply use another address.
   * The per-handle limit above is what actually protects an account.
   */
  authByAddress: LimitRule;
  /**
   * Messages one account may send. The burst has to cover an outbox emptying
   * itself after someone has been offline, which is a legitimate rush of
   * writes that must not come back as a failed send.
   */
  post: LimitRule;
  /** Uploads one account may start. Generous enough to drop a folder in at once. */
  upload: LimitRule;
  /** Sockets one address may open. Loose, for the same NAT reason. */
  socket: LimitRule;
  /** Typing notices, new huddle joins and call signalling from one account. */
  ephemeral: LimitRule;
  /**
   * Posts to one incoming webhook. Whoever holds its URL can post, with no
   * account behind them, so each webhook has a budget of its own rather than
   * spending a person's or starving the app's other webhooks.
   */
  hook: LimitRule;
  /**
   * Webhook posts from one address, counted before the token is looked up, so
   * guessing tokens costs the same as using one. Loose, for the NAT reason.
   */
  hookByAddress: LimitRule;
  /**
   * Calls out to apps that one account causes: slash commands, buttons and
   * form submissions. Each is a request this server makes on their behalf.
   */
  appCall: LimitRule;
  /**
   * Reads anyone may make without an account, such as the workspace's icon,
   * from one address. Loose, for the NAT reason: each client fetches the
   * icon once and keeps it, so a whole office opening at nine fits.
   */
  publicByAddress: LimitRule;
}

export const DEFAULT_LIMITS: Limits = {
  authByHandle: { burst: 5, perMinute: 5 },
  authByAddress: { burst: 40, perMinute: 60 },
  post: { burst: 60, perMinute: 120 },
  upload: { burst: 20, perMinute: 60 },
  socket: { burst: 30, perMinute: 60 },
  ephemeral: { burst: 60, perMinute: 300 },
  hook: { burst: 30, perMinute: 60 },
  hookByAddress: { burst: 120, perMinute: 240 },
  appCall: { burst: 20, perMinute: 60 },
  publicByAddress: { burst: 120, perMinute: 240 },
};

/**
 * Calls to apps allowed in flight at once. The rate limit bounds how many
 * start; these bound how many a slow app can hold open, per account and per
 * app, so neither one person nor one app ties up this server's connections.
 */
export const APP_CALLS_IN_FLIGHT = { perAccount: 4, perApp: 16 };

/**
 * Capabilities handed to apps that may be alive at once (INT-01). At the
 * `appCall` rate one account can mint 1,800 response urls in their half hour,
 * so it is the number of accounts that left these unbounded. Past a ceiling
 * the oldest goes; an open modal holds its whole form, so fewer of those.
 */
export const CAPABILITIES_ALIVE = { responseUrls: 10_000, triggers: 10_000, openViews: 2_000 };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * A token bucket per caller, held in memory.
 *
 * In memory rather than in the database because the cost of forgetting is one
 * extra burst after a restart, which is not worth a write on every request.
 * A full bucket is indistinguishable from one that never existed, so entries
 * are dropped once they refill and the map stays proportional to who is
 * actually active rather than to everyone who has ever connected.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(readonly limits: Limits = DEFAULT_LIMITS) {}

  /**
   * Spends one unit against `key`, or reports how long until it could succeed.
   * Nothing is spent when the answer is no, so a caller being refused does not
   * push its own recovery further away.
   */
  take(name: keyof Limits, key: string, now = Date.now()): { ok: boolean; retryAfterMs: number } {
    const rule = this.limits[name];
    const id = `${name}:${key}`;
    const refillPerMs = rule.perMinute / 60_000;
    const existing = this.buckets.get(id);
    const tokens = existing
      ? Math.min(rule.burst, existing.tokens + (now - existing.updatedAt) * refillPerMs)
      : rule.burst;

    if (tokens < 1) {
      this.buckets.set(id, { tokens, updatedAt: now });
      return { ok: false, retryAfterMs: Math.ceil((1 - tokens) / refillPerMs) };
    }

    const left = tokens - 1;
    if (left >= rule.burst) this.buckets.delete(id);
    else this.buckets.set(id, { tokens: left, updatedAt: now });
    this.sweep(now);
    return { ok: true, retryAfterMs: 0 };
  }

  /**
   * Wipes what a key has spent. Used when an attempt turns out to have been
   * legitimate after all, which is what keeps a guessing limit off the backs of
   * the people who are not guessing.
   */
  forget(name: keyof Limits, key: string): void {
    this.buckets.delete(`${name}:${key}`);
  }

  /** Live buckets, so a test can prove this does not grow without end. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Drops buckets that have refilled. Only every few seconds: doing it on every
   * request would make each one cost the size of the whole map.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < 10_000) return;
    this.lastSweep = now;
    for (const [id, bucket] of this.buckets) {
      const name = id.slice(0, id.indexOf(":")) as keyof Limits;
      const rule = this.limits[name];
      if (!rule) {
        this.buckets.delete(id);
        continue;
      }
      const tokens = bucket.tokens + (now - bucket.updatedAt) * (rule.perMinute / 60_000);
      if (tokens >= rule.burst) this.buckets.delete(id);
    }
  }
}
