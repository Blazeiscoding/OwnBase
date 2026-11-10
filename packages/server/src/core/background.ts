import type { FastifyBaseLogger } from "fastify";
import { contain } from "./contain.js";

/** How one queue is failing in the background: since when, and how many times in a row. */
export interface BackgroundFailure {
  since: number;
  failures: number;
}

/**
 * Work the server does outside any request: queues run from a timer, an
 * immediate or startup, work that follows a commit, and hourly housekeeping.
 * A throw or rejection there would end the process (REV-01), so each is
 * contained, logged, and tried again on its next round.
 */
export class BackgroundWork {
  /**
   * Queues failing now, by name (REV-01). Cleared when the queue next
   * succeeds. Times and counts only, so admin status can show it without any
   * error text.
   */
  private readonly failing = new Map<string, BackgroundFailure>();
  /** Runs already being watched: callers share one in-flight flush, which fails once. */
  private readonly watched = new WeakSet<Promise<unknown>>();

  constructor(private readonly log: FastifyBaseLogger) {}

  /**
   * Runs a queue's work. The durable rows it was working on stay as they
   * were when it fails. Callers that must learn of a failure, such as tests
   * and operators, call the queue's own function.
   */
  run(queue: string, work: () => unknown): void {
    const failed = (err: unknown) => {
      const failing = this.failing.get(queue);
      this.failing.set(queue, {
        since: failing?.since ?? Date.now(),
        failures: (failing?.failures ?? 0) + 1,
      });
      this.log.error({ err, queue }, "background work failed; it will be tried again");
    };
    const succeeded = () => this.failing.delete(queue);
    contain(() => {
      const result = work();
      if (!(result instanceof Promise)) succeeded();
      else if (!this.watched.has(result)) {
        this.watched.add(result);
        result.then(succeeded, failed);
      }
    }, failed);
  }

  /** Runs work that follows a commit, so its failure is logged instead of undoing the answer. */
  afterCommitted(what: string, work: () => void): void {
    contain(work, (err) => this.log.error({ err }, `could not ${what} after a commit`));
  }

  /** One step of housekeeping; one failing does not skip the rest. */
  maintain(step: string, work: () => void): void {
    contain(work, (err) =>
      this.log.error({ err, step }, "maintenance step failed; it will be tried again"),
    );
  }

  failures(): [queue: string, failure: BackgroundFailure][] {
    return [...this.failing];
  }
}
