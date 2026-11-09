import type { Friendship, ID, MessageReport, ReportReason, Role, User } from "@ownbase/protocol";
import { isAdministrator } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { ulid } from "../ids.js";
import type { Store } from "../store.js";

export interface UserRow {
  id: string;
  handle: string;
  display_name: string;
  password_hash: string;
  salt: string;
  role: string;
  status_text: string;
  status_emoji: string;
  status_expires_at?: number | null;
  is_bot: number;
  deactivated: number;
  dnd_until: number | null;
  created_at: number;
  can_invite?: number;
  time_zone?: string | null;
  away?: number;
  avatar_version?: string | null;
}

export function toUser(r: UserRow): User {
  return {
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    role: r.role as Role,
    statusText: r.status_text,
    statusEmoji: r.status_emoji,
    ...(r.status_expires_at != null ? { statusExpiresAt: r.status_expires_at } : {}),
    isBot: r.is_bot === 1,
    deactivated: r.deactivated === 1,
    dndUntil: r.dnd_until,
    createdAt: r.created_at,
    canInvite: mayInvite(r.role as Role, r.is_bot, r.can_invite),
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

/** People: accounts as others see them, their profiles and pictures, friends, blocks and the reports they make. */
export class PeopleStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

  friends(userId: ID): Friendship[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM friendships WHERE user_low = ? OR user_high = ? ORDER BY created_at DESC`,
      )
      .all(userId, userId) as unknown as {
      user_low: string;
      user_high: string;
      requested_by: string;
      accepted: number;
      created_at: number;
    }[];
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
    const rows = this.db
      .prepare(
        "SELECT blocked_id FROM user_blocks WHERE user_id = ? ORDER BY created_at, blocked_id",
      )
      .all(userId) as { blocked_id: string }[];
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

  /** Keeps someone's report of a message; false when they have one open for it already. */
  report(messageId: ID, reporterId: ID, reason: string, note: string): boolean {
    const kept =
      this.db
        .prepare(
          `INSERT OR IGNORE INTO message_reports (id, message_id, reporter_id, reason, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(ulid(), messageId, reporterId, reason, note, Date.now()).changes === 1;
    if (kept) this.tellOpenReports();
    return kept;
  }

  private tellOpenReports(): void {
    this.store.outbox.admins("reports", () => ({ type: "reports", open: this.openReportCount() }));
  }

  /** How many reported messages wait for an admin. */
  openReportCount(): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(DISTINCT message_id) AS n FROM message_reports WHERE resolved_at IS NULL",
        )
        .get() as { n: number }
    ).n;
  }

  /**
   * The reported messages waiting for an admin, the longest waiting first,
   * each with where it was posted, who wrote it (known after its author
   * deleted it too) and its open reports in the order they came.
   */
  openReports(): { messageId: ID; channelId: ID; authorId: ID; reports: MessageReport[] }[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.message_id, r.reporter_id, r.reason, r.note, r.created_at,
           m.channel_id, m.user_id AS author_id
         FROM message_reports r JOIN messages m ON m.id = r.message_id
         WHERE r.resolved_at IS NULL ORDER BY r.created_at, r.id`,
      )
      .all() as {
      id: string;
      message_id: string;
      reporter_id: string;
      reason: string;
      note: string;
      created_at: number;
      channel_id: string;
      author_id: string;
    }[];
    const byMessage = new Map<
      ID,
      { messageId: ID; channelId: ID; authorId: ID; reports: MessageReport[] }
    >();
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
        reason: row.reason as ReportReason,
        note: row.note,
        createdAt: row.created_at,
      });
      byMessage.set(row.message_id, held);
    }
    return [...byMessage.values()];
  }

  /** Closes a message's open reports as an admin resolved them; how many there were. */
  resolveReports(messageId: ID, adminId: ID, resolution: string): number {
    const resolved = this.db
      .prepare(
        `UPDATE message_reports SET resolved_at = ?, resolved_by = ?, resolution = ?
         WHERE message_id = ? AND resolved_at IS NULL`,
      )
      .run(Date.now(), adminId, resolution, messageId).changes as number;
    if (resolved > 0) this.tellOpenReports();
    return resolved;
  }

  removeFriend(userId: ID, otherId: ID): void {
    const [low, high] = [userId, otherId].sort();
    this.db
      .prepare(`DELETE FROM friendships WHERE user_low = ? AND user_high = ?`)
      .run(low!, high!);
    this.tellFriends(userId, otherId);
  }

  count(): number {
    const r = this.db.prepare("SELECT COUNT(*) c FROM users WHERE is_bot = 0").get() as {
      c: number;
    };
    return r.c;
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
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  authByHandle(handle: string): (User & { passwordHash: string; salt: string }) | null {
    const r = this.db.prepare("SELECT * FROM users WHERE handle = ?").get(handle) as
      UserRow | undefined;
    if (!r) return null;
    return { ...toUser(r), passwordHash: r.password_hash, salt: r.salt };
  }

  list(): User[] {
    const rows = this.db
      .prepare("SELECT * FROM users ORDER BY handle")
      .all() as unknown as UserRow[];
    return rows.map(toUser);
  }

  /** The accounts whose status was to clear itself by `now`. */
  expiredStatusUserIds(now: number): ID[] {
    return (
      this.db
        .prepare(
          "SELECT id FROM users WHERE status_expires_at IS NOT NULL AND status_expires_at <= ?",
        )
        .all(now) as { id: string }[]
    ).map((row) => row.id);
  }

  /** When the next status clears itself, or null when none will. */
  nextStatusExpiry(): number | null {
    const row = this.db
      .prepare(
        "SELECT MIN(status_expires_at) AS next FROM users WHERE status_expires_at IS NOT NULL",
      )
      .get() as { next: number | null } | undefined;
    return row?.next ?? null;
  }

  /** The explicit member grant, independent of permission conferred by an admin role. */
  invitePermission(id: ID): boolean {
    return this.db.prepare("SELECT can_invite FROM users WHERE id = ?").get(id)?.can_invite === 1;
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
    const params: unknown[] = [];
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
      this.db
        .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
        .run(...(params as (string | number | null)[]), id);
    }
    // What this account scheduled while deactivated can go at the next flush.
    if (patch.deactivated === false) this.store.scheduled.wakeHeld({ userId: id });
    return this.get(id)!;
  }

  /** Whether this account set itself away by hand (E9). */
  isAway(userId: ID): boolean {
    return this.db.prepare("SELECT away FROM users WHERE id = ?").get(userId)?.away === 1;
  }

  /** One account's profile picture, or null for none (E9). */
  avatar(userId: ID): { type: string; bytes: Buffer; version: string } | null {
    const row = this.db
      .prepare(
        `SELECT a.type, a.bytes, u.avatar_version FROM user_avatars a
         JOIN users u ON u.id = a.user_id WHERE a.user_id = ?`,
      )
      .get(userId) as
      { type: string; bytes: Uint8Array; avatar_version: string | null } | undefined;
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
    const rows = this.db
      .prepare("SELECT user_id, MAX(last_seen_at) AS seen FROM sessions GROUP BY user_id")
      .all() as unknown as { user_id: string; seen: number }[];
    return Object.fromEntries(rows.map((r) => [r.user_id, r.seen]));
  }

  isGuest(userId: ID): boolean {
    return this.db.prepare("SELECT role FROM users WHERE id = ?").get(userId)?.role === "guest";
  }
}
