import type { CustomEmoji, CustomEmojiType, ID } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { shape } from "../core/rows.js";
import { ulid } from "../ids.js";

const emojiRow = shape({ id: "text", name: "text", created_by: "text" });
const pictureRow = shape({ type: "text", bytes: "bytes" });
const countRow = shape({ total: "number" });

const toEmoji = (row: { id: string; name: string; created_by: string }): CustomEmoji => ({
  id: row.id,
  name: row.name,
  createdBy: row.created_by,
});

/** The workspace's own emoji (J12): a name, and a picture kept in the database. */
export class EmojiStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Every custom emoji, by name. */
  list(): CustomEmoji[] {
    return emojiRow
      .all(this.db.prepare("SELECT id, name, created_by FROM custom_emoji ORDER BY name"))
      .map(toEmoji);
  }

  count(): number {
    return countRow.get(this.db.prepare("SELECT COUNT(*) AS total FROM custom_emoji"))!.total;
  }

  get(id: ID): CustomEmoji | null {
    const row = emojiRow.get(
      this.db.prepare("SELECT id, name, created_by FROM custom_emoji WHERE id = ?"),
      id,
    );
    return row ? toEmoji(row) : null;
  }

  /** Whether a custom emoji has this name now. */
  has(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM custom_emoji WHERE name = ?").get(name) !== undefined;
  }

  picture(id: ID): { type: string; bytes: Buffer } | null {
    const row = pictureRow.get(
      this.db.prepare("SELECT type, bytes FROM custom_emoji WHERE id = ?"),
      id,
    );
    return row ? { type: row.type, bytes: Buffer.from(row.bytes) } : null;
  }

  /** Every picture, for a copy of the workspace to carry. */
  pictures(): { emoji: CustomEmoji; type: string; bytes: Buffer }[] {
    return shape({ id: "text", name: "text", created_by: "text", type: "text", bytes: "bytes" })
      .all(
        this.db.prepare("SELECT id, name, created_by, type, bytes FROM custom_emoji ORDER BY name"),
      )
      .map((row) => ({ emoji: toEmoji(row), type: row.type, bytes: Buffer.from(row.bytes) }));
  }

  /** Adds one; the caller has checked the name is free and the picture good. */
  add(
    name: string,
    picture: { type: CustomEmojiType; bytes: Buffer },
    createdBy: ID,
    now = Date.now(),
  ): CustomEmoji {
    const id = ulid(now);
    this.db
      .prepare(
        "INSERT INTO custom_emoji (id, name, type, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, name, picture.type, picture.bytes, createdBy, now);
    return { id, name, createdBy };
  }

  remove(id: ID): boolean {
    return this.db.prepare("DELETE FROM custom_emoji WHERE id = ?").run(id).changes > 0;
  }
}
