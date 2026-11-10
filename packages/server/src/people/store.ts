import type { Friendship, ID, Role, User } from "@ownbase/protocol";
import { isAdministrator } from "@ownbase/protocol";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { countOf, oneOf, shape, type RowOf } from "../core/rows.js";
import { ulid } from "../ids.js";
import type { Store } from "../store.js";

/** The words a `role` column holds. */
export const ROLES = {
  owner: true,
  admin: true,
  member: true,
  guest: true,
} as const satisfies Record<Role, true>;

/** A `users` row, as `SELECT *` (or `u.*`) reads it. */
export const userRow = shape({
  id: "text",
  handle: "text",
  display_name: "text",
  password_hash: "text",
  salt: "text",
  role: oneOf(ROLES),
  status_text: "text",
  status_emoji: "text",
  status_expires_at: "number?",
  is_bot: "number",
  deactivated: "number",
  dnd_until: "number?",
  created_at: "number",
  can_invite: "number",
  time_zone: "text?",
  away: "number",
  avatar_version: "text?",
});
export type UserRow = RowOf<typeof userRow.columns>;

const idRow = userRow.pick("id");
const canInviteRow = userRow.pick("can_invite");
const awayRow = userRow.pick("away");
const roleRow = userRow.pick("role");
const friendshipRow = shape({
  user_low: "text",
  user_high: "text",
  requested_by: "text",
  accepted: "number",
  created_at: "number",
});
const blockedRow = shape({ blocked_id: "text" });
const nextExpiryRow = shape({ next: "number?" });
const avatarRow = shape({ type: "text", bytes: "bytes", avatar_version: "text?" });
const lastSeenRow = shape({ user_id: "text", seen: "number" });

export function toUser(r: UserRow): User {
  return {
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    role: r.role,
    statusText: r.status_text,
    statusEmoji: r.status_emoji,
    ...(r.status_expires_at != null ? { statusExpiresAt: r.status_expires_at } : {}),
    isBot: r.is_bot === 1,
    deactivated: r.deactivated === 1,
    dndUntil: r.dnd_until,
    createdAt: r.created_at,
    canInvite: mayInvite(r.role, r.is_bot, r.can_invite),
    ...(r.time_zone ? { timeZone: r.time_zone } : {}),
    ...(r.away === 1 ? { away: true as const } : {}),
    ...(r.avatar_version ? { avatarVersion: r.avatar_version } : {}),
  };
}

/**
 * The one rule for who may create invite codes, used for the flag clients see
 * and for the codes a creator has already handed out. An app never may.
 */
export function mayInvite(
  role: Role | null,
  isBot: number,
  canInvite: number | undefined | null,
): boolean {
  if (isBot === 1) return false;
  return isAdministrator(role) || canInvite === 1;
}

/** People: accounts as others see them, their profiles and pictures, friends and blocks. */
export class PeopleStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

  friends(userId: ID): Friendship[] {
    const rows = friendshipRow.all(
      this.db.prepare(
        `SELECT * FROM friendships WHERE user_low = ? OR user_high = ? ORDER BY created_at DESC`,
      ),
      userId,
      userId,
    );
    // A request from someone this account blocked waits unseen until they are unblocked (E12).
    const blocked = new Set(this.blockedIds(userId));
    return rows
      .map((r): Friendship => ({
        userId: r.user_low === userId ? r.user_high : r.user_low,
        status: r.accepted ? "accepted" : r.requested_by === userId ? "outgoing" : "incoming",
        createdAt: r.created_at,
      }))
      .filter((friend) => friend.status !== "incoming" || !blocked.has(friend.userId));
  }

  requestFriend(userId: ID, otherId: ID): void {
    const [low, high] = [userId, otherId].sort();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO friendships (user_low, user_high, requested_by, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(low!, high!, userId, Date.now());
    this.tellFriends(userId, otherId);
  }

  acceptFriend(userId: ID, otherId: ID): boolean {
    const [low, high] = [userId, otherId].sort();
    const accepted =
      this.db
        .prepare(
          `UPDATE friendships SET accepted = 1 WHERE user_low = ? AND user_high = ? AND requested_by = ?`,
        )
        .run(low!, high!, otherId).changes > 0;
    if (accepted) this.tellFriends(userId, otherId);
    return accepted;
  }

  /** Each account's devices hear its friends as they end up; nobody else does. */
  private tellFriends(...userIds: ID[]): void {
    for (const id of userIds)
      this.store.outbox.person(id, () => ({ type: "friends", friends: this.friends(id) }), {
        key: "friends",
      });
  }

  /** The people this account blocked, oldest first. */
  blockedIds(userId: ID): ID[] {
    const rows = blockedRow.all(
      this.db.prepare(
        "SELECT blocked_id FROM user_blocks WHERE user_id = ? ORDER BY created_at, blocked_id",
      ),
      userId,
    );
    return rows.map((row) => row.blocked_id);
  }

  /**
   * Blocks or unblocks someone for this account; whether anything changed.
   * Only this account's devices hear of it: whoever is blocked is told nothing.
   */
  setBlocked(userId: ID, otherId: ID, blocked: boolean): boolean {
    const changed =
      (blocked
        ? this.db
            .prepare(
              "INSERT OR IGNORE INTO user_blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)",
            )
            .run(userId, otherId, Date.now())
        : this.db
            .prepare("DELETE FROM user_blocks WHERE user_id = ? AND blocked_id = ?")
            .run(userId, otherId)
      ).changes === 1;
    if (!changed) return false;
    this.store.outbox.person(userId, () => ({ type: "blocks", blocked: this.blockedIds(userId) }), {
      key: "blocks",
    });
    // A request they sent meanwhile shows now.
    if (!blocked) this.tellFriends(userId);
    this.store.outbox.mentions([userId]);
    return true;
  }

  removeFriend(userId: ID, otherId: ID): void {
    const [low, high] = [userId, otherId].sort();
    this.db
      .prepare(`DELETE FROM friendships WHERE user_low = ? AND user_high = ?`)
      .run(low!, high!);
    this.tellFriends(userId, otherId);
  }

  count(): number {
    return countOf(this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_bot = 0"));
  }

  create(input: {
    handle: string;
    displayName: string;
    passwordHash: string;
    salt: string;
    role: Role;
  }): User {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO users (id, handle, display_name, password_hash, salt, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.handle, input.displayName, input.passwordHash, input.salt, input.role, now);
    return this.get(id)!;
  }

  get(id: ID): User | null {
    const r = userRow.get(this.db.prepare("SELECT * FROM users WHERE id = ?"), id);
    return r ? toUser(r) : null;
  }

  authByHandle(handle: string): (User & { passwordHash: string; salt: string }) | null {
    const r = userRow.get(this.db.prepare("SELECT * FROM users WHERE handle = ?"), handle);
    if (!r) return null;
    return { ...toUser(r), passwordHash: r.password_hash, salt: r.salt };
  }

  list(): User[] {
    return userRow.all(this.db.prepare("SELECT * FROM users ORDER BY handle")).map(toUser);
  }

  /** The accounts whose status was to clear itself by `now`. */
  expiredStatusUserIds(now: number): ID[] {
    return idRow
      .all(
        this.db.prepare(
          "SELECT id FROM users WHERE status_expires_at IS NOT NULL AND status_expires_at <= ?",
        ),
        now,
      )
      .map((row) => row.id);
  }

  /** When the next status clears itself, or null when none will. */
  nextStatusExpiry(): number | null {
    return nextExpiryRow.get(
      this.db.prepare(
        "SELECT MIN(status_expires_at) AS next FROM users WHERE status_expires_at IS NOT NULL",
      ),
    )!.next;
  }

  /** The explicit member grant, independent of permission conferred by an admin role. */
  invitePermission(id: ID): boolean {
    return (
      canInviteRow.get(this.db.prepare("SELECT can_invite FROM users WHERE id = ?"), id)
        ?.can_invite === 1
    );
  }

  update(
    id: ID,
    patch: {
      displayName?: string;
      statusText?: string;
      statusEmoji?: string;
      statusExpiresAt?: number | null;
      dndUntil?: number | null;
      role?: Role;
      deactivated?: boolean;
      canInvite?: boolean;
      timeZone?: string | null;
      away?: boolean;
    },
  ): User {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    if (patch.displayName !== undefined) {
      sets.push("display_name = ?");
      params.push(patch.displayName);
    }
    if (patch.statusText !== undefined) {
      sets.push("status_text = ?");
      params.push(patch.statusText);
    }
    if (patch.statusEmoji !== undefined) {
      sets.push("status_emoji = ?");
      params.push(patch.statusEmoji);
    }
    if (patch.statusExpiresAt !== undefined) {
      sets.push("status_expires_at = ?");
      params.push(patch.statusExpiresAt);
    }
    if (patch.dndUntil !== undefined) {
      sets.push("dnd_until = ?");
      params.push(patch.dndUntil);
    }
    if (patch.role !== undefined) {
      sets.push("role = ?");
      params.push(patch.role);
    }
    if (patch.deactivated !== undefined) {
      sets.push("deactivated = ?");
      params.push(patch.deactivated ? 1 : 0);
    }
    if (patch.canInvite !== undefined) {
      sets.push("can_invite = ?");
      params.push(patch.canInvite ? 1 : 0);
    }
    if (patch.timeZone !== undefined) {
      sets.push("time_zone = ?");
      params.push(patch.timeZone);
    }
    if (patch.away !== undefined) {
      sets.push("away = ?");
      params.push(patch.away ? 1 : 0);
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    }
    // What this account scheduled while deactivated can go at the next flush.
    if (patch.deactivated === false) this.store.scheduled.wakeHeld({ userId: id });
    return this.get(id)!;
  }

  /** Whether this account set itself away by hand (E9). */
  isAway(userId: ID): boolean {
    return awayRow.get(this.db.prepare("SELECT away FROM users WHERE id = ?"), userId)?.away === 1;
  }

  avatar(userId: ID): { type: string; bytes: Buffer; version: string } | null {
    const row = avatarRow.get(
      this.db.prepare(
        `SELECT a.type, a.bytes, u.avatar_version FROM user_avatars a
         JOIN users u ON u.id = a.user_id WHERE a.user_id = ?`,
      ),
      userId,
    );
    if (!row?.avatar_version) return null;
    return { type: row.type, bytes: Buffer.from(row.bytes), version: row.avatar_version };
  }

  /** Keeps a new profile picture for an account, or with null removes it; gives the user. */
  setAvatar(userId: ID, picture: { type: string; bytes: Buffer; version: string } | null): User {
    if (picture) {
      this.db
        .prepare(
          `INSERT INTO user_avatars (user_id, type, bytes) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET type = excluded.type, bytes = excluded.bytes`,
        )
        .run(userId, picture.type, picture.bytes);
    } else this.db.prepare("DELETE FROM user_avatars WHERE user_id = ?").run(userId);
    this.db
      .prepare("UPDATE users SET avatar_version = ? WHERE id = ?")
      .run(picture?.version ?? null, userId);
    return this.get(userId)!;
  }

  /** When each account was last seen, for the admin list. */
  lastSeenByUser(): Record<ID, number> {
    const rows = lastSeenRow.all(
      this.db.prepare("SELECT user_id, MAX(last_seen_at) AS seen FROM sessions GROUP BY user_id"),
    );
    return Object.fromEntries(rows.map((r) => [r.user_id, r.seen]));
  }

  isGuest(userId: ID): boolean {
    return (
      roleRow.get(this.db.prepare("SELECT role FROM users WHERE id = ?"), userId)?.role === "guest"
    );
  }
}
