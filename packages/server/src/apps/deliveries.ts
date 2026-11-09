import type { ID } from "@ownbase/protocol";
import type { ServerContext } from "../core/context.js";
import { OutboundError } from "../outbound.js";
import type { AppCalls } from "./calls.js";
import type { DueDelivery } from "./deliveryStore.js";

/** Delays after failures; the eighth failed attempt becomes terminal. */
const RETRY_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 3600_000, 6 * 3600_000];
const ATTEMPTS = RETRY_MS.length + 1;
/** App events on their way at once, across every endpoint; one per subscription. */
const CONCURRENCY = 10;
/** App events one round of delivery starts before it waits to be asked again. */
const ROUND = 50;
const RETENTION_MS = 7 * 24 * 3600_000;

/**
 * Events on their way to the endpoints apps subscribed: sent in order per
 * subscription, retried on a ladder, and given up on (kept for an
 * administrator to retry) once the ladder is spent.
 */
export function createEventDeliveries(ctx: ServerContext, calls: AppCalls) {
  const { opts, store, log, background, lifecycle } = ctx;

  /** Sends one event to its endpoint and records how that went. */
  const deliver = async (delivery: DueDelivery): Promise<void> => {
    try {
      const retryHeaders: Record<string, string> =
        delivery.attempts > 0
          ? {
              "x-slack-retry-num": String(delivery.attempts),
              "x-slack-retry-reason": "http_error",
            }
          : {};
      const res = await calls.post(
        delivery.url,
        delivery.body,
        "application/json",
        delivery.signingSecret,
        retryHeaders,
      );
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      store.deliveries.complete(delivery.id, delivery.subscriptionId);
    } catch (err) {
      // Cut short by this server stopping, which says nothing about the
      // endpoint. The row stays due and goes out after the restart,
      // rather than spending one of the endpoint's attempts.
      if (err instanceof OutboundError && err.code === "aborted") return;
      const message = err instanceof Error ? err.message : "unknown delivery error";
      const delay = RETRY_MS[Math.min(delivery.attempts, RETRY_MS.length - 1)]!;
      const failure = store.deliveries.fail(delivery.id, message, Date.now() + delay, ATTEMPTS);
      // Deleting the subscription/app or revoking channel membership
      // while the request was in flight deliberately removed the row.
      if (!failure) return;
      // An endpoint that has used up a whole ladder of attempts is not
      // coming back on its own, so the rest of its queue goes with it
      // rather than each event repeating the same hours of retries.
      const alsoAbandoned = failure.terminal
        ? store.deliveries.abandonBacklog(delivery.subscriptionId, message)
        : 0;
      log.warn(
        {
          subscriptionId: delivery.subscriptionId,
          eventSeq: delivery.eventSeq,
          attempt: failure.attempts,
          terminal: failure.terminal,
          alsoAbandoned,
          err: message,
        },
        failure.terminal
          ? "event subscription delivery abandoned"
          : "event subscription delivery will retry",
      );
    }
  };

  let flushing: Promise<void> | null = null;
  /** While a flush runs: starts a fresh round, looking for due events now. */
  let nudge: (() => void) | null = null;
  /**
   * Delivers in sequence per subscription and in parallel across endpoints.
   * A receiver can see a duplicate if this process dies after its HTTP 2xx but
   * before the row is deleted; event_id remains stable so it can deduplicate.
   *
   * A pump rather than batches (REV-15): each slot freed goes straight to the
   * next due event of a subscription with nothing on its way, so an endpoint
   * slow to answer holds back only its own events. At most `CONCURRENCY` are
   * out at once and one per subscription. A round starts at most `ROUND`;
   * another flush asked for while this one runs (new events, the timer)
   * starts a fresh round in it.
   */
  const flush = (): Promise<void> => {
    // Left queued rather than refused, so nothing is spent against an
    // endpoint's attempts and it all goes out if this data is started normally.
    if (opts.isolated) return Promise.resolve();
    if (flushing) {
      nudge?.();
      return flushing;
    }
    flushing = (async () => {
      const out = new Map<ID, Promise<void>>();
      const failures: unknown[] = [];
      let remaining = 0;
      let freshRound = true;
      let wake = () => {};
      nudge = () => {
        freshRound = true;
        wake();
      };
      try {
        while (!lifecycle.closing && failures.length === 0) {
          if (freshRound) {
            freshRound = false;
            remaining = ROUND;
            // Retries waiting for room take any that has freed up (REV-15).
            store.deliveries.promoteAllRetries();
          }
          const room = Math.min(CONCURRENCY - out.size, remaining);
          if (room > 0) {
            for (const delivery of store.deliveries.due(Date.now(), room, [...out.keys()])) {
              remaining--;
              const sending = deliver(delivery)
                .catch((error: unknown) => {
                  failures.push(error);
                })
                .finally(() => {
                  out.delete(delivery.subscriptionId);
                  wake();
                });
              out.set(delivery.subscriptionId, sending);
            }
          }
          if (out.size === 0) break;
          // Until one finishes or more work is announced.
          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        // Stopping, or a step failed: what is already out ends on its own (the
        // shutdown signal cuts calls short) before the flush does, so the next
        // flush never sends an event that is still on its way.
        await Promise.all(out.values());
      }
      if (failures.length > 0) throw failures[0];
    })().finally(() => {
      flushing = null;
      nudge = null;
    });
    return flushing;
  };

  const soon = () => background.run("event deliveries", flush);
  lifecycle.onDrain(() => flushing ?? Promise.resolve());

  return {
    flush,
    /** Starts a flush in the background, its failure logged rather than thrown. */
    soon,
    start() {
      soon();
      lifecycle.every(5_000, soon);
    },
    hourly: () =>
      background.maintain("event deliveries", () =>
        store.deliveries.prune(Date.now() - RETENTION_MS),
      ),
  };
}

export type EventDeliveries = ReturnType<typeof createEventDeliveries>;
