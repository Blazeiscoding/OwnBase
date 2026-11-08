/**
 * Loads one thing at a time for a list that has to stay current (REV-05).
 * A change to what is asked for, or someone asking, loads at once and drops
 * whatever was in flight. A sign that what is shown may be out of date only
 * asks for a load: it waits a moment, so a burst of them is one load, and
 * while a load is running, every such sign is one more load after it, so at
 * most one runs and one waits. The list keeps showing what it has meanwhile.
 */
export class CoalescedLoader {
  private controller: AbortController | null = null;
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly load: (signal: AbortSignal) => Promise<unknown>,
    private readonly delayMs: number,
  ) {}

  /** What is asked for changed, or someone asked: load now, dropping what was in flight. */
  now(): void {
    this.clearTimer();
    this.queued = false;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    void this.load(controller.signal)
      .catch(() => {})
      .finally(() => {
        if (this.controller !== controller) return;
        this.controller = null;
        if (this.queued) this.now();
      });
  }

  /** What is shown may be out of date: load again soon, once, however often this is said. */
  soon(): void {
    if (this.controller) {
      this.queued = true;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.now();
    }, this.delayMs);
  }

  /**
   * Drops what is in flight and what waits. Not for good: a list shown again,
   * as React does when it checks effects, loads again when it asks.
   */
  stop(): void {
    this.clearTimer();
    this.queued = false;
    this.controller?.abort();
    this.controller = null;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
