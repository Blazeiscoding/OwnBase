import type { ID, Message } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { shape } from "../core/rows.js";
import { messageRow } from "../messages/store.js";
import type { Store } from "../store.js";

const pinnedRow = messageRow.with({ pinned_at: "number" });
const savedRow = messageRow.with({ saved_at: "number" });
const totalRow = shape({ total: "number" });
const savedIdRow = shape({ message_id: "text" });

/** What is kept to come back to: a channel's pins, shared, and each account's saved messages. */
export class SavedStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

  pin(channelId: ID, messageId: ID, userId: ID): boolean {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO pins (channel_id, message_id, user_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(channelId, messageId, userId, Date.now());
    return res.changes > 0;
  }

  unpin(messageId: ID): boolean {
    const res = this.db.prepare("DELETE FROM pins WHERE message_id = ?").run(messageId);
    return res.changes > 0;
  }

  /** Pinned messages in a channel, newest pin first, and how many there are in all. */
  listPins(
    channelId: ID,
    limit = 30,
    cursor?: string,
  ): { messages: Message[]; nextCursor: string | null; total: number } {
    const [beforeTime, beforeId] = cursor?.split(":") ?? [];
    const timestamp = beforeTime ? Number(beforeTime) : null;
    // A pin on a message deleted since, or on a reply whose thread was, is not listed.
    const shown = `p.channel_id = ? AND m.deleted_at IS NULL
         AND (m.thread_root_id IS NULL OR EXISTS (
           SELECT 1 FROM messages root WHERE root.id = m.thread_root_id AND root.deleted_at IS NULL
         ))`;
    const rows = pinnedRow.all(
      this.db.prepare(
        `SELECT m.*, p.created_at AS pinned_at FROM pins p JOIN messages m ON m.id = p.message_id
         WHERE ${shown}
         AND (? IS NULL OR p.created_at < ? OR (p.created_at = ? AND p.message_id < ?))
         ORDER BY p.created_at DESC, p.message_id DESC LIMIT ?`,
      ),
      channelId,
      timestamp,
      timestamp,
      timestamp,
      beforeId ?? null,
      limit + 1,
    );
    const { total } = totalRow.get(
      this.db.prepare(
        `SELECT COUNT(*) AS total FROM pins p JOIN messages m ON m.id = p.message_id WHERE ${shown}`,
      ),
      channelId,
    )!;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      messages: this.store.messages.hydrate(page),
      nextCursor: rows.length > limit && last ? `${last.pinned_at}:${last.id}` : null,
      total,
    };
  }

  save(userId: ID, messageId: ID): boolean {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO saved_items (user_id, message_id, created_at) VALUES (?, ?, ?)",
      )
      .run(userId, messageId, Date.now());
    if (res.changes === 0) return false;
    this.store.outbox.person(userId, { type: "saved", messageId, saved: true });
    return true;
  }

  unsave(userId: ID, messageId: ID): boolean {
    const res = this.db
      .prepare("DELETE FROM saved_items WHERE user_id = ? AND message_id = ?")
      .run(userId, messageId);
    if (res.changes === 0) return false;
    this.store.outbox.person(userId, { type: "saved", messageId, saved: false });
    return true;
  }

  savedIds(userId: ID): ID[] {
    const rows = savedIdRow.all(
      this.db.prepare(
        `SELECT s.message_id FROM saved_items s JOIN messages m ON m.id = s.message_id
         WHERE s.user_id = ? AND m.deleted_at IS NULL ORDER BY s.created_at DESC`,
      ),
      userId,
    );
    return rows.map((r) => r.message_id);
  }

  /** Saved messages the user can still reach, newest save first. */
  listSaved(
    userId: ID,
    limit = 30,
    cursor?: string,
  ): { messages: Message[]; nextCursor: string | null } {
    const [beforeTime, beforeId] = cursor?.split(":") ?? [];
    const rows = savedRow.all(
      this.db.prepare(
        `SELECT m.*, s.created_at AS saved_at FROM saved_items s
         JOIN messages m ON m.id = s.message_id
         JOIN channels c ON c.id = m.channel_id
         WHERE s.user_id = ? AND m.deleted_at IS NULL
         AND (m.thread_root_id IS NULL OR EXISTS (
           SELECT 1 FROM messages root WHERE root.id = m.thread_root_id AND root.deleted_at IS NULL
         )) AND (
           c.type = 'public'
           OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
         )
         AND (? IS NULL OR s.created_at < ? OR (s.created_at = ? AND s.message_id < ?))
         ORDER BY s.created_at DESC, s.message_id DESC LIMIT ?`,
      ),
      userId,
      userId,
      beforeTime ? Number(beforeTime) : null,
      beforeTime ? Number(beforeTime) : null,
      beforeTime ? Number(beforeTime) : null,
      beforeId ?? null,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      messages: this.store.messages.hydrate(page),
      nextCursor: rows.length > limit && last ? `${last.saved_at}:${last.id}` : null,
    };
  }
}
