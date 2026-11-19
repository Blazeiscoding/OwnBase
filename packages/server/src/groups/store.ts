import type { ID, UserGroup } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { shape } from "../core/rows.js";
import { ulid } from "../ids.js";

const groupRow = shape({ id: "text", handle: "text", name: "text", description: "text" });
const memberRow = shape({ group_id: "text", user_id: "text" });
const userRow = shape({ user_id: "text" });
const idRow = shape({ group_id: "text" });

/** The workspace's user groups (J13) and who is in each. */
export class GroupStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Every group with its people, by handle. */
  list(): UserGroup[] {
    const members = new Map<ID, ID[]>();
    for (const row of memberRow.all(
      this.db.prepare("SELECT group_id, user_id FROM user_group_members ORDER BY user_id"),
    )) {
      const list = members.get(row.group_id) ?? [];
      list.push(row.user_id);
      members.set(row.group_id, list);
    }
    return groupRow
      .all(this.db.prepare("SELECT id, handle, name, description FROM user_groups ORDER BY handle"))
      .map((row) => ({ ...row, memberIds: members.get(row.id) ?? [] }));
  }

  get(id: ID): UserGroup | null {
    const row = groupRow.get(
      this.db.prepare("SELECT id, handle, name, description FROM user_groups WHERE id = ?"),
      id,
    );
    if (!row) return null;
    const memberIds = userRow
      .all(
        this.db.prepare(
          "SELECT user_id FROM user_group_members WHERE group_id = ? ORDER BY user_id",
        ),
        id,
      )
      .map((member) => member.user_id);
    return { ...row, memberIds };
  }

  /** Whether a group has this handle now. */
  hasHandle(handle: string): boolean {
    return this.db.prepare("SELECT 1 FROM user_groups WHERE handle = ?").get(handle) !== undefined;
  }

  /** The groups one person is in now. */
  idsOf(userId: ID): ID[] {
    return idRow
      .all(this.db.prepare("SELECT group_id FROM user_group_members WHERE user_id = ?"), userId)
      .map((row) => row.group_id);
  }

  /**
   * The people of these groups who are in this conversation and active: whom
   * mentioning the groups there names. Nobody outside it is named, and nobody
   * is added to it.
   */
  namedIn(channelId: ID, groupIds: Iterable<ID>): ID[] {
    const ids = [...groupIds];
    if (ids.length === 0) return [];
    return userRow
      .all(
        this.db.prepare(
          `SELECT DISTINCT ugm.user_id FROM user_group_members ugm
           JOIN channel_members cm ON cm.user_id = ugm.user_id AND cm.channel_id = ?
           JOIN users u ON u.id = ugm.user_id
           WHERE ugm.group_id IN (${ids.map(() => "?").join(",")}) AND u.deactivated = 0`,
        ),
        channelId,
        ...ids,
      )
      .map((row) => row.user_id);
  }

  /** Makes one; the caller has checked the handle is free and the people real. */
  create(
    input: { handle: string; name: string; description: string; memberIds: ID[] },
    createdBy: ID,
    now = Date.now(),
  ): UserGroup {
    const id = ulid(now);
    this.db
      .prepare(
        "INSERT INTO user_groups (id, handle, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.handle, input.name, input.description, createdBy, now);
    this.setMembers(id, input.memberIds);
    return this.get(id)!;
  }

  update(
    id: ID,
    patch: { handle?: string; name?: string; description?: string; memberIds?: ID[] },
  ): UserGroup {
    const columns = (["handle", "name", "description"] as const).filter(
      (key) => patch[key] !== undefined,
    );
    if (columns.length > 0)
      this.db
        .prepare(`UPDATE user_groups SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
        .run(...columns.map((c) => patch[c]!), id);
    if (patch.memberIds) this.setMembers(id, patch.memberIds);
    return this.get(id)!;
  }

  delete(id: ID): boolean {
    return this.db.prepare("DELETE FROM user_groups WHERE id = ?").run(id).changes > 0;
  }

  private setMembers(id: ID, memberIds: readonly ID[]): void {
    this.db.prepare("DELETE FROM user_group_members WHERE group_id = ?").run(id);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO user_group_members (group_id, user_id) VALUES (?, ?)",
    );
    for (const userId of memberIds) insert.run(id, userId);
  }
}
