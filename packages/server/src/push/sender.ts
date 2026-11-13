import type { FastifyBaseLogger } from "fastify";
import type { PushSubscription } from "./store.js";
import { encryptPush, vapidAuthorization, type VapidKeys } from "./webPush.js";

/** Bounds on pushing to closed browsers (G09). */
export interface PushLimits {
  /** People one message pushes to at most; a big channel set to everything stops there. */
  recipientsPerMessage: number;
  /** One push per person per conversation in this long; the next message waits for the gap. */
  gapMs: number;
  /** Pushes waiting to go. Past it the oldest is dropped: a late push is worth less. */
  queue: number;
  /** Requests to push services at once. */
  concurrency: number;
  /** How long one request may take. */
  timeoutMs: number;
  /** Tries again after a 429 or 5xx, each wait four times the one before. */
  retries: number;
  retryBaseMs: number;
}

export const PUSH_LIMITS: PushLimits = {
  recipientsPerMessage: 250,
  gapMs: 5_000,
  queue: 2_000,
  concurrency: 16,
  timeoutMs: 10_000,
  retries: 3,
  retryBaseMs: 2_000,
};

/** How long a push service keeps a push for a browser that is offline: a day. */
const TTL_SECONDS = 24 * 60 * 60;
/** Longest wait a push service's Retry-After is followed for. */
const RETRY_AFTER_MAX_MS = 60_000;
/** A signed token is reused for this long per push service, well inside its 12 hours. */
const TOKEN_REUSE_MS = 60 * 60_000;

export type PostPush = (
  url: string,
  body: Buffer,
  headers: Record<string, string>,
) => Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>;

interface Job {
  subscription: PushSubscription;
  payload: string;
  urgency: "normal" | "high";
  tries: number;
}

export interface PushCounts {
  sent: number;
  failed: number;
  dropped: number;
}

/**
 * Sends pushes off the request path: a bounded queue, a few requests at a
 * time, each through the outbound guard with a deadline. A push service's
 * 404 or 410 means the browser unsubscribed, so its subscription is deleted;
 * 429 and 5xx are tried again a few times, then given up.
 */
export class PushSender {
  private readonly waiting: Job[] = [];
  private running = 0;
  private readonly retrying = new Set<ReturnType<typeof setTimeout>>();
  private readonly tokens = new Map<string, { header: string; madeAt: number }>();
  private idle: (() => void)[] = [];
  private closed = false;
  readonly counts: PushCounts = { sent: 0, failed: 0, dropped: 0 };

  constructor(
    private readonly deps: {
      post: PostPush;
      keys: () => VapidKeys;
      /** Who runs this server, for the push service (RFC 8292 "sub"). */
      subject: string;
      limits: PushLimits;
      log: FastifyBaseLogger;
      /** The push service no longer knows this browser. */
      gone: (endpoint: string) => void;
    },
  ) {}

  send(subscription: PushSubscription, payload: string, urgency: Job["urgency"] = "normal"): void {
    if (this.closed) return;
    this.waiting.push({ subscription, payload, urgency, tries: 0 });
    while (this.waiting.length > this.deps.limits.queue) {
      this.waiting.shift();
      this.counts.dropped++;
    }
    this.pump();
  }

  /** Resolves once nothing is waiting, sending or waiting to be tried again. */
  settled(): Promise<void> {
    if (this.quiet()) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  close(): void {
    this.closed = true;
    for (const timer of this.retrying) clearTimeout(timer);
    this.retrying.clear();
    this.counts.dropped += this.waiting.length;
    this.waiting.length = 0;
    this.wake();
  }

  private quiet(): boolean {
    return this.waiting.length === 0 && this.running === 0 && this.retrying.size === 0;
  }

  private wake(): void {
    if (!this.quiet()) return;
    const idle = this.idle;
    this.idle = [];
    for (const resolve of idle) resolve();
  }

  private pump(): void {
    while (!this.closed && this.running < this.deps.limits.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.running++;
      void this.attempt(job).finally(() => {
        this.running--;
        this.pump();
        this.wake();
      });
    }
  }

  private authorization(endpoint: string): string {
    const origin = new URL(endpoint).origin;
    const now = Date.now();
    const kept = this.tokens.get(origin);
    if (kept && now - kept.madeAt < TOKEN_REUSE_MS) return kept.header;
    const header = vapidAuthorization(endpoint, this.deps.keys(), this.deps.subject, now);
    this.tokens.set(origin, { header, madeAt: now });
    return header;
  }

  private async attempt(job: Job): Promise<void> {
    const { endpoint } = job.subscription;
    let status: number;
    let retryAfter: string | string[] | undefined;
    try {
      const body = encryptPush(Buffer.from(job.payload), job.subscription);
      const res = await this.deps.post(endpoint, body, {
        "content-type": "application/octet-stream",
        "content-encoding": "aes128gcm",
        ttl: String(TTL_SECONDS),
        urgency: job.urgency,
        authorization: this.authorization(endpoint),
      });
      status = res.status;
      retryAfter = res.headers["retry-after"];
    } catch (err) {
      // Unreachable, timed out or refused by the guard: tried again like a 5xx,
      // except when the server is stopping.
      if (this.closed) return;
      this.deps.log.warn({ err, host: hostOf(endpoint) }, "could not reach a push service");
      status = 0;
    }
    if (status >= 200 && status < 300) {
      this.counts.sent++;
      return;
    }
    if (status === 404 || status === 410) {
      this.counts.failed++;
      this.deps.gone(endpoint);
      return;
    }
    if ((status === 0 || status === 429 || status >= 500) && job.tries < this.deps.limits.retries) {
      const wait = Math.max(
        this.deps.limits.retryBaseMs * 4 ** job.tries,
        Math.min(retryAfterMs(retryAfter), RETRY_AFTER_MAX_MS),
      );
      const timer = setTimeout(() => {
        this.retrying.delete(timer);
        if (this.closed) return;
        this.waiting.push({ ...job, tries: job.tries + 1 });
        this.pump();
        this.wake();
      }, wait);
      timer.unref?.();
      this.retrying.add(timer);
      return;
    }
    this.counts.failed++;
    if (status !== 0)
      this.deps.log.warn({ status, host: hostOf(endpoint) }, "a push service refused a push");
  }
}

/** The push service's host, for a log line: the rest of the address names the browser. */
const hostOf = (endpoint: string) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return "";
  }
};

function retryAfterMs(value: string | string[] | undefined): number {
  const text = Array.isArray(value) ? value[0] : value;
  if (!text) return 0;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(text);
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now());
}
