import type { Lifecycle } from "./lifecycle.js";

/**
 * One timer set for the soonest of many times something comes due, rather
 * than one per row. Armed again after each round, and whenever the soonest
 * may have changed. A time later than a timer can wait wakes it to wait again.
 */
export class SoonestTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly opts: {
      lifecycle: Lifecycle;
      /** When the soonest comes due, or null when nothing waits. */
      next(): number | null;
      due(): void;
      /** Never armed, such as in an isolated copy. */
      off?: boolean;
    },
  ) {
    opts.lifecycle.onClose(() => this.clear());
  }

  arm(): void {
    this.clear();
    if (this.opts.lifecycle.closing || this.opts.off) return;
    const next = this.opts.next();
    if (next === null) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        if (this.opts.lifecycle.closing) return;
        this.opts.due();
        this.arm();
      },
      Math.min(Math.max(0, next - Date.now()), 2_147_483_647),
    );
    this.timer.unref();
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
