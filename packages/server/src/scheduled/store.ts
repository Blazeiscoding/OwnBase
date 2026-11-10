import type { ID, ScheduledMessage, ScheduledStatus } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { countOf, oneOf, shape, type RowOf } from "../core/rows.js";
import { ulid } from "../ids.js";
import type { Store } from "../store.js";

const queueCountsRow = shape({ queued: "number", held: "number", failed: "number" });

const scheduledRow = shape({
  id: "text",
  channel_id: "text",
  user_id: "text",
  text: "text",
  thread_root_id: "text?",
  file_ids: "text",
  send_at: "number",
  created_at: "number",
  status: oneOf({ queued: true, held: true, failed: true, sent: true } satisfies Record<
    ScheduledStatus,
    true
  >),
  failure_reason: "text?",
  attempts: "number",
  message_id: "text?",
  broadcast: "number",
});
const authorRow = scheduledRow.pick("user_id");
const heldRow = scheduledRow.pick("user_id", "status", "failure_reason");
const attemptsRow = scheduledRow.pick("attempts");
const sendKeyRow = shape({ scheduledId: "text", requestHash: "text" });

/** The queue of messages to post later: waiting, held, sent or failed, each with why. */
export class ScheduledStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

  request(userId: ID, nonce: string): { scheduledId: ID; requestHash: string } | null {
    return (
      sendKeyRow.get(
        this.db.prepare(
          "SELECT scheduled_id AS scheduledId, request_hash AS requestHash FROM scheduled_requests WHERE user_id = ? AND nonce = ?",
        ),
        userId,
        nonce,
      ) ?? null
    );
  }

  recordRequest(userId: ID, nonce: string, scheduledId: ID, requestHash: string): void {
    this.db
      .prepare(
        "INSERT INTO scheduled_requests (user_id, nonce, scheduled_id, request_hash) VALUES (?, ?, ?, ?)",
      )
      .run(userId, nonce, scheduledId, requestHash);
  }

  schedule(input: {
    channelId: ID;
    userId: ID;
    text: string;
    threadRootId: ID | null;
    fileIds: ID[];
    sendAt: number;
    broadcast?: boolean;
  }): ScheduledMessage {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO scheduled_messages
           (id, channel_id, user_id, text, thread_root_id, file_ids, send_at, created_at, broadcast)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.channelId,
        input.userId,
        input.text,
        input.threadRootId,
        JSON.stringify(input.fileIds),
        input.sendAt,
        now,
        input.threadRootId && input.broadcast ? 1 : 0,
      );
    // The key refuses a file some other scheduled message already holds, so
    // the caller's checks and this row cannot disagree.
    const hold = this.db.prepare(
      "INSERT INTO scheduled_files (file_id, scheduled_id) VALUES (?, ?)",
    );
    for (const fileId of input.fileIds) hold.run(fileId, id);
    this.tell(input.userId);
    return this.get(id)!;
  }

  /**
   * Tells the author's devices their queue changed: queued, edited, moved,
   * cancelled, sent, held for a new reason or given up on. A list open there
   * reads it again.
   */
  private tell(userId: ID): void {
    this.store.outbox.person(userId, { type: "scheduled" }, { key: "scheduled" });
  }

  private fromRow(r: RowOf<typeof scheduledRow.columns>): ScheduledMessage {
    let fileIds: ID[] = [];
    try {
      const parsed: unknown = JSON.parse(r.file_ids);
      if (Array.isArray(parsed)) fileIds = parsed.map(String);
    } catch {
      /* a corrupt row should not sink the whole list */
    }
    return {
      id: r.id,
      channelId: r.channel_id,
      userId: r.user_id,
      text: r.text,
      threadRootId: r.thread_root_id,
      broadcast: r.broadcast === 1,
      fileIds,
      sendAt: r.send_at,
      createdAt: r.created_at,
      status: r.status,
      failureReason: r.failure_reason,
      attempts: r.attempts,
      messageId: r.message_id,
    };
  }

  get(id: ID): ScheduledMessage | null {
    const r = scheduledRow.get(
      this.db.prepare("SELECT * FROM scheduled_messages WHERE id = ?"),
      id,
    );
    return r ? this.fromRow(r) : null;
  }

  /** One user's outstanding messages, soonest first. Delivered ones are done. */
  list(userId: ID): ScheduledMessage[] {
    const rows = scheduledRow.all(
      this.db.prepare(
        "SELECT * FROM scheduled_messages WHERE user_id = ? AND status != 'sent' ORDER BY send_at",
      ),
      userId,
    );
    return rows.map((r) => this.fromRow(r));
  }

  /**
   * Messages now due, across all users. Held ones come back every flush so a
   * reversible obstacle — an archived channel, lost membership, a deactivated
   * author — sends the message once it clears. The caller re-checks those
   * conditions: the queue lives on the server, so without that check a message
   * could post itself in the name of someone whose access was taken away
   * yesterday.
   */
  due(now = Date.now(), limit = 50): ScheduledMessage[] {
    const rows = scheduledRow.all(
      this.db.prepare(
        `SELECT * FROM scheduled_messages
         WHERE send_at <= ? AND (
           status = 'queued' OR (status = 'held' AND next_attempt_at <= ?)
         )
         ORDER BY send_at, id
         LIMIT ?`,
      ),
      now,
      now,
      limit,
    );
    return rows.map((r) => this.fromRow(r));
  }

  /**
   * Brings held messages forward to the next flush, once what held them may
   * have cleared: a channel reopened, a membership regained, an account
   * reactivated. The flush checks again, so waking one too many is harmless.
   */
  wakeHeld(scope: { channelId?: ID; userId?: ID }): void {
    const where = ["status = 'held'"];
    const params: string[] = [];
    if (scope.channelId) {
      where.push("channel_id = ?");
      params.push(scope.channelId);
    }
    if (scope.userId) {
      where.push("user_id = ?");
      params.push(scope.userId);
    }
    this.db
      .prepare(`UPDATE scheduled_messages SET next_attempt_at = 0 WHERE ${where.join(" AND ")}`)
      .run(...params);
  }

  /** Scheduled messages not yet delivered, for one account or, without one, everyone. */
  outstanding(userId?: ID): number {
    return userId
      ? countOf(
          this.db.prepare(
            "SELECT COUNT(*) AS n FROM scheduled_messages WHERE user_id = ? AND status != 'sent'",
          ),
          userId,
        )
      : countOf(
          this.db.prepare("SELECT COUNT(*) AS n FROM scheduled_messages WHERE status != 'sent'"),
        );
  }

  /**
   * Delivery, written inside the posting transaction so neither can happen
   * alone. Its files are the message's now, so the schedule lets go of them.
   */
  markSent(id: ID, messageId: ID): void {
    const row = authorRow.get(
      this.db.prepare(
        `UPDATE scheduled_messages SET status = 'sent', message_id = ?, failure_reason = NULL,
           text = '', file_ids = '[]' WHERE id = ? RETURNING user_id`,
      ),
      messageId,
      id,
    );
    this.db.prepare("DELETE FROM scheduled_files WHERE scheduled_id = ?").run(id);
    if (row) this.tell(row.user_id);
  }

  /**
   * A reason that may clear on its own. It is tried again at `retryAt`, or
   * sooner if `wakeHeld` hears that the obstacle has gone.
   */
  hold(id: ID, reason: string, retryAt = 0): void {
    const before = heldRow.get(
      this.db.prepare(
        "SELECT user_id, status, failure_reason FROM scheduled_messages WHERE id = ?",
      ),
      id,
    );
    this.db
      .prepare(
        "UPDATE scheduled_messages SET status = 'held', failure_reason = ?, next_attempt_at = ? WHERE id = ?",
      )
      .run(reason, retryAt, id);
    // Held again for the same reason looks no different to its author.
    if (before && (before.status !== "held" || before.failure_reason !== reason))
      this.tell(before.user_id);
  }

  /** Terminal. Only an explicit reschedule puts it back in the queue. */
  fail(id: ID, reason: string): void {
    const row = authorRow.get(
      this.db.prepare(
        "UPDATE scheduled_messages SET status = 'failed', failure_reason = ? WHERE id = ? RETURNING user_id",
      ),
      reason,
      id,
    );
    if (row) this.tell(row.user_id);
  }

  /** Counts one delivery attempt and returns the new total, so retries stay bounded. */
  countAttempt(id: ID): number {
    this.db.prepare("UPDATE scheduled_messages SET attempts = attempts + 1 WHERE id = ?").run(id);
    return (
      attemptsRow.get(this.db.prepare("SELECT attempts FROM scheduled_messages WHERE id = ?"), id)
        ?.attempts ?? 0
    );
  }

  /** Puts a held or failed message back in the queue at a new time. */
  reschedule(id: ID, sendAt: number): void {
    const row = authorRow.get(
      this.db.prepare(
        `UPDATE scheduled_messages
         SET send_at = ?, status = 'queued', failure_reason = NULL, attempts = 0,
           next_attempt_at = 0
         WHERE id = ? AND status != 'sent' RETURNING user_id`,
      ),
      sendAt,
      id,
    );
    if (row) this.tell(row.user_id);
  }

  /** Compare-and-set text without requeuing or changing delivery metadata. */
  editText(id: ID, text: string, expectedText: string): boolean {
    const row = authorRow.get(
      this.db.prepare(
        `UPDATE scheduled_messages SET text = ?
         WHERE id = ? AND status != 'sent' AND (text = ? OR text = ?) RETURNING user_id`,
      ),
      text,
      id,
      expectedText,
      text,
    );
    if (row) this.tell(row.user_id);
    return !!row;
  }

  /** Delivered rows are kept as proof of completion, then aged out. */
  prune(before: number): void {
    this.db
      .prepare("DELETE FROM scheduled_messages WHERE status = 'sent' AND send_at < ?")
      .run(before);
  }

  /** Cancels one. Its files go with the row, free for another message. */
  delete(id: ID): boolean {
    const row = authorRow.get(
      this.db.prepare("DELETE FROM scheduled_messages WHERE id = ? RETURNING user_id"),
      id,
    );
    if (row) this.tell(row.user_id);
    return !!row;
  }

  /** The queue by state, for admin status: counts only (OPS-10). */
  counts(): { queued: number; held: number; failed: number } {
    return queueCountsRow.get(
      this.db.prepare(
        `SELECT COUNT(*) FILTER (WHERE status = 'queued') AS queued,
                COUNT(*) FILTER (WHERE status = 'held') AS held,
                COUNT(*) FILTER (WHERE status = 'failed') AS failed
         FROM scheduled_messages`,
      ),
    )!;
  }
}
