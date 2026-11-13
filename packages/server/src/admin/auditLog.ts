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
  private readonly listeners = new Set<() => void>();
  private telling = false;

  constructor(private readonly db: DatabaseSync) {}

  /**
   * Calls `listener` after entries are written, once for any number written
   * together, and returns what stops it. It runs on a later turn, by when the
   * transaction that wrote them has committed or rolled back, so `after` reads
   * only entries that stayed.
   */
  onRecord(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private tell(): void {
    if (this.telling || this.listeners.size === 0) return;
    this.telling = true;
    setImmediate(() => {
      this.telling = false;
      for (const listener of this.listeners) listener();
    });
  }

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
    this.tell();
  }

  /**
   * Oldest first, the entries written after the one with id `afterId`, or
   * from the first when it is null. An id the log no longer has, as after a
   * restore from an older backup, reads from the first again: a reader that
   * sends entries on gets some twice rather than missing any.
   */
  after(afterId: ID | null, limit: number): AuditEntry[] {
    const from =
      afterId === null
        ? 0
        : ((
            this.db.prepare("SELECT rowid AS at FROM audit_log WHERE id = ?").get(afterId) as
              { at: number } | undefined
          )?.at ?? 0);
    const rows = this.db
      .prepare("SELECT * FROM audit_log WHERE rowid > ? ORDER BY rowid LIMIT ?")
      .all(from, limit) as AuditRow[];
    return rows.map(toEntry);
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
