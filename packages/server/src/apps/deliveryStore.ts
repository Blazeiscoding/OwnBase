import type { ID } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { countOf, shape } from "../core/rows.js";
import { ulid } from "../ids.js";

/** An event due to go to one subscription's endpoint, with where and how to sign it. */
export interface DueDelivery {
  id: ID;
  subscriptionId: ID;
  eventSeq: number;
  body: string;
  attempts: number;
  url: string;
  signingSecret: string;
}

const dueRow = shape({
  id: "text",
  subscription_id: "text",
  event_seq: "number",
  body: "text",
  attempts: "number",
  url: "text",
  signing_secret: "text",
});
const attemptsRow = shape({ attempts: "number", failed_at: "number?" });
const subscriptionIdRow = shape({ subscription_id: "text" });

/**
 * The durable queue of events on their way to apps' endpoints: one row per
 * event and subscription, waiting, retrying, or given up on and kept for an
 * administrator to retry.
 */
export class DeliveryStore {
  /**
   * The most events one endpoint may have waiting. Delivery is ordered, so a
   * receiver that stops answering holds up everything behind it; without a
   * ceiling its queue would grow for as long as the workspace stays busy, and
   * every row carries a full event body. Past the ceiling the event is counted
   * as dropped instead, which is visible to an administrator and bounded.
   */
  static readonly MAX_PENDING = 500;
  /**
   * The most events given up on that one endpoint keeps for an administrator
   * to retry (REV-15). A dead endpoint fails a full queue every few hours, so
   * a week's history would otherwise be thousands of rows; past this the
   * oldest go, counted as dropped. With message text capped at 4,000
   * characters, an endpoint's waiting and given-up rows stay within tens of
   * megabytes.
   */
  static readonly MAX_FAILED = 1_000;

  constructor(private readonly db: DatabaseSync) {}

  /** True if the event was queued, false if the backlog was already full. */
  enqueue(
    subscriptionId: ID,
    channelId: ID | null,
    eventSeq: number,
    body: string,
    now = Date.now(),
    /** The message whose words the body carries, so an edit or delete can find it. */
    messageId: ID | null = null,
  ): boolean {
    // OFFSET stops the scan at the ceiling rather than counting a long backlog
    // on every event.
    const full = this.db
      .prepare(
        "SELECT 1 FROM event_deliveries WHERE subscription_id = ? AND failed_at IS NULL LIMIT 1 OFFSET ?",
      )
      .get(subscriptionId, DeliveryStore.MAX_PENDING - 1);
    if (full) {
      this.db
        .prepare("UPDATE event_subscriptions SET dropped_count = dropped_count + 1 WHERE id = ?")
        .run(subscriptionId);
      return false;
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO event_deliveries
           (id, subscription_id, channel_id, event_seq, body, next_attempt_at, created_at, message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ulid(), subscriptionId, channelId, eventSeq, body, now, now, messageId);
    return true;
  }

  /**
   * At most one event per subscription is returned. An older retry blocks newer
   * events for that endpoint, preserving event-sequence order. Subscriptions in
   * `busy` (an event of theirs is already on its way) are left out entirely.
   */
  due(now = Date.now(), limit = 10, busy: readonly ID[] = []): DueDelivery[] {
    const rows = dueRow.all(
      this.db.prepare(
        `SELECT d.id, d.subscription_id, d.event_seq, d.body, d.attempts,
                s.url, a.signing_secret
         FROM event_deliveries d
         JOIN event_subscriptions s ON s.id = d.subscription_id
         JOIN apps a ON a.id = s.app_id
         JOIN users u ON u.id = a.bot_user_id
         WHERE d.failed_at IS NULL AND d.next_attempt_at <= ? AND u.deactivated = 0
           AND (d.channel_id IS NULL OR EXISTS (
             SELECT 1 FROM channel_members cm
             WHERE cm.channel_id = d.channel_id AND cm.user_id = a.bot_user_id
           ))
           AND NOT EXISTS (
             SELECT 1 FROM event_deliveries older
             WHERE older.subscription_id = d.subscription_id
               AND older.failed_at IS NULL
               AND (older.event_seq < d.event_seq OR
                    (older.event_seq = d.event_seq AND older.id < d.id))
           )
           AND d.subscription_id NOT IN (SELECT value FROM json_each(?))
         ORDER BY d.next_attempt_at, d.event_seq, d.id LIMIT ?`,
      ),
      now,
      JSON.stringify(busy),
      limit,
    );
    return rows.map((r) => ({
      id: r.id,
      subscriptionId: r.subscription_id,
      eventSeq: r.event_seq,
      body: r.body,
      attempts: r.attempts,
      url: r.url,
      signingSecret: r.signing_secret,
    }));
  }

  complete(id: ID, subscriptionId: ID): boolean {
    const done = this.db.prepare("DELETE FROM event_deliveries WHERE id = ?").run(id).changes > 0;
    // A slot has freed up: an event waiting to be retried takes it before a
    // new event can, so a retry drains however busy the workspace is.
    if (done) this.promoteRetries(subscriptionId);
    // Events lost to a full backlog stop being current news once the endpoint
    // is answering again. The guard keeps this free on the usual path, where
    // there is nothing to clear.
    this.db
      .prepare(
        "UPDATE event_subscriptions SET dropped_count = 0 WHERE id = ? AND dropped_count != 0",
      )
      .run(subscriptionId);
    return done;
  }

  fail(
    id: ID,
    error: string,
    nextAttemptAt: number,
    maxAttempts: number,
    now = Date.now(),
  ): { attempts: number; terminal: boolean } | null {
    this.db
      .prepare(
        `UPDATE event_deliveries SET
           attempts = attempts + 1,
           next_attempt_at = ?,
           last_error = ?,
           failed_at = CASE WHEN attempts + 1 >= ? THEN ? ELSE NULL END
         WHERE id = ?`,
      )
      .run(nextAttemptAt, error.slice(0, 500), maxAttempts, now, id);
    const row = attemptsRow.get(
      this.db.prepare("SELECT attempts, failed_at FROM event_deliveries WHERE id = ?"),
      id,
    );
    return row ? { attempts: row.attempts, terminal: row.failed_at !== null } : null;
  }

  /**
   * Gives up on everything still queued for one endpoint.
   *
   * Called once a delivery has exhausted its attempts. Spending the full ladder
   * on each event in turn would mean a dead endpoint is retried forever while
   * its queue keeps growing, and would leave an administrator repairing it with
   * a backlog that drains one event every few hours. Failing the rest together
   * makes "retry failed" the single way back, and it restores them in order.
   */
  abandonBacklog(subscriptionId: ID, error: string, now = Date.now()): number {
    const abandoned = Number(
      this.db
        .prepare(
          `UPDATE event_deliveries SET failed_at = ?, last_error = ?
           WHERE subscription_id = ? AND failed_at IS NULL`,
        )
        .run(now, error.slice(0, 500), subscriptionId).changes,
    );
    // The endpoint failed again, so what was still waiting to be retried waits
    // for another retry, kept with the rest of what was given up on. It is
    // given up on now, so it is kept for the whole history window from now
    // rather than expiring at once for having first failed long ago (F04).
    this.db
      .prepare(
        "UPDATE event_deliveries SET retry_requested = 0, failed_at = ? WHERE subscription_id = ? AND retry_requested = 1",
      )
      .run(now, subscriptionId);
    this.trimFailed(subscriptionId);
    return abandoned;
  }

  /**
   * Keeps an endpoint's given-up events within MAX_FAILED, the newest kept,
   * the rest counted as dropped (REV-15).
   */
  private trimFailed(subscriptionId: ID): void {
    const trimmed = Number(
      this.db
        .prepare(
          `DELETE FROM event_deliveries WHERE id IN (
             SELECT id FROM event_deliveries
             WHERE subscription_id = ? AND failed_at IS NOT NULL AND retry_requested = 0
             ORDER BY event_seq DESC, id DESC LIMIT -1 OFFSET ?)`,
        )
        .run(subscriptionId, DeliveryStore.MAX_FAILED).changes,
    );
    if (trimmed > 0)
      this.db
        .prepare("UPDATE event_subscriptions SET dropped_count = dropped_count + ? WHERE id = ?")
        .run(trimmed, subscriptionId);
  }

  /**
   * Moves events waiting to be retried into the endpoint's queue as far as
   * it has room under MAX_PENDING, oldest first (REV-15). Returns how many
   * went in.
   */
  private promoteRetries(subscriptionId: ID, now = Date.now()): number {
    const waiting = this.db
      .prepare(
        "SELECT 1 FROM event_deliveries WHERE subscription_id = ? AND retry_requested = 1 LIMIT 1",
      )
      .get(subscriptionId);
    if (!waiting) return 0;
    const queued = countOf(
      this.db.prepare(
        "SELECT COUNT(*) AS n FROM event_deliveries WHERE subscription_id = ? AND failed_at IS NULL",
      ),
      subscriptionId,
    );
    const room = DeliveryStore.MAX_PENDING - queued;
    if (room <= 0) return 0;
    return Number(
      this.db
        .prepare(
          `UPDATE event_deliveries SET attempts = 0, next_attempt_at = ?, failed_at = NULL,
             last_error = NULL, retry_requested = 0
           WHERE id IN (SELECT id FROM event_deliveries
             WHERE subscription_id = ? AND retry_requested = 1
             ORDER BY event_seq, id LIMIT ?)`,
        )
        .run(now, subscriptionId, room).changes,
    );
  }

  /** Every endpoint's waiting retries, as far as each has room. Returns how many went in. */
  promoteAllRetries(now = Date.now()): number {
    const subscriptions = subscriptionIdRow.all(
      this.db.prepare(
        "SELECT DISTINCT subscription_id FROM event_deliveries WHERE retry_requested = 1",
      ),
    );
    let promoted = 0;
    for (const { subscription_id } of subscriptions)
      promoted += this.promoteRetries(subscription_id, now);
    return promoted;
  }

  /**
   * Forgets given-up events older than the history window. An event an
   * administrator has asked to retry is not history but accepted work waiting
   * for room, however long the queue stays full, so it stays until it goes
   * out or the endpoint fails again (F04).
   */
  prune(failedBefore: number): void {
    this.db
      .prepare("DELETE FROM event_deliveries WHERE failed_at < ? AND retry_requested = 0")
      .run(failedBefore);
  }

  /**
   * Asks for an endpoint's given-up events to be sent again (REV-15). They go
   * back into its queue only as far as it has room, oldest first; the rest are
   * kept, waiting, and take each slot that frees up as the endpoint answers.
   * Returns how many were asked for, and how many still wait for room.
   */
  retryFailed(subscriptionId: ID, now = Date.now()): { retried: number; waiting: number } {
    const retried = Number(
      this.db
        .prepare(
          `UPDATE event_deliveries SET retry_requested = 1
           WHERE subscription_id = ? AND failed_at IS NOT NULL AND retry_requested = 0`,
        )
        .run(subscriptionId).changes,
    );
    this.promoteRetries(subscriptionId, now);
    const waiting = countOf(
      this.db.prepare(
        "SELECT COUNT(*) AS n FROM event_deliveries WHERE subscription_id = ? AND retry_requested = 1",
      ),
      subscriptionId,
    );
    // The tally is what an administrator was shown before deciding to retry, so
    // clearing it here marks that report as read rather than losing it.
    this.db
      .prepare("UPDATE event_subscriptions SET dropped_count = 0 WHERE id = ?")
      .run(subscriptionId);
    return { retried, waiting };
  }
}
