import type { ID, Reminder, ReminderItem } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { ulid } from "../ids.js";
import type { MessageRow, Store } from "../store.js";

interface ReminderRow {
  id: string;
  user_id: string;
  message_id: string;
  remind_at: number;
  due_at: number | null;
  channel_id: string;
  thread_root_id: string | null;
}

/** Reminders (E4): one per account and message, waiting until their time, then due. */
export class ReminderStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

  /**
   * The reminders' join with their message and its conversation. Reachable
   * means the message is still there and the account can read its
   * conversation. A deleted thread's replies are deleted with it.
   */
  private static readonly REACHABLE = `m.deleted_at IS NULL
    AND (c.type = 'public'
      OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = r.user_id))`;

  private static fromRow(row: ReminderRow): Reminder {
    return {
      id: row.id,
      messageId: row.message_id,
      channelId: row.channel_id,
      threadRootId: row.thread_root_id,
      remindAt: row.remind_at,
      dueAt: row.due_at,
    };
  }

  /** One account's reminder about one message, reachable or not. */
  get(userId: ID, messageId: ID): Reminder | null {
    const row = this.db
      .prepare(
        `SELECT r.*, m.channel_id, m.thread_root_id FROM reminders r
         JOIN messages m ON m.id = r.message_id
         WHERE r.user_id = ? AND r.message_id = ?`,
      )
      .get(userId, messageId) as ReminderRow | undefined;
    return row ? ReminderStore.fromRow(row) : null;
  }

  /** Sets a reminder, or moves the one already there, waiting again. */
  set(userId: ID, messageId: ID, remindAt: number): Reminder {
    this.db
      .prepare(
        `INSERT INTO reminders (id, user_id, message_id, remind_at, due_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(user_id, message_id) DO UPDATE SET
           remind_at = excluded.remind_at,
           due_at = NULL`,
      )
      .run(ulid(), userId, messageId, remindAt, Date.now());
    const reminder = this.get(userId, messageId)!;
    this.store.outbox.person(userId, { type: "reminder", reminder });
    return reminder;
  }

  /** Done, cancelled, or out of reach. */
  delete(userId: ID, messageId: ID): boolean {
    const res = this.db
      .prepare("DELETE FROM reminders WHERE user_id = ? AND message_id = ?")
      .run(userId, messageId);
    if (res.changes === 0) return false;
    this.store.outbox.person(userId, { type: "reminder.removed", messageId });
    return true;
  }

  /** Drops every reminder about a message, saying whose they were. */
  dropForMessage(messageId: ID): ID[] {
    const rows = this.db
      .prepare("DELETE FROM reminders WHERE message_id = ? RETURNING user_id")
      .all(messageId) as { user_id: string }[];
    for (const row of rows)
      this.store.outbox.person(row.user_id, { type: "reminder.removed", messageId });
    return rows.map((row) => row.user_id);
  }

  count(userId: ID): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?")
      .get(userId) as { n: number };
    return row.n;
  }

  /** The reminders an account can still reach, for the handshake snapshot. */
  reachable(userId: ID): Reminder[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, m.channel_id, m.thread_root_id FROM reminders r
         JOIN messages m ON m.id = r.message_id
         JOIN channels c ON c.id = m.channel_id
         WHERE r.user_id = ? AND ${ReminderStore.REACHABLE}`,
      )
      .all(userId) as unknown as ReminderRow[];
    return rows.map(ReminderStore.fromRow);
  }

  /**
   * The Reminders list: those come due, the latest first, then those waiting,
   * the soonest first, each with its message.
   */
  list(userId: ID): ReminderItem[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, r.id AS reminder_id, r.remind_at, r.due_at FROM reminders r
         JOIN messages m ON m.id = r.message_id
         JOIN channels c ON c.id = m.channel_id
         WHERE r.user_id = ? AND ${ReminderStore.REACHABLE}
         ORDER BY r.due_at IS NULL, r.due_at DESC, r.remind_at, r.id`,
      )
      .all(userId) as unknown as (MessageRow & {
      reminder_id: string;
      remind_at: number;
      due_at: number | null;
    })[];
    const messages = this.store.messages.hydrate(rows);
    return rows.map((row, index) => ({
      reminder: {
        id: row.reminder_id,
        messageId: row.id,
        channelId: row.channel_id,
        threadRootId: row.thread_root_id,
        remindAt: row.remind_at,
        dueAt: row.due_at,
      },
      message: messages[index]!,
    }));
  }

  /** When the soonest waiting reminder comes due, if any waits. */
  nextAt(): number | null {
    const row = this.db
      .prepare("SELECT MIN(remind_at) AS at FROM reminders WHERE due_at IS NULL")
      .get() as { at: number | null };
    return row.at;
  }

  /** Waiting reminders whose time has come, the earliest first, with whose they are. */
  due(now: number, limit: number): (Reminder & { userId: ID })[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, m.channel_id, m.thread_root_id FROM reminders r
         JOIN messages m ON m.id = r.message_id
         WHERE r.due_at IS NULL AND r.remind_at <= ?
         ORDER BY r.remind_at, r.id LIMIT ?`,
      )
      .all(now, limit) as unknown as ReminderRow[];
    return rows.map((row) => ({ ...ReminderStore.fromRow(row), userId: row.user_id }));
  }

  markDue(userId: ID, messageId: ID, at: number): Reminder | null {
    this.db
      .prepare(
        "UPDATE reminders SET due_at = ? WHERE user_id = ? AND message_id = ? AND due_at IS NULL",
      )
      .run(at, userId, messageId);
    const reminder = this.get(userId, messageId);
    // Coming due carries the message, for the notification.
    if (reminder)
      this.store.outbox.person(userId, () => {
        const message = this.store.messages.get(messageId);
        return message ? { type: "reminder", reminder, message } : null;
      });
    return reminder;
  }
}
