import type { ID, MessageReport, ReportReason } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { countOf, oneOf, shape } from "../core/rows.js";
import { ulid } from "../ids.js";
import type { Store } from "../store.js";

export interface OpenReport {
  messageId: ID;
  channelId: ID;
  authorId: ID;
  reports: MessageReport[];
}

const openReportRow = shape({
  id: "text",
  message_id: "text",
  reporter_id: "text",
  reason: oneOf({
    spam: true,
    harassment: true,
    inappropriate: true,
    other: true,
  } satisfies Record<ReportReason, true>),
  note: "text",
  created_at: "number",
  channel_id: "text",
  author_id: "text",
});

/** Reported messages: members file them, admins settle them. */
export class ReportStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

  /** Keeps someone's report of a message; false when they have one open for it already. */
  file(messageId: ID, reporterId: ID, reason: string, note: string): boolean {
    const kept =
      this.db
        .prepare(
          `INSERT OR IGNORE INTO message_reports (id, message_id, reporter_id, reason, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(ulid(), messageId, reporterId, reason, note, Date.now()).changes === 1;
    if (kept) this.tellOpenCount();
    return kept;
  }

  private tellOpenCount(): void {
    this.store.outbox.admins("reports", () => ({ type: "reports", open: this.openCount() }));
  }

  /** How many reported messages wait for an admin. */
  openCount(): number {
    return countOf(
      this.db.prepare(
        "SELECT COUNT(DISTINCT message_id) AS n FROM message_reports WHERE resolved_at IS NULL",
      ),
    );
  }

  /**
   * The reported messages waiting for an admin, the longest waiting first,
   * each with where it was posted, who wrote it (known after its author
   * deleted it too) and its open reports in the order they came.
   */
  open(): OpenReport[] {
    const rows = openReportRow.all(
      this.db.prepare(
        `SELECT r.id, r.message_id, r.reporter_id, r.reason, r.note, r.created_at,
           m.channel_id, m.user_id AS author_id
         FROM message_reports r JOIN messages m ON m.id = r.message_id
         WHERE r.resolved_at IS NULL ORDER BY r.created_at, r.id`,
      ),
    );
    const byMessage = new Map<ID, OpenReport>();
    for (const row of rows) {
      const held = byMessage.get(row.message_id) ?? {
        messageId: row.message_id,
        channelId: row.channel_id,
        authorId: row.author_id,
        reports: [],
      };
      held.reports.push({
        id: row.id,
        reporterId: row.reporter_id,
        reason: row.reason,
        note: row.note,
        createdAt: row.created_at,
      });
      byMessage.set(row.message_id, held);
    }
    return [...byMessage.values()];
  }

  /** Closes a message's open reports as an admin resolved them; how many there were. */
  resolve(messageId: ID, adminId: ID, resolution: string): number {
    const resolved = Number(
      this.db
        .prepare(
          `UPDATE message_reports SET resolved_at = ?, resolved_by = ?, resolution = ?
           WHERE message_id = ? AND resolved_at IS NULL`,
        )
        .run(Date.now(), adminId, resolution, messageId).changes,
    );
    if (resolved > 0) this.tellOpenCount();
    return resolved;
  }
}
