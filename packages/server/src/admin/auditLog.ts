import type { AuditAction, AuditEntry, AuditTargetType, ID } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { ulid } from "../ids.js";

type AuditRow = {
  id: string;
  at: number;
  actor_id: string | null;
  action: AuditAction;
  target_type: AuditTargetType;
  target_id: string | null;
  details: string;
};

function toEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    at: r.at,
    actorId: r.actor_id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    details: JSON.parse(r.details) as AuditEntry["details"],
  };
}

/**
 * The audit log. Admins read it; every feature that changes something an
 * admin answers for writes to it, so it hangs off the store as `store.audit`.
 */
export class AuditLog {
  constructor(private readonly db: DatabaseSync) {}

  /** Call inside the transaction that makes the change, so neither exists without the other. */
  record(
    entry: {
      actorId: ID | null;
      action: AuditAction;
      targetType: AuditTargetType;
      targetId: string | null;
      details?: AuditEntry["details"];
    },
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        "INSERT INTO audit_log (id, at, actor_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        ulid(now),
        now,
        entry.actorId,
        entry.action,
        entry.targetType,
        entry.targetId,
        JSON.stringify(entry.details ?? {}),
      );
  }

  /**
   * Newest first. `before` is the id of the last entry already seen.
   *
   * Ordered by insertion rather than by id: ids made in the same millisecond
   * are not ordered among themselves, and two changes a moment apart must not
   * be listed the wrong way round.
   */
  list(opts: { before?: ID; limit: number }): AuditEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_log
         ${opts.before ? "WHERE rowid < (SELECT rowid FROM audit_log WHERE id = ?)" : ""}
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...(opts.before ? [opts.before] : []), opts.limit) as AuditRow[];
    return rows.map(toEntry);
  }
}
