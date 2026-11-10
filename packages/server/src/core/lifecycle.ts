/**
 * Shutdown, as the parts of the server that outlive a single call see it.
 * `closing` stops loops from starting another round; the signal ends outbound
 * calls already under way, so an app slow to answer cannot hold the process
 * open for its whole timeout.
 */
export class Lifecycle {
  private closed = false;
  private readonly shutdown = new AbortController();
  private readonly closers: (() => void)[] = [];
  private readonly drains: (() => Promise<unknown>)[] = [];

  get closing(): boolean {
    return this.closed;
  }

  get signal(): AbortSignal {
    return this.shutdown.signal;
  }

  every(ms: number, work: () => void): void {
    const timer = setInterval(work, ms);
    this.onClose(() => clearInterval(timer));
  }

  /** Runs `stop` as the server begins to stop, before anything is waited on. */
  onClose(stop: () => void): void {
    this.closers.push(stop);
  }

  /** Waits on `drain` once no request is running any more, before the database closes. */
  onDrain(drain: () => Promise<unknown>): void {
    this.drains.push(drain);
  }

  /** Stops every loop, then ends outbound calls under way. */
  close(): void {
    this.closed = true;
    for (const stop of this.closers) stop();
    this.shutdown.abort();
  }

  async drain(): Promise<void> {
    await Promise.all(this.drains.map((drain) => drain()));
  }
}
