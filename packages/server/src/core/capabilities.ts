/**
 * The short-lived capabilities handed to apps: a `response_url`, a
 * `trigger_id`, a modal waiting to be submitted (INT-01). They are kept in
 * memory with a lifetime, and rate limits slow how fast they are made, but
 * nothing bounded how many could be alive at once across every person and app
 * over a half-hour lifetime; and each new one swept the whole map for expired
 * ones.
 *
 * Every entry in one map lives the same time, so the oldest is always first.
 * The expired are swept from the front, stopping at the first that is not, and
 * past the ceiling the oldest goes. An app that loses one that way gets the
 * same answer as for one that expired.
 */
export class CapabilityMap<V extends { expiresAt: number }> {
  private readonly entries = new Map<string, V>();

  constructor(readonly ceiling: number) {}

  get size(): number {
    return this.entries.size;
  }

  /** The capability, or undefined when there is none or it has expired. */
  get(key: string, now = Date.now()): V | undefined {
    const value = this.entries.get(key);
    if (value && value.expiresAt < now) {
      this.entries.delete(key);
      return undefined;
    }
    return value;
  }

  set(key: string, value: V, now = Date.now()): void {
    for (const [k, v] of this.entries) {
      if (v.expiresAt >= now) break;
      this.entries.delete(k);
    }
    this.entries.delete(key);
    this.entries.set(key, value);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.ceiling) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}
