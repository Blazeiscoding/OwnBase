import type { DatabaseSync } from "node:sqlite";
import type {
  App,
  CallNotice,
  Channel,
  ChannelPrefs,
  ChannelType,
  FileMeta,
  Friendship,
  ID,
  Invite,
  InviteStatus,
  AuditAction,
  AuditEntry,
  AuditTargetType,
  Message,
  MessageAction,
  ReactionGroup,
  ForwardReference,
  FileKind,
  LinkPreview,
  Poll,
  ReplyReference,
  SharedFile,
  SidebarSection,
  NotifyLevel,
  ParsedSearch,
  Role,
  ScheduledMessage,
  SessionInfo,
  ThreadFollow,
  Reminder,
  ReminderItem,
  FollowedThread,
  User,
  EventSubscription,
  SlashCommand,
  Webhook,
  WorkspaceEvent,
  EventEnvelope,
  MessageReport,
  ReportReason,
} from "@ownbase/protocol";
import { APP_SCOPES, FILE_KIND_TYPES, FILE_TYPE_MATCH, replyExcerpt } from "@ownbase/protocol";
import type { AppScope } from "@ownbase/protocol";
import { ulid, orderedUlid, inviteCode } from "./ids.js";

/** Known scopes only, each once, in one order, so two lists compare as text. */
function scopeList(scopes: readonly unknown[]): AppScope[] {
  return APP_SCOPES.filter((scope) => scopes.includes(scope));
}

/** A stored JSON list, or empty when it is missing or not a list. */
function parseJsonArray(text: string | undefined): unknown[] {
  try {
    const value: unknown = JSON.parse(text ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
import { previewLinks, type FetchedPreview } from "./linkPreview.js";

interface UserRow {
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

interface ChannelRow {
  id: string;
  type: string;
  name: string;
  topic: string;
  description: string;
  creator_id: string;
  archived: number;
  dm_key: string | null;
  last_msg_seq: number;
  created_at: number;
}

/**
 * What belongs in a channel's own timeline: top-level messages, plus the thread
 * replies whose authors chose to send them to the channel too. Defined once so
 * paging, jumping and the live tail cannot drift apart on what a channel holds.
 */
const IN_CHANNEL_TIMELINE = "(thread_root_id IS NULL OR broadcast = 1)";

interface MessageRow {
  id: string;
  channel_id: string;
  user_id: string;
  text: string;
  thread_root_id: string | null;
  broadcast: number;
  nonce: string | null;
  seq: number;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  actions: string;
  reply_to_id: string | null;
  reply_ping: number;
  forwarded_from_id: string | null;
  /** A note the server left about a call (E10); absent from rows read without it. */
  call_kind?: string | null;
}

/** A reminder's row beside its message's conversation and thread. */
interface ReminderRow {
  id: string;
  user_id: string;
  message_id: string;
  remind_at: number;
  due_at: number | null;
  channel_id: string;
  thread_root_id: string | null;
}

/**
 * Buttons come back out of one JSON column. A row written by a future version,
 * or corrupted somehow, costs its buttons rather than the whole message.
 */
function parseActions(raw: string | null): MessageAction[] {
  if (!raw || raw === "[]") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MessageAction[]) : [];
  } catch {
    return [];
  }
}

/** True for the user bound as the next parameter when that user is a guest. */
const GUEST_SQL = "EXISTS (SELECT 1 FROM users g WHERE g.id = ? AND g.role = 'guest')";

function toUser(r: UserRow): User {
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
    canInvite: mayInvite(r.role, r.is_bot, r.can_invite),
    ...(r.time_zone ? { timeZone: r.time_zone } : {}),
    ...(r.away === 1 ? { away: true as const } : {}),
    ...(r.avatar_version ? { avatarVersion: r.avatar_version } : {}),
  };
}

/** One member's own choices for a conversation, as `channel_members` keeps them. */
type PrefsRow = {
  notify_level: string;
  muted: number;
  starred: number;
  section_id: string | null;
};

function toPrefs(r: PrefsRow): ChannelPrefs {
  return {
    notifyLevel: r.notify_level as NotifyLevel,
    muted: r.muted === 1,
    starred: r.starred === 1,
    sectionId: r.section_id,
  };
}

/**
 * The one rule for who may create invite codes, used for the flag clients see
 * and for the codes a creator has already handed out. An app never may.
 */
function mayInvite(role: string, isBot: number, canInvite: number | undefined | null): boolean {
  if (isBot === 1) return false;
  return role === "owner" || role === "admin" || canInvite === 1;
}

/** How long a session survives without being used. */
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

export class Store {
  constructor(private db: DatabaseSync) {}

  /** Only synchronous database work belongs here; publish events after this returns. */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  messageRequest(userId: ID, nonce: string): { messageId: ID; requestHash: string | null } | null {
    return (
      (this.db
        .prepare(
          "SELECT message_id AS messageId, request_hash AS requestHash FROM message_requests WHERE user_id = ? AND nonce = ?",
        )
        .get(userId, nonce) as { messageId: ID; requestHash: string | null } | undefined) ?? null
    );
  }

  /** Whether this key sent a message retention has since removed; see `purgeMessagesBefore`. */
  messageRequestPurged(userId: ID, nonce: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM purged_message_requests WHERE user_id = ? AND nonce = ?")
      .get(userId, nonce);
  }

  /** Forgets the keys of removed messages posted before `before`. */
  pruneMessageRequestsPurged(before: number): number {
    return Number(
      this.db.prepare("DELETE FROM purged_message_requests WHERE sent_at < ?").run(before).changes,
    );
  }

  recordMessageRequest(userId: ID, nonce: string, messageId: ID, requestHash: string): void {
    this.db
      .prepare(
        "INSERT INTO message_requests (user_id, nonce, message_id, request_hash) VALUES (?, ?, ?, ?)",
      )
      .run(userId, nonce, messageId, requestHash);
  }

  listFriends(userId: ID): Friendship[] {
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
  }

  acceptFriend(userId: ID, otherId: ID): boolean {
    const [low, high] = [userId, otherId].sort();
    return (
      this.db
        .prepare(
          `UPDATE friendships SET accepted = 1 WHERE user_low = ? AND user_high = ? AND requested_by = ?`,
        )
        .run(low!, high!, otherId).changes > 0
    );
  }

  // ---------- blocks and reports (E12) ----------

  /** The people this account blocked, oldest first. */
  blockedIds(userId: ID): ID[] {
    const rows = this.db
      .prepare(
        "SELECT blocked_id FROM user_blocks WHERE user_id = ? ORDER BY created_at, blocked_id",
      )
      .all(userId) as { blocked_id: string }[];
    return rows.map((row) => row.blocked_id);
  }

  /** Blocks or unblocks someone for this account; whether anything changed. */
  setBlocked(userId: ID, otherId: ID, blocked: boolean): boolean {
    return (
      (blocked
        ? this.db
            .prepare(
              "INSERT OR IGNORE INTO user_blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)",
            )
            .run(userId, otherId, Date.now())
        : this.db
            .prepare("DELETE FROM user_blocks WHERE user_id = ? AND blocked_id = ?")
            .run(userId, otherId)
      ).changes === 1
    );
  }

  /** Keeps someone's report of a message; false when they have one open for it already. */
  reportMessage(messageId: ID, reporterId: ID, reason: string, note: string): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO message_reports (id, message_id, reporter_id, reason, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(ulid(), messageId, reporterId, reason, note, Date.now()).changes === 1
    );
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
    return this.db
      .prepare(
        `UPDATE message_reports SET resolved_at = ?, resolved_by = ?, resolution = ?
         WHERE message_id = ? AND resolved_at IS NULL`,
      )
      .run(Date.now(), adminId, resolution, messageId).changes as number;
  }

  removeFriend(userId: ID, otherId: ID): void {
    const [low, high] = [userId, otherId].sort();
    this.db
      .prepare(`DELETE FROM friendships WHERE user_low = ? AND user_high = ?`)
      .run(low!, high!);
  }

  // ---------- meta ----------

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  /** Every meta key starting with `prefix`, in key order. */
  listMeta(prefix: string): { key: string; value: string }[] {
    return this.db
      .prepare("SELECT key, value FROM meta WHERE substr(key, 1, ?) = ? ORDER BY key")
      .all(prefix.length, prefix) as { key: string; value: string }[];
  }

  // ---------- users ----------

  userCount(): number {
    const r = this.db.prepare("SELECT COUNT(*) c FROM users WHERE is_bot = 0").get() as {
      c: number;
    };
    return r.c;
  }

  createUser(input: {
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
    return this.getUser(id)!;
  }

  getUser(id: ID): User | null {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  getUserAuthByHandle(handle: string): (User & { passwordHash: string; salt: string }) | null {
    const r = this.db.prepare("SELECT * FROM users WHERE handle = ?").get(handle) as
      UserRow | undefined;
    if (!r) return null;
    return { ...toUser(r), passwordHash: r.password_hash, salt: r.salt };
  }

  listUsers(): User[] {
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
  getMemberInvitePermission(id: ID): boolean {
    return this.db.prepare("SELECT can_invite FROM users WHERE id = ?").get(id)?.can_invite === 1;
  }

  updateUser(
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
    if (patch.deactivated === false) this.wakeHeldScheduled({ userId: id });
    return this.getUser(id)!;
  }

  /**
   * An account's two-step sign-in (E11): its authenticator key, or null for
   * none; the last time step a code was accepted for; and how many recovery
   * codes it has left.
   */
  twoStep(userId: ID): { secret: string | null; step: number | null; codesLeft: number } {
    const row = this.db
      .prepare(
        `SELECT two_step_secret, two_step_step,
           (SELECT COUNT(*) FROM two_step_codes c WHERE c.user_id = u.id AND c.used_at IS NULL)
             AS codes_left
         FROM users u WHERE id = ?`,
      )
      .get(userId) as
      | { two_step_secret: string | null; two_step_step: number | null; codes_left: number }
      | undefined;
    return {
      secret: row?.two_step_secret ?? null,
      step: row?.two_step_step ?? null,
      codesLeft: row?.codes_left ?? 0,
    };
  }

  /** The accounts with two-step sign-in on, for the admins' list (E11). */
  twoStepUserIds(): Set<ID> {
    const rows = this.db
      .prepare("SELECT id FROM users WHERE two_step_secret IS NOT NULL")
      .all() as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Turns two-step sign-in on with this key, the step its first code was for,
   * and new codes. Call inside a transaction.
   */
  enableTwoStep(userId: ID, secret: string, step: number, codeHashes: string[]): void {
    this.db
      .prepare("UPDATE users SET two_step_secret = ?, two_step_step = ? WHERE id = ?")
      .run(secret, step, userId);
    this.replaceRecoveryCodes(userId, codeHashes);
  }

  /**
   * Turns two-step sign-in off, its key and every recovery code gone. Whether
   * it was on. Call inside a transaction.
   */
  disableTwoStep(userId: ID): boolean {
    const was = this.db
      .prepare(
        "UPDATE users SET two_step_secret = NULL, two_step_step = NULL WHERE id = ? AND two_step_secret IS NOT NULL",
      )
      .run(userId).changes;
    this.db.prepare("DELETE FROM two_step_codes WHERE user_id = ?").run(userId);
    return was === 1;
  }

  /** Remembers the time step a code was just accepted for, so it cannot be used again. */
  useTwoStepStep(userId: ID, step: number): void {
    this.db.prepare("UPDATE users SET two_step_step = ? WHERE id = ?").run(step, userId);
  }

  /** A new set of recovery codes, by their hashes, in place of any before. Call inside a transaction. */
  replaceRecoveryCodes(userId: ID, codeHashes: string[]): void {
    this.db.prepare("DELETE FROM two_step_codes WHERE user_id = ?").run(userId);
    const add = this.db.prepare("INSERT INTO two_step_codes (user_id, code_hash) VALUES (?, ?)");
    for (const hash of codeHashes) add.run(userId, hash);
  }

  /** Uses up a recovery code; false for one that is not this account's, or already used. */
  useRecoveryCode(userId: ID, codeHash: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE two_step_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
        )
        .run(Date.now(), userId, codeHash).changes === 1
    );
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
    return this.getUser(userId)!;
  }

  // ---------- sessions ----------

  createSession(tokenHash: string, userId: ID, userAgent = "", ttlMs = SESSION_TTL_MS): ID {
    const now = Date.now();
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, id, user_agent, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(tokenHash, userId, now, now, id, userAgent.slice(0, 200), now + ttlMs);
    return id;
  }

  /**
   * The account behind a token, if the session is still alive.
   *
   * Expiry slides forward on every use: a session in daily use never asks its
   * owner to sign in again, while one abandoned on a borrowed machine stops
   * working on its own. A guest's does not: it ends when it said it would.
   */
  getSessionUser(tokenHash: string, ttlMs = SESSION_TTL_MS): User | null {
    const now = Date.now();
    const r = this.db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND u.deactivated = 0 AND s.expires_at > ?`,
      )
      .get(tokenHash, now) as UserRow | undefined;
    if (!r) return null;
    if (r.role === "guest")
      this.db
        .prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
        .run(now, tokenHash);
    else
      this.db
        .prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
        .run(now, now + ttlMs, tokenHash);
    return toUser(r);
  }

  /** How many guests are signed in now, which bounds how many more are let in. */
  liveGuestSessions(now = Date.now()): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) c FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE u.role = 'guest' AND s.expires_at > ?`,
      )
      .get(now) as { c: number };
    return r.c;
  }

  /**
   * Everyone a new public channel takes in: active people, not apps, and a
   * guest only while still signed in, since an ended guest never comes back.
   */
  listPeopleIds(now = Date.now()): ID[] {
    const rows = this.db
      .prepare(
        `SELECT u.id FROM users u
         WHERE u.deactivated = 0 AND u.is_bot = 0
           AND (u.role != 'guest' OR EXISTS (
             SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?))
         ORDER BY u.id`,
      )
      .all(now) as { id: ID }[];
    return rows.map((r) => r.id);
  }

  /** Ends every guest's session, reporting the tokens so their sockets close too. */
  revokeGuestSessions(): string[] {
    const where = "user_id IN (SELECT id FROM users WHERE role = 'guest')";
    const rows = this.db
      .prepare(`SELECT token_hash FROM sessions WHERE ${where}`)
      .all() as unknown as { token_hash: string }[];
    this.db.prepare(`DELETE FROM sessions WHERE ${where}`).run();
    return rows.map((r) => r.token_hash);
  }

  /**
   * A guest keeping their identity as an ordinary member: the same id, so what
   * they wrote and where they are stay theirs, now with a handle and password.
   * Their sessions are the caller's to replace.
   */
  convertGuest(id: ID, handle: string, passwordHash: string, salt: string): User {
    this.db
      .prepare(
        `UPDATE users SET handle = ?, password_hash = ?, salt = ?, role = 'member'
         WHERE id = ? AND role = 'guest'`,
      )
      .run(handle, passwordHash, salt, id);
    return this.getUser(id)!;
  }

  /** One person's signed-in devices, newest first. */
  listSessions(userId: ID): Omit<SessionInfo, "current">[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, last_seen_at, expires_at, user_agent FROM sessions
         WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`,
      )
      .all(userId, Date.now()) as unknown as {
      id: string;
      created_at: number;
      last_seen_at: number;
      expires_at: number;
      user_agent: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      userAgent: r.user_agent,
    }));
  }

  /**
   * Ends sessions and reports which tokens they were, so their live sockets can
   * be closed too. A revoked session that keeps receiving messages is not revoked.
   */
  revokeSessions(userId: ID, opts: { id?: ID; exceptTokenHash?: string } = {}): string[] {
    const where = ["user_id = ?"];
    const params: string[] = [userId];
    if (opts.id !== undefined) {
      where.push("id = ?");
      params.push(opts.id);
    }
    if (opts.exceptTokenHash !== undefined) {
      where.push("token_hash != ?");
      params.push(opts.exceptTokenHash);
    }
    const clause = where.join(" AND ");
    const rows = this.db
      .prepare(`SELECT token_hash FROM sessions WHERE ${clause}`)
      .all(...params) as unknown as { token_hash: string }[];
    this.db.prepare(`DELETE FROM sessions WHERE ${clause}`).run(...params);
    return rows.map((r) => r.token_hash);
  }

  /** The listable id of the session behind a token, so it can mark itself. */
  sessionIdFor(tokenHash: string): ID | null {
    const r = this.db.prepare("SELECT id FROM sessions WHERE token_hash = ?").get(tokenHash) as
      { id: string } | undefined;
    return r?.id ?? null;
  }

  /** Drops sessions nobody can use any more. */
  pruneSessions(now = Date.now()): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  /** Checks a live socket without extending a session merely for receiving traffic. */
  isSessionActive(tokenHash: string, userId: ID): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ? AND u.deactivated = 0`,
        )
        .get(tokenHash, userId, Date.now()) !== undefined
    );
  }

  /**
   * Signs someone out everywhere. Deactivating an account has to do this:
   * a token already in someone's hands keeps working otherwise, which is
   * exactly the case deactivation exists for.
   */
  deleteSessionsFor(userId: ID): number {
    return this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes as number;
  }

  /** Replaces someone's password. Their sessions are the caller's to revoke. */
  /**
   * `mustChange` marks a password someone else chose. Until its owner replaces
   * it, the account can do nothing else, so a temporary password read out over
   * the phone cannot quietly become a permanent one.
   */
  setPassword(userId: ID, passwordHash: string, salt: string, mustChange = false): void {
    this.db
      .prepare(
        "UPDATE users SET password_hash = ?, salt = ?, must_change_password = ? WHERE id = ?",
      )
      .run(passwordHash, salt, mustChange ? 1 : 0, userId);
  }

  mustChangePassword(userId: ID): boolean {
    const row = this.db
      .prepare("SELECT must_change_password FROM users WHERE id = ?")
      .get(userId) as { must_change_password: number } | undefined;
    return row?.must_change_password === 1;
  }

  /** When each account was last seen, for the admin list. */
  lastSeenByUser(): Record<ID, number> {
    const rows = this.db
      .prepare("SELECT user_id, MAX(last_seen_at) AS seen FROM sessions GROUP BY user_id")
      .all() as unknown as { user_id: string; seen: number }[];
    return Object.fromEntries(rows.map((r) => [r.user_id, r.seen]));
  }

  // ---------- channels ----------

  /**
   * `people`, when given, holds the managers and conversation members of every
   * channel being listed, read once, in place of a query for each one.
   */
  private toChannel(
    r: ChannelRow,
    people?: { managers: Map<ID, ID[]>; members: Map<ID, ID[]> },
  ): Channel {
    const ch: Channel = {
      id: r.id,
      type: r.type as ChannelType,
      name: r.name,
      topic: r.topic,
      description: r.description,
      creatorId: r.creator_id,
      archived: r.archived === 1,
      createdAt: r.created_at,
    };
    if (ch.type === "dm" || ch.type === "group_dm") {
      ch.memberIds = people ? (people.members.get(r.id) ?? []) : this.memberIds(r.id);
    } else if (people) {
      ch.managerIds = people.managers.get(r.id) ?? [];
    } else {
      ch.managerIds = (
        this.db
          .prepare(
            "SELECT user_id FROM channel_members WHERE channel_id = ? AND is_manager = 1 ORDER BY user_id",
          )
          .all(r.id) as { user_id: ID }[]
      ).map((m) => m.user_id);
    }
    return ch;
  }

  createChannel(input: {
    type: ChannelType;
    name?: string;
    topic?: string;
    description?: string;
    creatorId: ID;
    memberIds: ID[]; // including creator
    dmKey?: string;
  }): Channel {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO channels (id, type, name, topic, description, creator_id, dm_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.name ?? "",
        input.topic ?? "",
        input.description ?? "",
        input.creatorId,
        input.dmKey ?? null,
        now,
      );
    const level: NotifyLevel =
      input.type === "dm" || input.type === "group_dm" ? "all" : "mentions";
    for (const uid of input.memberIds) this.addMember(id, uid, level);
    return this.getChannel(id)!;
  }

  getChannel(id: ID): Channel | null {
    const r = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as
      ChannelRow | undefined;
    return r ? this.toChannel(r) : null;
  }

  getChannelByName(name: string): Channel | null {
    const r = this.db
      .prepare("SELECT * FROM channels WHERE name = ? AND type IN ('public','private')")
      .get(name) as ChannelRow | undefined;
    return r ? this.toChannel(r) : null;
  }

  findDmByKey(dmKey: string): Channel | null {
    const r = this.db.prepare("SELECT * FROM channels WHERE dm_key = ?").get(dmKey) as
      ChannelRow | undefined;
    return r ? this.toChannel(r) : null;
  }

  retireDmKey(channelId: ID): void {
    this.db
      .prepare("UPDATE channels SET dm_key = NULL WHERE id = ? AND type = 'group_dm'")
      .run(channelId);
  }

  updateChannel(
    id: ID,
    patch: { name?: string; topic?: string; description?: string; archived?: boolean },
  ): Channel {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      params.push(patch.name);
    }
    if (patch.topic !== undefined) {
      sets.push("topic = ?");
      params.push(patch.topic);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      params.push(patch.description);
    }
    if (patch.archived !== undefined) {
      sets.push("archived = ?");
      params.push(patch.archived ? 1 : 0);
    }
    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`)
        .run(...(params as string[]), id);
    }
    // Messages waiting for this channel to reopen can go at the next flush.
    if (patch.archived === false) this.wakeHeldScheduled({ channelId: id });
    return this.getChannel(id)!;
  }

  /** Public channels + non-public channels the user belongs to; a guest, public only. */
  listChannelsVisibleTo(userId: ID): Channel[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.* FROM channels c
         LEFT JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
         WHERE c.type = 'public' OR (m.user_id IS NOT NULL AND NOT ${GUEST_SQL})
         ORDER BY c.name`,
      )
      .all(userId, userId) as unknown as ChannelRow[];
    // Every handshake lists these, so who manages each channel and who is in
    // each conversation are read once for all of them (OPT-13).
    const group = (pairs: { channel_id: ID; user_id: ID }[]) => {
      const out = new Map<ID, ID[]>();
      for (const { channel_id, user_id } of pairs) {
        const list = out.get(channel_id);
        if (list) list.push(user_id);
        else out.set(channel_id, [user_id]);
      }
      return out;
    };
    const managers = group(
      this.db
        .prepare(
          `SELECT channel_id, user_id FROM channel_members WHERE is_manager = 1
           ORDER BY channel_id, user_id`,
        )
        .all() as { channel_id: ID; user_id: ID }[],
    );
    const members = group(
      this.db
        .prepare(
          `SELECT m.channel_id, m.user_id FROM channel_members mine
           JOIN channels c ON c.id = mine.channel_id AND c.type IN ('dm', 'group_dm')
           JOIN channel_members m ON m.channel_id = mine.channel_id
           WHERE mine.user_id = ?
           ORDER BY m.channel_id, m.user_id`,
        )
        .all(userId) as { channel_id: ID; user_id: ID }[],
    );
    return rows.map((r) => this.toChannel(r, { managers, members }));
  }

  listPublicChannelIds(): ID[] {
    const rows = this.db.prepare("SELECT id FROM channels WHERE type = 'public'").all() as {
      id: string;
    }[];
    return rows.map((r) => r.id);
  }

  // ---------- membership ----------

  addMember(channelId: ID, userId: ID, notifyLevel: NotifyLevel = "mentions"): boolean {
    // Replies written before joining are not this member's to catch up on,
    // any more than they were theirs to be told about.
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_members
           (channel_id, user_id, joined_at, notify_level, replies_read_seq)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(channelId, userId, Date.now(), notifyLevel, this.currentSeq());
    if (res.changes > 0) this.wakeHeldScheduled({ channelId, userId });
    return res.changes > 0;
  }

  removeMember(channelId: ID, userId: ID): boolean {
    const res = this.db
      .prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
      .run(channelId, userId);
    if (res.changes > 0) this.retireDmKey(channelId);
    return res.changes > 0;
  }

  isMember(channelId: ID, userId: ID): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?")
      .get(channelId, userId);
  }

  setChannelManager(channelId: ID, userId: ID, manager: boolean): boolean {
    return (
      this.db
        .prepare(
          "UPDATE channel_members SET is_manager = ? WHERE channel_id = ? AND user_id = ? AND is_manager != ?",
        )
        .run(manager ? 1 : 0, channelId, userId, manager ? 1 : 0).changes > 0
    );
  }

  memberIds(channelId: ID): ID[] {
    const rows = this.db
      .prepare("SELECT user_id FROM channel_members WHERE channel_id = ?")
      .all(channelId) as { user_id: string }[];
    return rows.map((r) => r.user_id);
  }

  memberships(userId: ID): {
    channelId: ID;
    lastReadSeq: number;
    repliesReadSeq: number;
    prefs: ChannelPrefs;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT channel_id, last_read_seq, replies_read_seq, notify_level, muted, starred,
                section_id
         FROM channel_members WHERE user_id = ?`,
      )
      .all(userId) as ({
      channel_id: string;
      last_read_seq: number;
      replies_read_seq: number;
    } & PrefsRow)[];
    return rows.map((r) => ({
      channelId: r.channel_id,
      lastReadSeq: r.last_read_seq,
      repliesReadSeq: r.replies_read_seq,
      prefs: toPrefs(r),
    }));
  }

  getChannelPrefs(channelId: ID, userId: ID): ChannelPrefs | null {
    const r = this.db
      .prepare(
        `SELECT notify_level, muted, starred, section_id FROM channel_members
         WHERE channel_id = ? AND user_id = ?`,
      )
      .get(channelId, userId) as PrefsRow | undefined;
    return r ? toPrefs(r) : null;
  }

  setChannelPrefs(
    channelId: ID,
    userId: ID,
    patch: {
      notifyLevel?: NotifyLevel;
      muted?: boolean;
      starred?: boolean;
      sectionId?: ID | null;
    },
  ): ChannelPrefs | null {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.notifyLevel !== undefined) {
      sets.push("notify_level = ?");
      params.push(patch.notifyLevel);
    }
    if (patch.muted !== undefined) {
      sets.push("muted = ?");
      params.push(patch.muted ? 1 : 0);
    }
    // One place each, as Slack keeps them: a star takes a conversation out of
    // its section, and a section takes its star (E8).
    const starred = patch.sectionId ? false : patch.starred;
    const sectionId = patch.starred ? null : patch.sectionId;
    if (starred !== undefined) {
      sets.push("starred = ?");
      params.push(starred ? 1 : 0);
    }
    if (sectionId !== undefined) {
      sets.push("section_id = ?");
      params.push(sectionId);
    }
    if (sets.length > 0) {
      this.db
        .prepare(
          `UPDATE channel_members SET ${sets.join(", ")} WHERE channel_id = ? AND user_id = ?`,
        )
        .run(...params, channelId, userId);
    }
    return this.getChannelPrefs(channelId, userId);
  }

  // ---------- sidebar sections (E8) ----------

  /** One account's sidebar sections, in its order. */
  sidebarSections(userId: ID): SidebarSection[] {
    return this.db
      .prepare(
        "SELECT id, name FROM sidebar_sections WHERE user_id = ? ORDER BY position, created_at, id",
      )
      .all(userId) as unknown as SidebarSection[];
  }

  /** Whether this section is one of this account's own. */
  ownsSidebarSection(userId: ID, sectionId: ID): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sidebar_sections WHERE id = ? AND user_id = ?")
      .get(sectionId, userId);
  }

  /** Adds a section at the end of the account's list. */
  createSidebarSection(userId: ID, name: string): SidebarSection {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO sidebar_sections (id, user_id, name, position, created_at)
         SELECT ?, ?, ?, COALESCE(MAX(position), -1) + 1, ? FROM sidebar_sections WHERE user_id = ?`,
      )
      .run(id, userId, name, Date.now(), userId);
    return { id, name };
  }

  /** Renames one of the account's sections; false when it has no such section. */
  renameSidebarSection(userId: ID, sectionId: ID, name: string): boolean {
    return (
      this.db
        .prepare("UPDATE sidebar_sections SET name = ? WHERE id = ? AND user_id = ?")
        .run(name, sectionId, userId).changes > 0
    );
  }

  /**
   * Deletes one of the account's sections. Its conversations go back where
   * they would be; says which, or null when it has no such section.
   */
  deleteSidebarSection(userId: ID, sectionId: ID): ID[] | null {
    const gone = this.db
      .prepare("DELETE FROM sidebar_sections WHERE id = ? AND user_id = ?")
      .run(sectionId, userId);
    if (gone.changes === 0) return null;
    const freed = this.db
      .prepare(
        `UPDATE channel_members SET section_id = NULL WHERE user_id = ? AND section_id = ?
         RETURNING channel_id`,
      )
      .all(userId, sectionId) as { channel_id: string }[];
    return freed.map((row) => row.channel_id);
  }

  /** Puts the account's sections in this order; false unless `ids` is every one of them. */
  orderSidebarSections(userId: ID, ids: ID[]): boolean {
    const have = this.sidebarSections(userId).map((section) => section.id);
    if (ids.length !== have.length || new Set(ids).size !== ids.length) return false;
    if (!ids.every((id) => have.includes(id))) return false;
    const place = this.db.prepare(
      "UPDATE sidebar_sections SET position = ? WHERE id = ? AND user_id = ?",
    );
    ids.forEach((id, position) => place.run(position, id, userId));
    return true;
  }

  /**
   * Advances the channel's read cursor, which reads what the channel shows.
   * Replies are read through their threads, but one also sent to the channel
   * was seen there, so each thread's cursor moves over the replies it now
   * passes that were sent to the channel, as far as no reply shown only in
   * the thread comes first. Gives the cursor and the threads whose cursor moved.
   */
  markRead(channelId: ID, userId: ID, seq: number): { seq: number; threads: ID[] } {
    const before = this.db
      .prepare("SELECT last_read_seq FROM channel_members WHERE channel_id = ? AND user_id = ?")
      .get(channelId, userId) as { last_read_seq: number } | undefined;
    const row = this.db
      .prepare(
        "UPDATE channel_members SET last_read_seq = MAX(last_read_seq, ?) WHERE channel_id = ? AND user_id = ? RETURNING last_read_seq",
      )
      .get(Math.min(seq, this.currentSeq()), channelId, userId) as
      { last_read_seq: number } | undefined;
    const after = row?.last_read_seq ?? 0;
    if (!before || after <= before.last_read_seq) return { seq: after, threads: [] };
    // Threads with a copy this read passes, and threads marked unread that it
    // reads past where the channel stood: their held copies are read now.
    const roots = this.db
      .prepare(
        `SELECT thread_root_id AS id FROM messages
         WHERE channel_id = ? AND broadcast = 1 AND thread_root_id IS NOT NULL
           AND deleted_at IS NULL AND seq > ? AND seq <= ?
         UNION
         SELECT f.root_id FROM thread_follows f JOIN messages root ON root.id = f.root_id
         WHERE f.user_id = ? AND root.channel_id = ?
           AND f.unread_hold IS NOT NULL AND f.unread_hold < ?`,
      )
      .all(channelId, before.last_read_seq, after, userId, channelId, after) as { id: string }[];
    const threads = roots.filter(({ id }) => this.readChannelCopies(userId, id, after));
    return { seq: after, threads: threads.map(({ id }) => id) };
  }

  /**
   * Moves a thread's cursor over the channel copies up to `channelRead`; true
   * if it moved. Not while the thread is held unread at or past `channelRead`.
   */
  private readChannelCopies(userId: ID, rootId: ID, channelRead: number): boolean {
    const current = this.threadFollow(userId, rootId);
    if (!current || (current.unreadHold !== undefined && channelRead <= current.unreadHold))
      return false;
    const replies = this.db
      .prepare(
        `SELECT seq, broadcast FROM messages
         WHERE thread_root_id = ? AND deleted_at IS NULL AND seq > ? ORDER BY seq`,
      )
      .all(rootId, current.lastReadSeq) as { seq: number; broadcast: number }[];
    let read = current.lastReadSeq;
    for (const reply of replies) {
      if (reply.broadcast !== 1 || reply.seq > channelRead) break;
      read = reply.seq;
    }
    if (read === current.lastReadSeq) return false;
    this.db
      .prepare(
        `INSERT INTO thread_follows (user_id, root_id, following, last_read_seq, revision)
         VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(user_id, root_id) DO UPDATE SET
           last_read_seq = excluded.last_read_seq,
           unread_hold = NULL,
           revision = MAX(thread_follows.revision + 1, excluded.revision)
         WHERE thread_follows.last_read_seq < excluded.last_read_seq`,
      )
      .run(userId, rootId, read, this.nextFollowRevision());
    return true;
  }

  /**
   * Leaves a message and everything after it unread. Unlike `markRead` this
   * moves the cursor backwards, so it sets rather than advances.
   */
  markUnread(channelId: ID, userId: ID, seq: number): number | null {
    // A cursor from another channel, a deleted message, or a future event
    // must never make this channel's later messages appear read.
    const target = this.db
      .prepare(
        `SELECT 1 FROM messages
         WHERE channel_id = ? AND seq = ? AND seq > 0
           AND ${IN_CHANNEL_TIMELINE} AND deleted_at IS NULL LIMIT 1`,
      )
      .get(channelId, seq);
    if (!target) return null;
    const row = this.db
      .prepare(
        `UPDATE channel_members SET last_read_seq = ? WHERE channel_id = ? AND user_id = ?
         RETURNING last_read_seq`,
      )
      .get(Math.max(0, seq - 1), channelId, userId) as { last_read_seq: number } | undefined;
    return row?.last_read_seq ?? 0;
  }

  lastMessageSeq(channelId: ID): number {
    const row = this.db.prepare("SELECT last_msg_seq FROM channels WHERE id = ?").get(channelId) as
      { last_msg_seq: number } | undefined;
    return row?.last_msg_seq ?? 0;
  }

  /** channelId -> last message seq, for every channel the user can see. */
  channelLastSeqMap(userId: ID): Record<ID, number> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.id, c.last_msg_seq FROM channels c
         LEFT JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
         WHERE c.type = 'public' OR m.user_id IS NOT NULL`,
      )
      .all(userId) as { id: string; last_msg_seq: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.id] = r.last_msg_seq;
    return out;
  }

  /**
   * True if the user may read the channel (public, or member of non-public).
   * A guest reads public channels only, whatever membership it might be given.
   */
  canAccess(channelId: ID, userId: ID): boolean {
    const r = this.db.prepare("SELECT type FROM channels WHERE id = ?").get(channelId) as
      { type: string } | undefined;
    if (!r) return false;
    if (r.type === "public") return true;
    return this.isMember(channelId, userId) && !this.isGuest(userId);
  }

  isGuest(userId: ID): boolean {
    return this.db.prepare("SELECT role FROM users WHERE id = ?").get(userId)?.role === "guest";
  }

  // ---------- messages ----------

  createMessage(input: {
    channelId: ID;
    userId: ID;
    text: string;
    threadRootId: ID | null;
    nonce: string | null;
    actions?: MessageAction[];
    /** Only meaningful for a reply; a top-level message is already there. */
    broadcast?: boolean;
    /** The message this one answers in place; the caller has checked it. */
    replyToId?: ID | null;
    /** Notify that message's author, unless it is the sender or deleted. */
    replyPing?: boolean;
    /** The message this one passes on; the caller has checked the sender may read it. */
    forwardedFromId?: ID | null;
    /** Makes it the server's note about a call (E10). */
    call?: CallNotice | null;
  }): Message {
    // Messages are read back in the order of their ids, so that order has to
    // be the order they were made in, within one millisecond too.
    const id = orderedUlid();
    const original = input.replyToId && input.replyPing ? this.pingable(input.replyToId) : null;
    const pinged = original !== input.userId ? original : null;
    this.db
      .prepare(
        `INSERT INTO messages
           (id, channel_id, user_id, text, thread_root_id, broadcast, nonce, created_at, actions,
            reply_to_id, reply_ping, forwarded_from_id, call_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.channelId,
        input.userId,
        input.text,
        input.threadRootId,
        input.threadRootId && input.broadcast ? 1 : 0,
        input.nonce,
        Date.now(),
        JSON.stringify(input.actions ?? []),
        input.replyToId ?? null,
        pinged ? 1 : 0,
        input.forwardedFromId ?? null,
        input.call?.kind ?? null,
      );
    this.indexMentions(id, input.channelId, input.text, { pinged });
    return this.getMessage(id)!;
  }

  /**
   * The message a forward would pass on, as a send checks it: where it is,
   * whether it is deleted, and whether it is itself a forward with no words or
   * files of its own (`bare`), whose original is then passed on instead.
   */
  forwardSource(
    id: ID,
  ): { id: ID; channelId: ID; deleted: boolean; forwardedFromId: ID | null; bare: boolean } | null {
    const row = this.db
      .prepare(
        `SELECT m.id, m.channel_id, m.deleted_at, m.forwarded_from_id, m.text,
           (SELECT COUNT(*) FROM files f WHERE f.message_id = m.id) AS file_count
         FROM messages m WHERE m.id = ?`,
      )
      .get(id) as
      | (Pick<MessageRow, "id" | "channel_id" | "deleted_at" | "forwarded_from_id" | "text"> & {
          file_count: number;
        })
      | undefined;
    return row
      ? {
          id: row.id,
          channelId: row.channel_id,
          deleted: row.deleted_at !== null,
          forwardedFromId: row.forwarded_from_id,
          bare: row.text.trim() === "" && row.file_count === 0,
        }
      : null;
  }

  /**
   * Where a message a reply would answer belongs, deleted or not: a reply to
   * something deleted after it was chosen still goes, saying it was deleted.
   * Null once it is gone altogether, removed with older history.
   */
  replyTarget(
    id: ID,
  ): { channelId: ID; threadRootId: ID | null; broadcast: boolean; deleted: boolean } | null {
    const row = this.db
      .prepare(
        "SELECT channel_id, thread_root_id, broadcast, deleted_at FROM messages WHERE id = ?",
      )
      .get(id) as
      Pick<MessageRow, "channel_id" | "thread_root_id" | "broadcast" | "deleted_at"> | undefined;
    return row
      ? {
          channelId: row.channel_id,
          threadRootId: row.thread_root_id,
          broadcast: row.broadcast === 1,
          deleted: row.deleted_at !== null,
        }
      : null;
  }

  /** Whom a sent reply notified: the author of what it answers, if it chose to. */
  private replyPinged(messageId: ID): ID | null {
    const row = this.db
      .prepare(
        `SELECT q.user_id FROM messages m JOIN messages q ON q.id = m.reply_to_id
         WHERE m.id = ? AND m.reply_ping = 1`,
      )
      .get(messageId) as { user_id: string } | undefined;
    return row?.user_id ?? null;
  }

  /** Who a reply to this message would notify: its author, while it is there. */
  private pingable(messageId: ID): ID | null {
    const row = this.db
      .prepare("SELECT user_id FROM messages WHERE id = ? AND deleted_at IS NULL")
      .get(messageId) as { user_id: string } | undefined;
    return row?.user_id ?? null;
  }

  /**
   * Keeps `message_mentions` to whom this text names: `<@X>` names X, and
   * `<!here>`, `<!channel>` or `<!everyone>` the whole room as '!'. The same
   * rule as `MENTIONS_ME` and migration v31, so counts read from the table
   * agree with the text. A reply that notifies the author of what it answers
   * names them as well, whatever its words say. A new message has no rows yet
   * and says whom it notifies, and most name nobody, so sending one costs
   * nothing more here; an edit looks the notified author up again.
   */
  private indexMentions(
    messageId: ID,
    channelId: ID,
    text: string,
    created?: { pinged: ID | null },
  ): void {
    if (!created)
      this.db.prepare("DELETE FROM message_mentions WHERE message_id = ?").run(messageId);
    const named = new Set([...text.matchAll(/<@([A-Za-z0-9_-]+)>/g)].map((m) => m[1]!));
    if (/<!(?:here|channel|everyone)>/.test(text)) named.add("!");
    const pinged = created ? created.pinged : this.replyPinged(messageId);
    if (pinged) named.add(pinged);
    if (named.size === 0) return;
    const insert = this.db.prepare(
      "INSERT INTO message_mentions (message_id, channel_id, user_id) VALUES (?, ?, ?)",
    );
    for (const userId of named) insert.run(messageId, channelId, userId);
  }

  /** Drops a message's buttons, for an app that has answered and moved on. */
  clearMessageActions(id: ID): void {
    this.db.prepare("UPDATE messages SET actions = '[]' WHERE id = ?").run(id);
  }

  /**
   * Called after the event log assigns a seq to message.created. A reply
   * belongs to its thread, so only a message in the channel itself, or a
   * reply also sent there, moves the channel's newest seq and so its badge.
   */
  stampMessageSeq(messageId: ID, channelId: ID, seq: number, inChannel = true): void {
    this.db.prepare("UPDATE messages SET seq = ? WHERE id = ?").run(seq, messageId);
    if (inChannel)
      this.db
        .prepare("UPDATE channels SET last_msg_seq = MAX(last_msg_seq, ?) WHERE id = ?")
        .run(seq, channelId);
  }

  getMessage(id: ID): Message | null {
    const r = this.db
      .prepare("SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL")
      .get(id) as MessageRow | undefined;
    if (!r) return null;
    return this.hydrateMessages([r])[0]!;
  }

  editMessage(id: ID, text: string): Message {
    const row = this.db
      .prepare("UPDATE messages SET text = ?, edited_at = ? WHERE id = ? RETURNING channel_id")
      .get(text, Date.now(), id) as { channel_id: string } | undefined;
    if (row) this.indexMentions(id, row.channel_id, text);
    // Previews of links the new words no longer have go with the old ones.
    this.prunePreviews(id, previewLinks(text));
    // Every earlier version of the words, wherever the log still holds it. An
    // edit is often how someone takes back what they wrote, and leaving the
    // first draft on disk would make the correction cosmetic. The caller emits
    // the new version after this returns, so nothing appended yet is the one
    // being kept. Replies quoting it hold a copy of their own.
    this.redactMessageEvents(id);
    const message = this.getMessage(id)!;
    this.requoteEvents([id], { text: replyExcerpt(text), fileCount: message.files.length });
    this.reforwardEvents([id], { text });
    return message;
  }

  deleteMessage(id: ID): void {
    // Soft-delete, and blank the text so it drops out of the FTS index.
    this.db
      .prepare("UPDATE messages SET deleted_at = ?, text = '', actions = '[]' WHERE id = ?")
      .run(Date.now(), id);
    this.db.prepare("DELETE FROM reactions WHERE message_id = ?").run(id);
    this.db.prepare("DELETE FROM pins WHERE message_id = ?").run(id);
    this.db.prepare("DELETE FROM saved_items WHERE message_id = ?").run(id);
    this.db.prepare("DELETE FROM message_mentions WHERE message_id = ?").run(id);
    this.db.prepare("DELETE FROM link_previews WHERE message_id = ?").run(id);
    // Its votes go with it.
    this.db.prepare("DELETE FROM polls WHERE message_id = ?").run(id);
    this.redactMessageEvents(id);
    this.requoteEvents([id], null);
    this.reforwardEvents([id], null);
  }

  // ---------- link previews (E2) ----------

  /** The links a message has previews for or had one removed, with which. */
  previewRows(messageId: ID): { url: string; removed: boolean }[] {
    return (
      this.db
        .prepare("SELECT url, removed FROM link_previews WHERE message_id = ? ORDER BY position")
        .all(messageId) as { url: string; removed: number }[]
    ).map((r) => ({ url: r.url, removed: r.removed === 1 }));
  }

  /**
   * Keeps the previews of `links`, in that order, and drops the rest: a
   * removed one stays removed while its link stays. True when anything went.
   */
  prunePreviews(messageId: ID, links: string[]): boolean {
    let changed = false;
    for (const row of this.previewRows(messageId)) {
      const position = links.indexOf(row.url);
      if (position === -1) {
        this.db
          .prepare("DELETE FROM link_previews WHERE message_id = ? AND url = ?")
          .run(messageId, row.url);
        changed = true;
      } else {
        this.db
          .prepare("UPDATE link_previews SET position = ? WHERE message_id = ? AND url = ?")
          .run(position, messageId, row.url);
      }
    }
    return changed;
  }

  /** Adds a preview the server found for one of a message's links. False if it had one. */
  addPreview(messageId: ID, position: number, preview: FetchedPreview): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO link_previews
           (id, message_id, position, url, title, description, site_name,
            image, image_type, image_width, image_height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        messageId,
        position,
        preview.url,
        preview.title,
        preview.description,
        preview.siteName,
        preview.image?.bytes ?? null,
        preview.image?.type ?? null,
        preview.image?.width ?? null,
        preview.image?.height ?? null,
        Date.now(),
      );
    return Number(res.changes) > 0;
  }

  /** Where one preview is and who wrote its message, or null if it is not there. */
  previewOwner(id: ID): { messageId: ID; channelId: ID; authorId: ID } | null {
    const row = this.db
      .prepare(
        `SELECT p.message_id, m.channel_id, m.user_id FROM link_previews p
         JOIN messages m ON m.id = p.message_id
         WHERE p.id = ? AND p.removed = 0 AND m.deleted_at IS NULL`,
      )
      .get(id) as { message_id: string; channel_id: string; user_id: string } | undefined;
    return row
      ? { messageId: row.message_id, channelId: row.channel_id, authorId: row.user_id }
      : null;
  }

  /**
   * Takes a preview off its message for good: what it said and its picture go,
   * and the row stays so an edit keeping the link does not fetch it again.
   */
  removePreview(id: ID): void {
    this.db
      .prepare(
        `UPDATE link_previews SET removed = 1, title = '', description = '', site_name = '',
           image = NULL, image_type = NULL, image_width = NULL, image_height = NULL
         WHERE id = ?`,
      )
      .run(id);
  }

  /** A preview's picture, for a reader the caller has let see its message. */
  previewImage(id: ID): { bytes: Uint8Array; type: string } | null {
    const row = this.db
      .prepare(
        "SELECT image, image_type FROM link_previews WHERE id = ? AND removed = 0 AND image IS NOT NULL",
      )
      .get(id) as { image: Uint8Array; image_type: string } | undefined;
    return row ? { bytes: row.image, type: row.image_type } : null;
  }

  /**
   * Removes every trace of conversations older than `before`, and returns the
   * attachment ids whose bytes the caller still has to delete from disk.
   *
   * A thread ages out as one thing. A root is taken only when its newest reply
   * is past the cutoff too, and then its replies go with it, because a reply
   * hanging under nothing reads as a database that has gone wrong rather than
   * as a retention window doing its job.
   *
   * One call removes at most `limits.messages` messages, counting replies as
   * well as roots, so the first sweep after someone turns this on does not
   * hold the database for a minute; what it leaves behind is taken on the next
   * call. Counting roots alone was not a bound: one root can carry tens of
   * thousands of replies. Roots are taken oldest first until the next thread
   * would go over. A thread larger than the whole budget is still taken, whole
   * and alone, because the alternatives are a root that never ages out or a
   * thread that loses its middle while someone is reading it.
   *
   * The doomed ids go through a temporary table rather than bound parameters,
   * so no thread is too large for SQLite's limit on those.
   *
   * Call inside a transaction: the rows, the files' rows, the queued blob
   * deletions and the redacted log go together or not at all.
   */
  purgeMessagesBefore(
    before: number,
    limits: { roots?: number; messages?: number } = {},
  ): { messages: number; fileIds: ID[]; roots: { id: ID; channelId: ID }[] } {
    const rootLimit = limits.roots ?? 2000;
    const messageBudget = limits.messages ?? 5000;
    const candidates = this.db
      .prepare(
        `SELECT m.id, m.channel_id AS channelId,
           (SELECT COUNT(*) FROM messages r WHERE r.thread_root_id = m.id) AS replies
         FROM messages m
         WHERE m.thread_root_id IS NULL AND m.created_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM messages r WHERE r.thread_root_id = m.id AND r.created_at >= ?
           )
         ORDER BY m.id LIMIT ?`,
      )
      .all(before, before, rootLimit) as { id: string; channelId: string; replies: number }[];
    if (candidates.length === 0) return { messages: 0, fileIds: [], roots: [] };

    const roots: ID[] = [];
    const removed: { id: ID; channelId: ID }[] = [];
    let messages = 0;
    for (const candidate of candidates) {
      const size = 1 + candidate.replies;
      if (roots.length > 0 && messages + size > messageBudget) break;
      roots.push(candidate.id);
      removed.push({ id: candidate.id, channelId: candidate.channelId });
      messages += size;
    }

    this.db.exec("CREATE TEMP TABLE IF NOT EXISTS purge_messages (id TEXT PRIMARY KEY)");
    this.db.exec("DELETE FROM temp.purge_messages");
    try {
      const addRoot = this.db.prepare("INSERT INTO temp.purge_messages (id) VALUES (?)");
      for (const id of roots) addRoot.run(id);
      this.db.exec(
        `INSERT INTO temp.purge_messages (id)
         SELECT id FROM messages WHERE thread_root_id IN (SELECT id FROM temp.purge_messages)`,
      );
      const doomed = "(SELECT id FROM temp.purge_messages)";

      const fileIds = (
        this.db.prepare(`SELECT id FROM files WHERE message_id IN ${doomed}`).all() as {
          id: string;
        }[]
      ).map((r) => r.id);
      // The log's copies, read before the rows go; redacted once they have.
      const logged = this.db
        .prepare(
          `SELECT seq, payload FROM events
           WHERE message_id IN ${doomed} AND type IN ('message.created', 'message.updated')`,
        )
        .all() as { seq: number; payload: string }[];
      const queued = this.db
        .prepare(`SELECT id, body FROM event_deliveries WHERE message_id IN ${doomed}`)
        .all() as { id: string; body: string }[];
      // Later replies quoting what goes stay, and say it is gone.
      const quoted = (
        this.db
          .prepare(
            `SELECT DISTINCT reply_to_id AS id FROM messages
             WHERE reply_to_id IN ${doomed} AND id NOT IN ${doomed}`,
          )
          .all() as { id: string }[]
      ).map((r) => r.id);
      // So do later forwards of it.
      const forwarded = (
        this.db
          .prepare(
            `SELECT DISTINCT forwarded_from_id AS id FROM messages
             WHERE forwarded_from_id IN ${doomed} AND id NOT IN ${doomed}`,
          )
          .all() as { id: string }[]
      ).map((r) => r.id);

      // A send's key outlives its message, so an app still holding the send
      // is refused rather than posting it again. Who, which key and when only.
      this.db.exec(
        `INSERT OR REPLACE INTO purged_message_requests (user_id, nonce, sent_at)
         SELECT mr.user_id, mr.nonce, m.created_at FROM message_requests mr
         JOIN messages m ON m.id = mr.message_id
         WHERE mr.message_id IN ${doomed}`,
      );
      // Everything that points at a message, before the messages themselves:
      // foreign keys are on, so a leftover reference would refuse the delete
      // rather than quietly orphan.
      for (const sql of [
        `DELETE FROM reactions WHERE message_id IN ${doomed}`,
        `DELETE FROM pins WHERE message_id IN ${doomed}`,
        `DELETE FROM saved_items WHERE message_id IN ${doomed}`,
        `DELETE FROM message_requests WHERE message_id IN ${doomed}`,
        `DELETE FROM thread_follows WHERE root_id IN ${doomed}`,
        `DELETE FROM files WHERE message_id IN ${doomed}`,
        // Not a foreign key, but a scheduled row still naming a message that no
        // longer exists would report a send that cannot be looked up.
        `UPDATE scheduled_messages SET message_id = NULL WHERE message_id IN ${doomed}`,
        `DELETE FROM messages WHERE id IN ${doomed}`,
      ]) {
        this.db.exec(sql);
      }
      // In the same transaction as the rows, so a crash between the two cannot
      // leave bytes on disk that nothing remembers to delete.
      this.queueFileDeletions(fileIds);

      // The rows are gone; the log, and any app event still waiting to leave,
      // still hold what they said.
      this.redactEventRows(logged);
      this.redactQueuedDeliveries(queued);
      this.requoteEvents(quoted, null);
      this.reforwardEvents(forwarded, null);
      return { messages, fileIds, roots: removed };
    } finally {
      this.db.exec("DELETE FROM temp.purge_messages");
    }
  }

  /** Newest-first page of top-level channel messages (or thread replies). */
  listMessages(opts: { channelId: ID; before?: ID; limit: number; threadRootId?: ID }): Message[] {
    let rows: MessageRow[];
    if (opts.threadRootId) {
      rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE channel_id = ? AND thread_root_id = ? AND deleted_at IS NULL ${opts.before ? "AND id < ?" : ""}
           ORDER BY id DESC LIMIT ?`,
        )
        .all(
          ...([opts.channelId, opts.threadRootId, opts.before, opts.limit].filter(
            (x) => x !== undefined,
          ) as (string | number)[]),
        ) as unknown as MessageRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE channel_id = ? AND ${IN_CHANNEL_TIMELINE} AND deleted_at IS NULL ${opts.before ? "AND id < ?" : ""}
           ORDER BY id DESC LIMIT ?`,
        )
        .all(
          ...([opts.channelId, opts.before, opts.limit].filter((x) => x !== undefined) as (
            string | number
          )[]),
        ) as unknown as MessageRow[];
    }
    return this.hydrateMessages(rows);
  }

  /** Thread pages are oldest-first and contain only direct replies to this root. */
  threadHistory(
    channelId: ID,
    rootId: ID,
    opts: { before?: ID; after?: ID; around?: ID; limit: number },
  ): { messages: Message[]; hasMoreOlder: boolean; hasMoreNewer: boolean } {
    if (opts.around) {
      const olderLimit = Math.floor((opts.limit - 1) / 2);
      const older = this.threadHistory(channelId, rootId, {
        before: opts.around,
        limit: olderLimit,
      });
      const newer = this.threadHistory(channelId, rootId, {
        after: opts.around,
        limit: opts.limit - 1 - olderLimit,
      });
      const target = this.getMessage(opts.around);
      return {
        messages: [
          ...older.messages,
          ...(target?.channelId === channelId && target.threadRootId === rootId ? [target] : []),
          ...newer.messages,
        ],
        hasMoreOlder: older.hasMoreOlder,
        hasMoreNewer: newer.hasMoreNewer,
      };
    }
    const cursor = opts.before ?? opts.after;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE channel_id = ? AND thread_root_id = ? AND deleted_at IS NULL
       ${cursor ? `AND id ${opts.after ? ">" : "<"} ?` : ""}
       ORDER BY id ${opts.after ? "ASC" : "DESC"} LIMIT ?`,
      )
      .all(channelId, rootId, ...(cursor ? [cursor] : []), opts.limit) as unknown as MessageRow[];
    if (!opts.after) rows.reverse();
    const first = rows[0]?.id ?? cursor;
    const last = rows.at(-1)?.id ?? cursor;
    const exists = (direction: "<" | ">", id?: ID) =>
      !!id &&
      this.db
        .prepare(
          `SELECT 1 FROM messages WHERE channel_id = ? AND thread_root_id = ? AND deleted_at IS NULL AND id ${direction} ? LIMIT 1`,
        )
        .get(channelId, rootId, id) !== undefined;
    return {
      messages: this.hydrateMessages(rows),
      hasMoreOlder: exists("<", first),
      hasMoreNewer: exists(">", last),
    };
  }

  /**
   * A window of messages centred on one message, for jumping to a search hit
   * or a pinned message. Returns newest-first like listMessages, plus whether
   * more exist on either side so the client knows it is not at the tail.
   */
  listMessagesAround(
    channelId: ID,
    messageId: ID,
    limit: number,
  ): { messages: Message[]; hasMoreOlder: boolean; hasMoreNewer: boolean } {
    const half = Math.max(1, Math.floor(limit / 2));

    // Ask for one extra on each side purely to detect whether more exist.
    const olderRows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND ${IN_CHANNEL_TIMELINE} AND deleted_at IS NULL AND id < ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(channelId, messageId, half + 1) as unknown as MessageRow[];
    const newerRows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND ${IN_CHANNEL_TIMELINE} AND deleted_at IS NULL AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(channelId, messageId, half + 1) as unknown as MessageRow[];
    const targetRow = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE id = ? AND channel_id = ? AND ${IN_CHANNEL_TIMELINE} AND deleted_at IS NULL`,
      )
      .get(messageId, channelId) as MessageRow | undefined;

    const hasMoreOlder = olderRows.length > half;
    const hasMoreNewer = newerRows.length > half;
    const older = olderRows.slice(0, half);
    const newer = newerRows.slice(0, half).reverse(); // newest-first

    const rows = [...newer, ...(targetRow ? [targetRow] : []), ...older];
    return { messages: this.hydrateMessages(rows), hasMoreOlder, hasMoreNewer };
  }

  /** Page forward from a message, for scrolling back down toward the tail. */
  listMessagesAfter(channelId: ID, afterId: ID, limit: number): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND ${IN_CHANNEL_TIMELINE} AND deleted_at IS NULL AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(channelId, afterId, limit) as unknown as MessageRow[];
    // Callers expect newest-first.
    return this.hydrateMessages(rows.reverse());
  }

  private hydrateMessages(rows: MessageRow[]): Message[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => "?").join(",");

    const reactionRows = this.db
      .prepare(
        `SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${ph}) ORDER BY created_at`,
      )
      .all(...ids) as { message_id: string; emoji: string; user_id: string }[];
    const reactionsByMsg = new Map<string, ReactionGroup[]>();
    for (const rr of reactionRows) {
      let groups = reactionsByMsg.get(rr.message_id);
      if (!groups) reactionsByMsg.set(rr.message_id, (groups = []));
      let g = groups.find((g) => g.emoji === rr.emoji);
      if (!g) groups.push((g = { emoji: rr.emoji, userIds: [] }));
      g.userIds.push(rr.user_id);
    }

    const replyRows = this.db
      .prepare(
        `SELECT thread_root_id, COUNT(*) c FROM messages
         WHERE thread_root_id IN (${ph}) AND deleted_at IS NULL GROUP BY thread_root_id`,
      )
      .all(...ids) as { thread_root_id: string; c: number }[];
    const replyCounts = new Map(replyRows.map((r) => [r.thread_root_id, r.c]));

    const pinRows = this.db
      .prepare(`SELECT message_id FROM pins WHERE message_id IN (${ph})`)
      .all(...ids) as { message_id: string }[];
    const pinned = new Set(pinRows.map((r) => r.message_id));

    const fileRows = this.db
      .prepare(
        `SELECT id, message_id, name, mime, size, width, height FROM files
         WHERE message_id IN (${ph}) ORDER BY created_at`,
      )
      .all(...ids) as unknown as (FileMeta & { message_id: string })[];
    const filesByMsg = new Map<string, FileMeta[]>();
    for (const f of fileRows) {
      const { message_id, ...meta } = f;
      const list = filesByMsg.get(message_id);
      if (list) list.push(meta);
      else filesByMsg.set(message_id, [meta]);
    }

    // What each reply answers, read as it is now: edited, deleted or gone.
    const quotedIds = [...new Set(rows.flatMap((r) => (r.reply_to_id ? [r.reply_to_id] : [])))];
    const quotes = new Map(
      quotedIds.length === 0
        ? []
        : (
            this.db
              .prepare(
                `SELECT q.id, q.user_id, q.text, q.deleted_at,
                   (SELECT COUNT(*) FROM files f WHERE f.message_id = q.id) AS file_count
                 FROM messages q WHERE q.id IN (${quotedIds.map(() => "?").join(",")})`,
              )
              .all(...quotedIds) as {
              id: string;
              user_id: string;
              text: string;
              deleted_at: number | null;
              file_count: number;
            }[]
          ).map((q) => [q.id, q]),
    );
    // Only a reply carries one, so every other message reads as it always has.
    const replyTo = (r: MessageRow): { replyTo?: ReplyReference } => {
      if (!r.reply_to_id) return {};
      const q = quotes.get(r.reply_to_id);
      const ping = r.reply_ping === 1;
      return {
        replyTo:
          q && q.deleted_at === null
            ? {
                id: q.id,
                userId: q.user_id,
                text: replyExcerpt(q.text),
                fileCount: q.file_count,
                deleted: false,
                ping,
              }
            : { id: r.reply_to_id, userId: "", text: "", fileCount: 0, deleted: true, ping },
      };
    };

    // What each forward passes on, read as it is now. Its words, files and
    // author show only where everyone reading the forward can read the
    // original too (see ForwardReference).
    const forwardedIds = [
      ...new Set(rows.flatMap((r) => (r.forwarded_from_id ? [r.forwarded_from_id] : []))),
    ];
    const originals = new Map(
      forwardedIds.length === 0
        ? []
        : (
            this.db
              .prepare(
                `SELECT m.id, m.channel_id, m.user_id, m.text, m.created_at, m.deleted_at,
                   c.type AS channel_type
                 FROM messages m JOIN channels c ON c.id = m.channel_id
                 WHERE m.id IN (${forwardedIds.map(() => "?").join(",")})`,
              )
              .all(...forwardedIds) as (Pick<
              MessageRow,
              "id" | "channel_id" | "user_id" | "text" | "created_at" | "deleted_at"
            > & { channel_type: string })[]
          ).map((o) => [o.id, o]),
    );
    const originalFiles = new Map<string, FileMeta[]>();
    if (originals.size > 0) {
      const ids = [...originals.keys()];
      for (const f of this.db
        .prepare(
          `SELECT id, message_id, name, mime, size, width, height FROM files
           WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at`,
        )
        .all(...ids) as unknown as (FileMeta & { message_id: string })[]) {
        const { message_id, ...meta } = f;
        const list = originalFiles.get(message_id);
        if (list) list.push(meta);
        else originalFiles.set(message_id, [meta]);
      }
    }
    const forwardedFrom = (r: MessageRow): { forwardedFrom?: ForwardReference } => {
      if (!r.forwarded_from_id) return {};
      const o = originals.get(r.forwarded_from_id);
      const none = { userId: "", text: "", files: [], createdAt: 0 };
      if (!o || o.deleted_at !== null)
        return {
          forwardedFrom: {
            id: r.forwarded_from_id,
            channelId: o?.channel_id ?? "",
            ...none,
            deleted: true,
            hidden: false,
          },
        };
      if (o.channel_type !== "public" && o.channel_id !== r.channel_id)
        return {
          forwardedFrom: {
            id: o.id,
            channelId: o.channel_id,
            ...none,
            deleted: false,
            hidden: true,
          },
        };
      return {
        forwardedFrom: {
          id: o.id,
          channelId: o.channel_id,
          userId: o.user_id,
          text: o.text,
          files: originalFiles.get(o.id) ?? [],
          createdAt: o.created_at,
          deleted: false,
          hidden: false,
        },
      };
    };

    // Each message's previews, in the order of its links. A deleted one has none.
    const previews = new Map<string, LinkPreview[]>();
    const live = rows.filter((r) => r.deleted_at === null).map((r) => r.id);
    if (live.length > 0) {
      for (const p of this.db
        .prepare(
          `SELECT id, message_id, url, title, description, site_name, image_width, image_height,
             image IS NOT NULL AS has_image
           FROM link_previews
           WHERE removed = 0 AND message_id IN (${live.map(() => "?").join(",")})
           ORDER BY message_id, position`,
        )
        .all(...live) as {
        id: string;
        message_id: string;
        url: string;
        title: string;
        description: string;
        site_name: string;
        image_width: number | null;
        image_height: number | null;
        has_image: number;
      }[]) {
        const preview: LinkPreview = {
          id: p.id,
          url: p.url,
          title: p.title,
          description: p.description,
          siteName: p.site_name,
          image:
            p.has_image && p.image_width && p.image_height
              ? { width: p.image_width, height: p.image_height }
              : null,
        };
        const list = previews.get(p.message_id);
        if (list) list.push(preview);
        else previews.set(p.message_id, [preview]);
      }
    }

    const polls = this.pollsOf(live);

    return rows.map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      userId: r.user_id,
      text: r.text,
      threadRootId: r.thread_root_id,
      broadcast: r.broadcast === 1,
      seq: r.seq,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      nonce: r.nonce,
      replyCount: replyCounts.get(r.id) ?? 0,
      reactions: reactionsByMsg.get(r.id) ?? [],
      files: filesByMsg.get(r.id) ?? [],
      pinned: pinned.has(r.id),
      actions: parseActions(r.actions),
      ...replyTo(r),
      ...forwardedFrom(r),
      ...(previews.has(r.id) ? { previews: previews.get(r.id)! } : {}),
      ...(polls.has(r.id) ? { poll: polls.get(r.id)! } : {}),
      ...(r.call_kind === "missed" ? { call: { kind: "missed" as const } } : {}),
    }));
  }

  /** The polls among these messages, with their votes counted, by message id. */
  private pollsOf(messageIds: ID[]): Map<ID, Poll> {
    const polls = new Map<ID, Poll>();
    if (messageIds.length === 0) return polls;
    const ph = messageIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT message_id, options, multiple, anonymous, closed_at FROM polls
         WHERE message_id IN (${ph})`,
      )
      .all(...messageIds) as {
      message_id: string;
      options: string;
      multiple: number;
      anonymous: number;
      closed_at: number | null;
    }[];
    if (rows.length === 0) return polls;
    const votes = this.db
      .prepare(
        `SELECT message_id, user_id, option FROM poll_votes
         WHERE message_id IN (${rows.map(() => "?").join(",")})
         ORDER BY created_at, rowid`,
      )
      .all(...rows.map((r) => r.message_id)) as {
      message_id: string;
      user_id: string;
      option: number;
    }[];
    for (const row of rows) {
      const anonymous = row.anonymous === 1;
      const options = (JSON.parse(row.options) as string[]).map((text) => ({
        text,
        votes: 0,
        ...(anonymous ? {} : { voterIds: [] as ID[] }),
      }));
      const voters = new Set<ID>();
      for (const vote of votes) {
        if (vote.message_id !== row.message_id) continue;
        const option = options[vote.option];
        if (!option) continue;
        option.votes++;
        option.voterIds?.push(vote.user_id);
        voters.add(vote.user_id);
      }
      polls.set(row.message_id, {
        options,
        multiple: row.multiple === 1,
        anonymous,
        voters: voters.size,
        closedAt: row.closed_at,
      });
    }
    return polls;
  }

  // ---------- files ----------

  createFile(input: {
    id?: ID;
    channelId: ID;
    userId: ID;
    name: string;
    mime: string;
    size: number;
    width: number | null;
    height: number | null;
  }): FileMeta {
    const id = input.id ?? ulid();
    this.db
      .prepare(
        `INSERT INTO files (id, channel_id, user_id, name, mime, size, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.channelId,
        input.userId,
        input.name,
        input.mime,
        input.size,
        input.width,
        input.height,
        Date.now(),
      );
    return {
      id,
      name: input.name,
      mime: input.mime,
      size: input.size,
      width: input.width,
      height: input.height,
    };
  }

  getFile(id: ID): (FileMeta & { channelId: ID; userId: ID }) | null {
    const r = this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as
      | {
          id: string;
          channel_id: string;
          user_id: string;
          name: string;
          mime: string;
          size: number;
          width: number | null;
          height: number | null;
        }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      channelId: r.channel_id,
      userId: r.user_id,
      name: r.name,
      mime: r.mime,
      size: r.size,
      width: r.width,
      height: r.height,
    };
  }

  /**
   * The files shared in conversations this account can read, for the file
   * browser (E7): on live messages, newest shared first. Message ids are
   * ordered by time, so the order walks `idx_files_message`; a message's
   * files follow by id. Narrowed by kind, by who shared, by conversation and
   * by every word of `q` in the name. Reading follows the download rule: a
   * public conversation, or one this account is in and is no guest.
   */
  listSharedFiles(
    userId: ID,
    query: {
      limit: number;
      cursor?: string;
      kind?: FileKind;
      userId?: ID;
      channelId?: ID;
      q?: string;
    },
  ): { files: SharedFile[]; nextCursor: string | null } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (this.isGuest(userId)) where.push("c.type = 'public'");
    else {
      where.push(
        `(c.type = 'public' OR EXISTS (SELECT 1 FROM channel_members cm
           WHERE cm.channel_id = c.id AND cm.user_id = ?))`,
      );
      params.push(userId);
    }
    if (query.kind) {
      // By `type:`'s patterns, so the browser and search agree on every file.
      const matching = (kind: "image" | "document") => {
        const tests = FILE_KIND_TYPES[kind].flatMap((type) => [
          ...FILE_TYPE_MATCH[type].mime.map((mime) => ["lower(f.mime) LIKE ?", mime] as const),
          ...FILE_TYPE_MATCH[type].ext.map((ext) => ["lower(f.name) LIKE ?", `%.${ext}`] as const),
        ]);
        return {
          sql: `(${tests.map(([sql]) => sql).join(" OR ")})`,
          params: tests.map(([, v]) => v),
        };
      };
      const image = matching("image");
      const document = matching("document");
      if (query.kind === "image") {
        where.push(image.sql);
        params.push(...image.params);
      } else if (query.kind === "document") {
        // A picture is a picture, whatever its name ends with.
        where.push(`${document.sql} AND NOT ${image.sql}`);
        params.push(...document.params, ...image.params);
      } else {
        where.push(`NOT (${image.sql} OR ${document.sql})`);
        params.push(...image.params, ...document.params);
      }
    }
    if (query.userId) {
      where.push("m.user_id = ?");
      params.push(query.userId);
    }
    if (query.channelId) {
      where.push("m.channel_id = ?");
      params.push(query.channelId);
    }
    for (const term of query.q?.split(/\s+/).filter(Boolean) ?? []) {
      where.push("f.name LIKE ? ESCAPE '\\'");
      params.push(`%${term.replaceAll(/[\\%_]/g, "\\$&")}%`);
    }
    if (query.cursor) {
      const [messageId, fileId] = query.cursor.split(":") as [string, string];
      where.push("(f.message_id < ? OR (f.message_id = ? AND f.id < ?))");
      params.push(messageId, messageId, fileId);
    }
    // CROSS JOIN keeps files the outer loop: left to choose, SQLite read every
    // message and sorted them all, where this stops once a page is full.
    const rows = this.db
      .prepare(
        `SELECT f.id, f.name, f.mime, f.size, f.width, f.height, f.message_id,
                m.channel_id, m.thread_root_id, m.user_id, m.created_at
         FROM files f
         CROSS JOIN messages m ON m.id = f.message_id
         CROSS JOIN channels c ON c.id = m.channel_id
         WHERE f.message_id IS NOT NULL AND m.deleted_at IS NULL AND ${where.join(" AND ")}
         ORDER BY f.message_id DESC, f.id DESC LIMIT ?`,
      )
      .all(...params, query.limit + 1) as {
      id: string;
      name: string;
      mime: string;
      size: number;
      width: number | null;
      height: number | null;
      message_id: string;
      channel_id: string;
      thread_root_id: string | null;
      user_id: string;
      created_at: number;
    }[];
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      files: page.map((r) => ({
        file: {
          id: r.id,
          name: r.name,
          mime: r.mime,
          size: r.size,
          width: r.width,
          height: r.height,
        },
        messageId: r.message_id,
        channelId: r.channel_id,
        threadRootId: r.thread_root_id,
        userId: r.user_id,
        sharedAt: r.created_at,
      })),
      nextCursor: rows.length > query.limit && last ? `${last.message_id}:${last.id}` : null,
    };
  }

  /**
   * Binds uploads to their message. Only the uploader's own unattached files in
   * this channel, and none a scheduled message is holding unless it is that
   * scheduled message being delivered.
   */
  attachFiles(
    fileIds: ID[],
    messageId: ID,
    channelId: ID,
    userId: ID,
    scheduledId: ID | null = null,
  ): boolean {
    const stmt = this.db.prepare(
      `UPDATE files SET message_id = ?
       WHERE id = ? AND user_id = ? AND channel_id = ? AND message_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM scheduled_files sf WHERE sf.file_id = files.id AND sf.scheduled_id IS NOT ?
         )`,
    );
    for (const fileId of fileIds) {
      if (stmt.run(messageId, fileId, userId, channelId, scheduledId).changes !== 1) return false;
    }
    return true;
  }

  /** True when a scheduled message other than `except` is holding any of these files. */
  filesHeldBySchedule(fileIds: ID[], except: ID | null = null): boolean {
    const stmt = this.db.prepare(
      "SELECT 1 FROM scheduled_files WHERE file_id = ? AND scheduled_id IS NOT ?",
    );
    return fileIds.some((id) => stmt.get(id, except) !== undefined);
  }

  /**
   * Uploads that were never attached to anything and are old enough to have
   * been given up on. An upload sits unattached for the moment between choosing
   * a file and sending it, so only age separates that from an abandoned draft.
   *
   * Returns null when the scheduled queue cannot be read, which means some
   * unknown set of files is still spoken for. Sweeping on a guess would delete
   * attachments a queued message still needs, so the caller does nothing.
   */
  abandonedFileIds(olderThan: number): ID[] | null {
    const spokenFor = new Set<ID>();
    const rows = this.db.prepare("SELECT file_ids FROM scheduled_messages").all() as {
      file_ids: string;
    }[];
    for (const row of rows) {
      let ids: unknown;
      try {
        ids = JSON.parse(row.file_ids);
      } catch {
        return null;
      }
      if (!Array.isArray(ids)) return null;
      for (const id of ids) spokenFor.add(String(id));
    }
    for (const row of this.db.prepare("SELECT file_id FROM scheduled_files").all() as {
      file_id: string;
    }[])
      spokenFor.add(row.file_id);
    const candidates = this.db
      .prepare("SELECT id FROM files WHERE message_id IS NULL AND created_at < ?")
      .all(olderThan) as { id: string }[];
    return candidates.map((row) => row.id).filter((id) => !spokenFor.has(id));
  }

  // ---------- download tickets ----------

  /**
   * A one-shot ticket letting a browser fetch one file without a header it
   * cannot set on a navigation. Only the hash is stored, as with session
   * tokens, so the table is not a list of working credentials.
   */
  createDownloadToken(
    tokenHash: string,
    fileId: ID,
    userId: ID,
    sessionHash: string,
    expiresAt: number,
  ): void {
    this.transaction(() => {
      this.pruneDownloadTokens();
      this.db
        .prepare(
          "DELETE FROM download_tokens WHERE token_hash IN (SELECT token_hash FROM download_tokens WHERE user_id = ? ORDER BY expires_at DESC, token_hash DESC LIMIT -1 OFFSET 63)",
        )
        .run(userId);
      this.db
        .prepare(
          "INSERT INTO download_tokens (token_hash, file_id, user_id, session_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(tokenHash, fileId, userId, sessionHash, expiresAt);
    });
  }

  /**
   * Spends a ticket. Deleting and reading in one statement is what makes it
   * single use: two requests arriving together cannot both be served.
   */
  consumeDownloadToken(
    tokenHash: string,
    now = Date.now(),
  ): { fileId: ID; userId: ID; sessionHash: string } | null {
    const row = this.db
      .prepare(
        "DELETE FROM download_tokens WHERE token_hash = ? RETURNING file_id, user_id, session_hash, expires_at",
      )
      .get(tokenHash) as
      { file_id: string; user_id: string; session_hash: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= now) return null;
    return { fileId: row.file_id, userId: row.user_id, sessionHash: row.session_hash };
  }

  /** Tickets nobody spent. They are short-lived, so this is just tidying. */
  pruneDownloadTokens(now = Date.now()): void {
    this.db.prepare("DELETE FROM download_tokens WHERE expires_at <= ?").run(now);
  }

  /**
   * Of the blob ids given, the ones no `files` row knows about. A crash between
   * writing a blob and recording it leaves exactly this: bytes on disk that
   * count against the workspace but that nothing will ever ask to delete.
   */
  unknownFileIds(blobIds: ID[]): ID[] {
    if (blobIds.length === 0) return [];
    const known = new Set<string>();
    // Chunked: SQLite's variable limit is not large enough for a busy workspace.
    for (let i = 0; i < blobIds.length; i += 500) {
      const batch = blobIds.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT id FROM files WHERE id IN (${placeholders})`)
        .all(...batch) as { id: string }[];
      for (const row of rows) known.add(row.id);
    }
    return blobIds.filter((id) => !known.has(id));
  }

  /** The replies still standing in a thread, oldest first. */
  threadReplyIds(rootId: ID): ID[] {
    return (
      this.db
        .prepare(
          "SELECT id FROM messages WHERE thread_root_id = ? AND deleted_at IS NULL ORDER BY id",
        )
        .all(rootId) as { id: string }[]
    ).map((r) => r.id);
  }

  /** File ids belonging to a message — used to delete blobs when the message goes. */
  fileIdsForMessage(messageId: ID): ID[] {
    const rows = this.db.prepare("SELECT id FROM files WHERE message_id = ?").all(messageId) as {
      id: string;
    }[];
    return rows.map((r) => r.id);
  }

  deleteFiles(fileIds: ID[]): void {
    const stmt = this.db.prepare("DELETE FROM files WHERE id = ?");
    for (const id of fileIds) stmt.run(id);
  }

  queueFileDeletions(fileIds: ID[]): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO pending_file_deletions (file_id, queued_at) VALUES (?, ?)",
    );
    const now = Date.now();
    for (const id of fileIds) stmt.run(id, now);
  }

  /** Every removal still to do, set-aside ones included, oldest first. */
  pendingFileDeletions(): ID[] {
    return (
      this.db
        .prepare("SELECT file_id FROM pending_file_deletions ORDER BY queued_at, file_id")
        .all() as unknown as { file_id: string }[]
    ).map((row) => row.file_id);
  }

  /**
   * Removals due by `now`, in a stable order, at most `limit` (REV-02). One
   * that failed comes back only when its wait is over, so failures cannot
   * fill every page ahead of a removal that would succeed.
   */
  dueFileDeletions(now: number, limit: number): ID[] {
    return (
      this.db
        .prepare(
          `SELECT file_id FROM pending_file_deletions
           WHERE rejected = 0 AND next_attempt_at <= ?
           ORDER BY next_attempt_at, file_id LIMIT ?`,
        )
        .all(now, limit) as unknown as { file_id: string }[]
    ).map((row) => row.file_id);
  }

  completeFileDeletion(fileId: ID): void {
    this.db.prepare("DELETE FROM pending_file_deletions WHERE file_id = ?").run(fileId);
  }

  /** Waits longer after each failure: a minute, five, thirty, then two hours. */
  static readonly FILE_DELETION_RETRY_MS = [60_000, 300_000, 1_800_000, 7_200_000];

  /** A removal that failed; it is tried again later, and the rest go on. */
  deferFileDeletion(fileId: ID, now: number): void {
    const row = this.db
      .prepare("SELECT attempts FROM pending_file_deletions WHERE file_id = ?")
      .get(fileId) as { attempts: number } | undefined;
    if (!row) return;
    const waits = Store.FILE_DELETION_RETRY_MS;
    const wait = waits[Math.min(row.attempts, waits.length - 1)]!;
    this.db
      .prepare(
        "UPDATE pending_file_deletions SET attempts = attempts + 1, next_attempt_at = ? WHERE file_id = ?",
      )
      .run(now + wait, fileId);
  }

  /** A removal that can never succeed: set aside, never tried again, still counted. */
  rejectFileDeletion(fileId: ID): void {
    this.db.prepare("UPDATE pending_file_deletions SET rejected = 1 WHERE file_id = ?").run(fileId);
  }

  /** How attachment removal stands, in counts and times only. */
  fileDeletionCounts(): {
    waiting: number;
    retrying: number;
    rejected: number;
    oldestQueuedAt: number | null;
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE rejected = 0 AND attempts = 0) AS waiting,
                COUNT(*) FILTER (WHERE rejected = 0 AND attempts > 0) AS retrying,
                COUNT(*) FILTER (WHERE rejected = 1) AS rejected,
                MIN(queued_at) FILTER (WHERE rejected = 0) AS oldest
         FROM pending_file_deletions`,
      )
      .get() as { waiting: number; retrying: number; rejected: number; oldest: number | null };
    return {
      waiting: row.waiting,
      retrying: row.retrying,
      rejected: row.rejected,
      oldestQueuedAt: row.oldest,
    };
  }

  // ---------- reactions ----------

  addReaction(messageId: ID, userId: ID, emoji: string): boolean {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(messageId, userId, emoji, Date.now());
    return res.changes > 0;
  }

  removeReaction(messageId: ID, userId: ID, emoji: string): boolean {
    const res = this.db
      .prepare("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
      .run(messageId, userId, emoji);
    return res.changes > 0;
  }

  // ---------- polls (E6) ----------

  /** Makes a message a poll; its words are the question. */
  createPoll(
    messageId: ID,
    poll: { options: string[]; multiple: boolean; anonymous: boolean },
  ): void {
    this.db
      .prepare("INSERT INTO polls (message_id, options, multiple, anonymous) VALUES (?, ?, ?, ?)")
      .run(messageId, JSON.stringify(poll.options), poll.multiple ? 1 : 0, poll.anonymous ? 1 : 0);
  }

  /** What a poll offers and whether it is open, to check a vote against; null for no poll. */
  pollRules(
    messageId: ID,
  ): { options: number; multiple: boolean; anonymous: boolean; closedAt: number | null } | null {
    const row = this.db
      .prepare("SELECT options, multiple, anonymous, closed_at FROM polls WHERE message_id = ?")
      .get(messageId) as
      | { options: string; multiple: number; anonymous: number; closed_at: number | null }
      | undefined;
    if (!row) return null;
    return {
      options: (JSON.parse(row.options) as string[]).length,
      multiple: row.multiple === 1,
      anonymous: row.anonymous === 1,
      closedAt: row.closed_at,
    };
  }

  /** One account's choices in a poll, by option place. */
  pollChoices(messageId: ID, userId: ID): number[] {
    const rows = this.db
      .prepare("SELECT option FROM poll_votes WHERE message_id = ? AND user_id = ? ORDER BY option")
      .all(messageId, userId) as { option: number }[];
    return rows.map((row) => row.option);
  }

  /**
   * Replaces one account's choices in a poll; none takes the vote back. Says
   * whether anything changed, so choosing again what is chosen tells nobody.
   */
  setPollChoices(messageId: ID, userId: ID, choices: number[]): boolean {
    const before = this.pollChoices(messageId, userId);
    const after = [...new Set(choices)].sort((a, b) => a - b);
    if (before.length === after.length && before.every((c, i) => c === after[i])) return false;
    this.db
      .prepare("DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?")
      .run(messageId, userId);
    const insert = this.db.prepare(
      "INSERT INTO poll_votes (message_id, user_id, option, created_at) VALUES (?, ?, ?, ?)",
    );
    const now = Date.now();
    for (const option of after) insert.run(messageId, userId, option, now);
    return true;
  }

  /** Closes a poll for good; false when it was already closed. */
  closePoll(messageId: ID): boolean {
    const res = this.db
      .prepare("UPDATE polls SET closed_at = ? WHERE message_id = ? AND closed_at IS NULL")
      .run(Date.now(), messageId);
    return res.changes > 0;
  }

  /**
   * What one account chose in each anonymous poll it voted in and can still
   * read, for the handshake snapshot: no message says so. A poll that is not
   * anonymous says on each option who chose it.
   */
  anonymousPollChoices(userId: ID): Record<ID, number[]> {
    const rows = this.db
      .prepare(
        `SELECT v.message_id, v.option FROM poll_votes v
         JOIN polls p ON p.message_id = v.message_id
         JOIN messages m ON m.id = v.message_id
         JOIN channels c ON c.id = m.channel_id
         WHERE v.user_id = ? AND p.anonymous = 1 AND m.deleted_at IS NULL
           AND (c.type = 'public'
             OR EXISTS (SELECT 1 FROM channel_members cm
                        WHERE cm.channel_id = c.id AND cm.user_id = v.user_id))
         ORDER BY v.message_id, v.option`,
      )
      .all(userId) as { message_id: string; option: number }[];
    const choices: Record<ID, number[]> = {};
    for (const row of rows) (choices[row.message_id] ??= []).push(row.option);
    return choices;
  }

  // ---------- thread following ----------

  /**
   * A thread's follow state for one account. A thread this account has not
   * touched has no row: it reads as not followed, and read as far as the
   * membership's `replies_read_seq`, which is where a reply counts as read
   * without a cursor of its own thread (see migration v30).
   */
  threadFollow(userId: ID, rootId: ID): ThreadFollow | null {
    const row = this.db
      .prepare(
        `SELECT m.channel_id, f.following, f.last_read_seq, f.revision, f.unread_hold, f.muted,
           cm.replies_read_seq
         FROM messages m
         LEFT JOIN thread_follows f ON f.root_id = m.id AND f.user_id = ?
         LEFT JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
         WHERE m.id = ? AND m.deleted_at IS NULL AND m.thread_root_id IS NULL`,
      )
      .get(userId, userId, rootId) as
      | {
          channel_id: string;
          following: number | null;
          last_read_seq: number | null;
          revision: number | null;
          unread_hold: number | null;
          muted: number | null;
          replies_read_seq: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      rootId,
      channelId: row.channel_id,
      following: row.following === 1,
      lastReadSeq: row.last_read_seq ?? row.replies_read_seq ?? 0,
      lastSeq: this.threadLastSeq(rootId),
      revision: row.revision ?? 0,
      ...(row.unread_hold === null ? {} : { unreadHold: row.unread_hold }),
      ...(row.muted === 1 ? { muted: true as const } : {}),
    };
  }

  /**
   * Revisions order follow updates arriving out of turn on a second device.
   * Wall-clock time is the starting point, but a stored revision only ever
   * increases, so two changes inside the same millisecond still order.
   */
  private nextFollowRevision(): number {
    return Date.now();
  }

  /** The highest seq in a thread, counting the root itself. */
  private threadLastSeq(rootId: ID): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM messages
         WHERE (id = ? OR thread_root_id = ?) AND deleted_at IS NULL`,
      )
      .get(rootId, rootId) as { seq: number };
    return row.seq;
  }

  setThreadFollow(userId: ID, rootId: ID, following: boolean): ThreadFollow | null {
    const current = this.threadFollow(userId, rootId);
    if (!current) return null;
    // Following a thread mid-conversation should not present its whole history
    // as unread, so a new row starts caught up. Unfollowing one leaves what was
    // read as it was: following is not reading. Following ends a mute.
    this.db
      .prepare(
        `INSERT INTO thread_follows (user_id, root_id, following, last_read_seq, revision)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, root_id) DO UPDATE SET
           following = excluded.following,
           muted = CASE WHEN excluded.following = 1 THEN 0 ELSE thread_follows.muted END,
           revision = MAX(thread_follows.revision + 1, excluded.revision)`,
      )
      .run(
        userId,
        rootId,
        following ? 1 : 0,
        following ? Math.max(this.threadLastSeq(rootId), current.lastReadSeq) : current.lastReadSeq,
        this.nextFollowRevision(),
      );
    return this.threadFollow(userId, rootId);
  }

  /**
   * Mutes a thread for one account, or lifts that. Muting unfollows it and
   * keeps it unfollowed when this account replies; lifting it leaves it
   * unfollowed. Neither reads it: the cursor stays where it was.
   */
  setThreadMute(userId: ID, rootId: ID, muted: boolean): ThreadFollow | null {
    const current = this.threadFollow(userId, rootId);
    if (!current) return null;
    this.db
      .prepare(
        `INSERT INTO thread_follows (user_id, root_id, following, last_read_seq, revision, muted)
         VALUES (?, ?, 0, ?, ?, ?)
         ON CONFLICT(user_id, root_id) DO UPDATE SET
           following = CASE WHEN excluded.muted = 1 THEN 0 ELSE thread_follows.following END,
           muted = excluded.muted,
           revision = MAX(thread_follows.revision + 1, excluded.revision)`,
      )
      .run(userId, rootId, current.lastReadSeq, this.nextFollowRevision(), muted ? 1 : 0);
    return this.threadFollow(userId, rootId);
  }

  /**
   * Advances a thread's read cursor, followed or not: reading a thread is how
   * its replies, and the mentions in them, are read, and it reads nothing else
   * in the channel. A thread not followed gets a cursor without following it.
   * Clamped to what exists, so a client reporting a seq from a message it has
   * since lost cannot park the cursor in the future and hide later replies.
   */
  markThreadRead(userId: ID, rootId: ID, seq: number): ThreadFollow | null {
    const current = this.threadFollow(userId, rootId);
    if (!current) return null;
    // Never below what was already read, including without a row of its own.
    const target = Math.max(Math.min(seq, this.threadLastSeq(rootId)), current.lastReadSeq);
    this.db
      .prepare(
        `INSERT INTO thread_follows (user_id, root_id, following, last_read_seq, revision)
         VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(user_id, root_id) DO UPDATE SET
           last_read_seq = excluded.last_read_seq,
           unread_hold = NULL,
           revision = MAX(thread_follows.revision + 1, excluded.revision)
         WHERE thread_follows.last_read_seq < excluded.last_read_seq`,
      )
      .run(userId, rootId, target, this.nextFollowRevision());
    return this.threadFollow(userId, rootId);
  }

  /**
   * Leaves the root or a reply and everything after it unread. Marking a
   * thread unread is a statement of intent to come back, so it follows it too,
   * ending a mute.
   * It holds against the channel's cursor where that stands now: a reply also
   * sent to the channel stays unread until the thread is read, or the channel
   * is read past this point.
   */
  markThreadUnread(userId: ID, rootId: ID, seq: number): ThreadFollow | null {
    if (!this.threadFollow(userId, rootId)) return null;
    const target = this.db
      .prepare(
        `SELECT 1 FROM messages
         WHERE seq = ? AND seq > 0 AND deleted_at IS NULL
           AND (id = ? OR thread_root_id = ?) LIMIT 1`,
      )
      .get(seq, rootId, rootId);
    if (!target) return null;
    this.db
      .prepare(
        `INSERT INTO thread_follows (user_id, root_id, following, last_read_seq, revision, unread_hold)
         VALUES (?, ?, 1, ?, ?, (
           SELECT cm.last_read_seq FROM messages root
           JOIN channel_members cm ON cm.channel_id = root.channel_id AND cm.user_id = ?
           WHERE root.id = ?))
         ON CONFLICT(user_id, root_id) DO UPDATE SET
           following = 1,
           muted = 0,
           last_read_seq = excluded.last_read_seq,
           unread_hold = excluded.unread_hold,
           revision = MAX(thread_follows.revision + 1, excluded.revision)`,
      )
      .run(userId, rootId, Math.max(0, seq - 1), this.nextFollowRevision(), userId, rootId);
    return this.threadFollow(userId, rootId);
  }

  /**
   * Writing in a thread follows it. The author of a reply is caught up by
   * definition; the root's author starts from their own message so the reply
   * that just arrived counts as unread. An account that explicitly unfollowed
   * keeps that choice unless it is the one replying; one that muted the thread
   * keeps it even then, caught up to its own reply.
   */
  autoFollowThread(rootId: ID, replierId: ID, replySeq: number): void {
    const root = this.db
      .prepare(
        `SELECT user_id, seq FROM messages
         WHERE id = ? AND deleted_at IS NULL AND thread_root_id IS NULL`,
      )
      .get(rootId) as { user_id: string; seq: number } | undefined;
    if (!root) return;

    this.db
      .prepare(
        `INSERT INTO thread_follows (user_id, root_id, following, last_read_seq, revision)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(user_id, root_id) DO UPDATE SET
           following = CASE WHEN thread_follows.muted = 1 THEN 0 ELSE 1 END,
           last_read_seq = MAX(thread_follows.last_read_seq, excluded.last_read_seq),
           revision = MAX(thread_follows.revision + 1, excluded.revision)`,
      )
      .run(replierId, rootId, replySeq, this.nextFollowRevision());

    if (root.user_id !== replierId) {
      // From their own message, or from where their replies were already read
      // in a thread older than the row, whichever is later.
      const read = this.threadFollow(root.user_id, rootId)?.lastReadSeq ?? 0;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO thread_follows (user_id, root_id, following, last_read_seq, revision)
           VALUES (?, ?, 1, ?, ?)`,
        )
        .run(root.user_id, rootId, Math.max(root.seq, read), this.nextFollowRevision());
    }
  }

  /** Every follow row this account can still reach, for the handshake snapshot. */
  threadFollows(userId: ID): ThreadFollow[] {
    // One query rather than two per row: the handshake runs on every reconnect.
    const rows = this.db
      .prepare(
        `SELECT f.root_id, m.channel_id, f.following, f.last_read_seq, f.revision, f.unread_hold,
           f.muted, MAX(m.seq, COALESCE((
             SELECT MAX(r.seq) FROM messages r
             WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL
           ), 0)) AS last_seq
         FROM thread_follows f
         JOIN messages m ON m.id = f.root_id
         JOIN channels c ON c.id = m.channel_id
         WHERE f.user_id = ? AND m.deleted_at IS NULL AND (
           c.type = 'public'
           OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
         )`,
      )
      .all(userId, userId) as {
      root_id: string;
      channel_id: string;
      following: number;
      last_read_seq: number;
      revision: number;
      unread_hold: number | null;
      muted: number;
      last_seq: number;
    }[];
    return rows.map((row) => ({
      rootId: row.root_id,
      channelId: row.channel_id,
      following: row.following === 1,
      lastReadSeq: row.last_read_seq,
      lastSeq: row.last_seq,
      revision: row.revision,
      ...(row.unread_hold === null ? {} : { unreadHold: row.unread_hold }),
      ...(row.muted === 1 ? { muted: true as const } : {}),
    }));
  }

  /**
   * Followed threads, most recent activity first. Ordering by last activity
   * then root id keeps paging stable when two threads share a last seq.
   */
  followedThreads(
    userId: ID,
    limit = 30,
    cursor?: string,
    unreadOnly = false,
  ): { threads: FollowedThread[]; nextCursor: string | null } {
    const [beforeSeq, beforeId] = cursor?.split(":") ?? [];
    const boundary = beforeSeq ? Number(beforeSeq) : null;
    if (boundary !== null && !Number.isFinite(boundary)) {
      return { threads: [], nextCursor: null };
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT m.*,
             MAX(m.seq, COALESCE((
               SELECT MAX(r.seq) FROM messages r
               WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL
             ), 0)) AS last_seq,
             (SELECT COUNT(*) FROM messages r
              WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL
              AND r.seq > f.last_read_seq AND NOT ${Store.READ_IN_CHANNEL}) AS unread_count
           FROM thread_follows f
           JOIN messages m ON m.id = f.root_id
           JOIN channels c ON c.id = m.channel_id
           WHERE f.user_id = ? AND f.following = 1 AND m.deleted_at IS NULL AND (
             c.type = 'public'
             OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
           )
         )
         WHERE (? = 0 OR unread_count > 0)
         AND (? IS NULL OR last_seq < ? OR (last_seq = ? AND id < ?))
         ORDER BY last_seq DESC, id DESC LIMIT ?`,
      )
      .all(
        userId,
        userId,
        unreadOnly ? 1 : 0,
        boundary,
        boundary,
        boundary,
        beforeId ?? null,
        limit + 1,
      ) as unknown as (MessageRow & { last_seq: number; unread_count: number })[];
    const page = rows.slice(0, limit);
    const roots = this.hydrateMessages(page);
    const last = page.at(-1);
    return {
      threads: roots.map((root, index) => ({
        root,
        lastSeq: page[index]!.last_seq,
        unreadCount: page[index]!.unread_count,
      })),
      nextCursor: rows.length > limit && last ? `${last.last_seq}:${last.id}` : null,
    };
  }

  /** Everyone currently following a thread, for fanning an update out to them. */
  threadFollowers(rootId: ID): ID[] {
    const rows = this.db
      .prepare("SELECT user_id FROM thread_follows WHERE root_id = ? AND following = 1")
      .all(rootId) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  /** How many followed threads have replies this account has not seen. */
  unreadThreadCount(userId: ID): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM thread_follows f
         JOIN messages m ON m.id = f.root_id
         JOIN channels c ON c.id = m.channel_id
         WHERE f.user_id = ? AND f.following = 1 AND m.deleted_at IS NULL AND (
           c.type = 'public'
           OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
         )
         AND EXISTS (
           SELECT 1 FROM messages r WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL
           AND r.seq > f.last_read_seq AND NOT ${Store.READ_IN_CHANNEL}
         )`,
      )
      .get(userId, userId) as { n: number };
    return row.n;
  }

  // ---------- pins & saved items ----------

  addPin(channelId: ID, messageId: ID, userId: ID): boolean {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO pins (channel_id, message_id, user_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(channelId, messageId, userId, Date.now());
    return res.changes > 0;
  }

  removePin(messageId: ID): boolean {
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
    const rows = this.db
      .prepare(
        `SELECT m.*, p.created_at AS pinned_at FROM pins p JOIN messages m ON m.id = p.message_id
         WHERE ${shown}
         AND (? IS NULL OR p.created_at < ? OR (p.created_at = ? AND p.message_id < ?))
         ORDER BY p.created_at DESC, p.message_id DESC LIMIT ?`,
      )
      .all(
        channelId,
        timestamp,
        timestamp,
        timestamp,
        beforeId ?? null,
        limit + 1,
      ) as unknown as (MessageRow & { pinned_at: number })[];
    const { total } = this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM pins p JOIN messages m ON m.id = p.message_id WHERE ${shown}`,
      )
      .get(channelId) as { total: number };
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      messages: this.hydrateMessages(page),
      nextCursor: rows.length > limit && last ? `${last.pinned_at}:${last.id}` : null,
      total,
    };
  }

  addSaved(userId: ID, messageId: ID): boolean {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO saved_items (user_id, message_id, created_at) VALUES (?, ?, ?)",
      )
      .run(userId, messageId, Date.now());
    return res.changes > 0;
  }

  removeSaved(userId: ID, messageId: ID): boolean {
    const res = this.db
      .prepare("DELETE FROM saved_items WHERE user_id = ? AND message_id = ?")
      .run(userId, messageId);
    return res.changes > 0;
  }

  savedMessageIds(userId: ID): ID[] {
    const rows = this.db
      .prepare(
        `SELECT s.message_id FROM saved_items s JOIN messages m ON m.id = s.message_id
         WHERE s.user_id = ? AND m.deleted_at IS NULL ORDER BY s.created_at DESC`,
      )
      .all(userId) as { message_id: string }[];
    return rows.map((r) => r.message_id);
  }

  /** Saved messages the user can still reach, newest save first. */
  listSaved(
    userId: ID,
    limit = 30,
    cursor?: string,
  ): { messages: Message[]; nextCursor: string | null } {
    const [beforeTime, beforeId] = cursor?.split(":") ?? [];
    const rows = this.db
      .prepare(
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
      )
      .all(
        userId,
        userId,
        beforeTime ? Number(beforeTime) : null,
        beforeTime ? Number(beforeTime) : null,
        beforeTime ? Number(beforeTime) : null,
        beforeId ?? null,
        limit + 1,
      ) as unknown as (MessageRow & { saved_at: number })[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      messages: this.hydrateMessages(page),
      nextCursor: rows.length > limit && last ? `${last.saved_at}:${last.id}` : null,
    };
  }

  // ---------- reminders ----------

  /**
   * The reminders' join with their message and its conversation. Reachable
   * means the message is still there and the account can read its
   * conversation. A deleted thread's replies are deleted with it.
   */
  private static readonly REMINDER_REACHABLE = `m.deleted_at IS NULL
    AND (c.type = 'public'
      OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = r.user_id))`;

  private static reminderFrom(row: ReminderRow): Reminder {
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
  getReminder(userId: ID, messageId: ID): Reminder | null {
    const row = this.db
      .prepare(
        `SELECT r.*, m.channel_id, m.thread_root_id FROM reminders r
         JOIN messages m ON m.id = r.message_id
         WHERE r.user_id = ? AND r.message_id = ?`,
      )
      .get(userId, messageId) as ReminderRow | undefined;
    return row ? Store.reminderFrom(row) : null;
  }

  /** Sets a reminder, or moves the one already there, waiting again. */
  setReminder(userId: ID, messageId: ID, remindAt: number): Reminder {
    this.db
      .prepare(
        `INSERT INTO reminders (id, user_id, message_id, remind_at, due_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(user_id, message_id) DO UPDATE SET
           remind_at = excluded.remind_at,
           due_at = NULL`,
      )
      .run(ulid(), userId, messageId, remindAt, Date.now());
    return this.getReminder(userId, messageId)!;
  }

  deleteReminder(userId: ID, messageId: ID): boolean {
    const res = this.db
      .prepare("DELETE FROM reminders WHERE user_id = ? AND message_id = ?")
      .run(userId, messageId);
    return res.changes > 0;
  }

  /** Drops every reminder about a message, saying whose they were. */
  dropMessageReminders(messageId: ID): ID[] {
    const rows = this.db
      .prepare("DELETE FROM reminders WHERE message_id = ? RETURNING user_id")
      .all(messageId) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  countReminders(userId: ID): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?")
      .get(userId) as { n: number };
    return row.n;
  }

  /** The reminders an account can still reach, for the handshake snapshot. */
  reminders(userId: ID): Reminder[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, m.channel_id, m.thread_root_id FROM reminders r
         JOIN messages m ON m.id = r.message_id
         JOIN channels c ON c.id = m.channel_id
         WHERE r.user_id = ? AND ${Store.REMINDER_REACHABLE}`,
      )
      .all(userId) as unknown as ReminderRow[];
    return rows.map(Store.reminderFrom);
  }

  /**
   * The Reminders list: those come due, the latest first, then those waiting,
   * the soonest first, each with its message.
   */
  listReminders(userId: ID): ReminderItem[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, r.id AS reminder_id, r.remind_at, r.due_at FROM reminders r
         JOIN messages m ON m.id = r.message_id
         JOIN channels c ON c.id = m.channel_id
         WHERE r.user_id = ? AND ${Store.REMINDER_REACHABLE}
         ORDER BY r.due_at IS NULL, r.due_at DESC, r.remind_at, r.id`,
      )
      .all(userId) as unknown as (MessageRow & {
      reminder_id: string;
      remind_at: number;
      due_at: number | null;
    })[];
    const messages = this.hydrateMessages(rows);
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
  nextReminderAt(): number | null {
    const row = this.db
      .prepare("SELECT MIN(remind_at) AS at FROM reminders WHERE due_at IS NULL")
      .get() as { at: number | null };
    return row.at;
  }

  /** Waiting reminders whose time has come, the earliest first, with whose they are. */
  dueReminders(now: number, limit: number): (Reminder & { userId: ID })[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, m.channel_id, m.thread_root_id FROM reminders r
         JOIN messages m ON m.id = r.message_id
         WHERE r.due_at IS NULL AND r.remind_at <= ?
         ORDER BY r.remind_at, r.id LIMIT ?`,
      )
      .all(now, limit) as unknown as ReminderRow[];
    return rows.map((row) => ({ ...Store.reminderFrom(row), userId: row.user_id }));
  }

  markReminderDue(userId: ID, messageId: ID, at: number): Reminder | null {
    this.db
      .prepare(
        "UPDATE reminders SET due_at = ? WHERE user_id = ? AND message_id = ? AND due_at IS NULL",
      )
      .run(at, userId, messageId);
    return this.getReminder(userId, messageId);
  }

  // ---------- scheduled messages ----------

  scheduledRequest(userId: ID, nonce: string): { scheduledId: ID; requestHash: string } | null {
    return (
      (this.db
        .prepare(
          "SELECT scheduled_id AS scheduledId, request_hash AS requestHash FROM scheduled_requests WHERE user_id = ? AND nonce = ?",
        )
        .get(userId, nonce) as { scheduledId: ID; requestHash: string } | undefined) ?? null
    );
  }

  recordScheduledRequest(userId: ID, nonce: string, scheduledId: ID, requestHash: string): void {
    this.db
      .prepare(
        "INSERT INTO scheduled_requests (user_id, nonce, scheduled_id, request_hash) VALUES (?, ?, ?, ?)",
      )
      .run(userId, nonce, scheduledId, requestHash);
  }

  scheduleMessage(input: {
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
    return this.getScheduled(id)!;
  }

  private toScheduled(r: {
    id: string;
    channel_id: string;
    user_id: string;
    text: string;
    thread_root_id: string | null;
    file_ids: string;
    send_at: number;
    created_at: number;
    status: string;
    failure_reason: string | null;
    attempts: number;
    message_id: string | null;
    broadcast: number;
  }): ScheduledMessage {
    let fileIds: ID[] = [];
    try {
      fileIds = JSON.parse(r.file_ids) as ID[];
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
      status: r.status as ScheduledMessage["status"],
      failureReason: r.failure_reason,
      attempts: r.attempts,
      messageId: r.message_id,
    };
  }

  getScheduled(id: ID): ScheduledMessage | null {
    const r = this.db.prepare("SELECT * FROM scheduled_messages WHERE id = ?").get(id) as
      Parameters<Store["toScheduled"]>[0] | undefined;
    return r ? this.toScheduled(r) : null;
  }

  /** One user's outstanding messages, soonest first. Delivered ones are done. */
  listScheduled(userId: ID): ScheduledMessage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM scheduled_messages WHERE user_id = ? AND status != 'sent' ORDER BY send_at",
      )
      .all(userId) as unknown as Parameters<Store["toScheduled"]>[0][];
    return rows.map((r) => this.toScheduled(r));
  }

  /**
   * Messages now due, across all users. Held ones come back every flush so a
   * reversible obstacle — an archived channel, lost membership, a deactivated
   * author — sends the message once it clears. The caller re-checks those
   * conditions: the queue lives on the server, so without that check a message
   * could post itself in the name of someone whose access was taken away
   * yesterday.
   */
  dueScheduled(now = Date.now(), limit = 50): ScheduledMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_messages
         WHERE send_at <= ? AND (
           status = 'queued' OR (status = 'held' AND next_attempt_at <= ?)
         )
         ORDER BY send_at, id
         LIMIT ?`,
      )
      .all(now, now, limit) as unknown as Parameters<Store["toScheduled"]>[0][];
    return rows.map((r) => this.toScheduled(r));
  }

  /**
   * Brings held messages forward to the next flush, once what held them may
   * have cleared: a channel reopened, a membership regained, an account
   * reactivated. The flush checks again, so waking one too many is harmless.
   */
  wakeHeldScheduled(scope: { channelId?: ID; userId?: ID }): void {
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
  outstandingScheduled(userId?: ID): number {
    const row = (
      userId
        ? this.db
            .prepare(
              "SELECT COUNT(*) AS n FROM scheduled_messages WHERE user_id = ? AND status != 'sent'",
            )
            .get(userId)
        : this.db
            .prepare("SELECT COUNT(*) AS n FROM scheduled_messages WHERE status != 'sent'")
            .get()
    ) as { n: number };
    return row.n;
  }

  /**
   * Delivery, written inside the posting transaction so neither can happen
   * alone. Its files are the message's now, so the schedule lets go of them.
   */
  markScheduledSent(id: ID, messageId: ID): void {
    this.db
      .prepare(
        `UPDATE scheduled_messages SET status = 'sent', message_id = ?, failure_reason = NULL,
           text = '', file_ids = '[]' WHERE id = ?`,
      )
      .run(messageId, id);
    this.db.prepare("DELETE FROM scheduled_files WHERE scheduled_id = ?").run(id);
  }

  /**
   * A reason that may clear on its own. It is tried again at `retryAt`, or
   * sooner if `wakeHeldScheduled` hears that the obstacle has gone.
   */
  holdScheduled(id: ID, reason: string, retryAt = 0): void {
    this.db
      .prepare(
        "UPDATE scheduled_messages SET status = 'held', failure_reason = ?, next_attempt_at = ? WHERE id = ?",
      )
      .run(reason, retryAt, id);
  }

  /** Terminal. Only an explicit reschedule puts it back in the queue. */
  failScheduled(id: ID, reason: string): void {
    this.db
      .prepare("UPDATE scheduled_messages SET status = 'failed', failure_reason = ? WHERE id = ?")
      .run(reason, id);
  }

  /** Counts one delivery attempt and returns the new total, so retries stay bounded. */
  countScheduledAttempt(id: ID): number {
    this.db.prepare("UPDATE scheduled_messages SET attempts = attempts + 1 WHERE id = ?").run(id);
    return (
      (
        this.db.prepare("SELECT attempts FROM scheduled_messages WHERE id = ?").get(id) as
          { attempts: number } | undefined
      )?.attempts ?? 0
    );
  }

  /** Puts a held or failed message back in the queue at a new time. */
  rescheduleMessage(id: ID, sendAt: number): void {
    this.db
      .prepare(
        `UPDATE scheduled_messages
         SET send_at = ?, status = 'queued', failure_reason = NULL, attempts = 0,
           next_attempt_at = 0
         WHERE id = ? AND status != 'sent'`,
      )
      .run(sendAt, id);
  }

  /** Compare-and-set text without requeuing or changing delivery metadata. */
  editScheduledText(id: ID, text: string, expectedText: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE scheduled_messages SET text = ?
       WHERE id = ? AND status != 'sent' AND (text = ? OR text = ?)`,
        )
        .run(text, id, expectedText, text).changes === 1
    );
  }

  /** Delivered rows are kept as proof of completion, then aged out. */
  pruneScheduled(before: number): void {
    this.db
      .prepare("DELETE FROM scheduled_messages WHERE status = 'sent' AND send_at < ?")
      .run(before);
  }

  /** True when every id is one of this user's own unattached uploads in this channel. */
  unattachedFiles(fileIds: ID[], channelId: ID, userId: ID): boolean {
    const stmt = this.db.prepare(
      "SELECT 1 FROM files WHERE id = ? AND user_id = ? AND channel_id = ? AND message_id IS NULL",
    );
    return fileIds.every((id) => stmt.get(id, userId, channelId) !== undefined);
  }

  /** Cancels one. Its files go with the row, free for another message. */
  deleteScheduled(id: ID): boolean {
    const res = this.db.prepare("DELETE FROM scheduled_messages WHERE id = ?").run(id);
    return res.changes > 0;
  }

  // ---------- apps, tokens and webhooks ----------

  /** Creates the bot user that an app posts as. */
  createBotUser(handle: string, displayName: string, passwordHash: string, salt: string): User {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO users (id, handle, display_name, password_hash, salt, role, is_bot, created_at)
         VALUES (?, ?, ?, ?, ?, 'member', 1, ?)`,
      )
      .run(id, handle, displayName, passwordHash, salt, Date.now());
    return this.getUser(id)!;
  }

  createApp(input: {
    name: string;
    botUserId: ID;
    createdBy: ID;
    signingSecret: string;
    /** Left out, everything, as every app could before scopes (E18c). */
    scopes?: readonly AppScope[];
  }): App {
    const id = ulid();
    const now = Date.now();
    const scopes = scopeList(input.scopes ?? APP_SCOPES);
    this.db
      .prepare(
        "INSERT INTO apps (id, name, bot_user_id, created_by, created_at, signing_secret, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.name,
        input.botUserId,
        input.createdBy,
        now,
        input.signingSecret,
        JSON.stringify(scopes),
      );
    return {
      id,
      name: input.name,
      botUserId: input.botUserId,
      createdBy: input.createdBy,
      createdAt: now,
      interactivityUrl: "",
      scopes,
    };
  }

  /** Replaces what an app may do (E18c). */
  setAppScopes(id: ID, scopes: readonly AppScope[]): boolean {
    return (
      this.db
        .prepare("UPDATE apps SET scopes = ? WHERE id = ?")
        .run(JSON.stringify(scopeList(scopes)), id).changes > 0
    );
  }

  /** Where this app's button clicks go. Empty leaves its buttons inert. */
  setInteractivityUrl(id: ID, url: string): boolean {
    return (
      this.db.prepare("UPDATE apps SET interactivity_url = ? WHERE id = ?").run(url, id).changes > 0
    );
  }

  /** The app a bot user posts as, for tracing a message back to its owner. */
  appForBotUser(botUserId: ID): App | null {
    const r = this.db.prepare("SELECT * FROM apps WHERE bot_user_id = ?").get(botUserId) as
      Parameters<Store["toApp"]>[0] | undefined;
    return r ? this.toApp(r) : null;
  }

  /**
   * The key an app signs with. Admin-visible by design — the receiving end
   * needs it to verify, exactly as Slack shows a signing secret in app config.
   */
  appSigningSecret(id: ID): string | null {
    const r = this.db.prepare("SELECT signing_secret FROM apps WHERE id = ?").get(id) as
      { signing_secret: string } | undefined;
    return r?.signing_secret ?? null;
  }

  private toApp(r: {
    id: string;
    name: string;
    bot_user_id: string;
    created_by: string;
    created_at: number;
    interactivity_url?: string;
    scopes?: string;
  }): App {
    return {
      id: r.id,
      name: r.name,
      botUserId: r.bot_user_id,
      createdBy: r.created_by,
      createdAt: r.created_at,
      interactivityUrl: r.interactivity_url ?? "",
      scopes: scopeList(parseJsonArray(r.scopes)),
    };
  }

  getApp(id: ID): App | null {
    const r = this.db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as
      Parameters<Store["toApp"]>[0] | undefined;
    return r ? this.toApp(r) : null;
  }

  listApps(): App[] {
    const rows = this.db
      .prepare("SELECT * FROM apps ORDER BY created_at DESC")
      .all() as unknown as Parameters<Store["toApp"]>[0][];
    return rows.map((r) => this.toApp(r));
  }

  deleteApp(id: ID): void {
    // Tokens and hooks are meaningless without their app.
    this.db.prepare("DELETE FROM slash_commands WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM event_subscriptions WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM webhooks WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM app_tokens WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM apps WHERE id = ?").run(id);
  }

  addAppToken(appId: ID, tokenHash: string): void {
    this.db
      .prepare("INSERT INTO app_tokens (token_hash, app_id, created_at) VALUES (?, ?, ?)")
      .run(tokenHash, appId, Date.now());
  }

  /**
   * Swaps every token an app holds for one new one. The old ones stop working
   * with this write rather than after some overlap: rotating is what someone
   * does when a token has leaked, and a window in which both work is a window
   * in which the leaked one still does.
   */
  replaceAppTokens(appId: ID, tokenHash: string): void {
    this.db.prepare("DELETE FROM app_tokens WHERE app_id = ?").run(appId);
    this.addAppToken(appId, tokenHash);
  }

  setAppSigningSecret(appId: ID, signingSecret: string): boolean {
    return (
      this.db.prepare("UPDATE apps SET signing_secret = ? WHERE id = ?").run(signingSecret, appId)
        .changes > 0
    );
  }

  /** The app a bot token belongs to, or null if it is unknown. */
  /**
   * The app a bot token belongs to. A deactivated bot user is refused here as
   * well as at the login form: silencing a misbehaving integration should not
   * mean deleting it and losing its configuration.
   */
  appForToken(tokenHash: string): App | null {
    const r = this.db
      .prepare(
        `SELECT a.* FROM app_tokens t
         JOIN apps a ON a.id = t.app_id
         JOIN users u ON u.id = a.bot_user_id
         WHERE t.token_hash = ? AND u.deactivated = 0`,
      )
      .get(tokenHash) as Parameters<Store["toApp"]>[0] | undefined;
    return r ? this.toApp(r) : null;
  }

  createWebhook(input: { appId: ID; channelId: ID; tokenHash: string }): Webhook {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO webhooks (id, app_id, channel_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, input.appId, input.channelId, input.tokenHash, now);
    return { id, appId: input.appId, channelId: input.channelId, createdAt: now };
  }

  /** A new secret for an existing webhook, which keeps its channel and its id. */
  replaceWebhookToken(id: ID, tokenHash: string): Webhook | null {
    const changed = this.db
      .prepare("UPDATE webhooks SET token_hash = ? WHERE id = ?")
      .run(tokenHash, id).changes;
    if (changed === 0) return null;
    const r = this.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as {
      id: string;
      app_id: string;
      channel_id: string;
      created_at: number;
    };
    return { id: r.id, appId: r.app_id, channelId: r.channel_id, createdAt: r.created_at };
  }

  /** Resolves an incoming webhook secret to its app and target channel. */
  webhookForToken(tokenHash: string): { webhook: Webhook; app: App } | null {
    const r = this.db.prepare("SELECT * FROM webhooks WHERE token_hash = ?").get(tokenHash) as
      { id: string; app_id: string; channel_id: string; created_at: number } | undefined;
    if (!r) return null;
    const app = this.getApp(r.app_id);
    // Same as a bot token: a deactivated bot's webhooks go quiet too.
    if (!app || this.getUser(app.botUserId)?.deactivated) return null;
    return {
      webhook: { id: r.id, appId: r.app_id, channelId: r.channel_id, createdAt: r.created_at },
      app,
    };
  }

  getWebhook(id: ID): Webhook | null {
    const r = this.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as
      { id: string; app_id: string; channel_id: string; created_at: number } | undefined;
    return r
      ? { id: r.id, appId: r.app_id, channelId: r.channel_id, createdAt: r.created_at }
      : null;
  }

  listWebhooks(appId: ID): Webhook[] {
    const rows = this.db
      .prepare("SELECT * FROM webhooks WHERE app_id = ? ORDER BY created_at")
      .all(appId) as unknown as {
      id: string;
      app_id: string;
      channel_id: string;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      appId: r.app_id,
      channelId: r.channel_id,
      createdAt: r.created_at,
    }));
  }

  deleteWebhook(id: ID): boolean {
    return this.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id).changes > 0;
  }

  // ---------- slash commands ----------

  private toCommand(r: {
    id: string;
    app_id: string;
    command: string;
    url: string;
    description: string;
    usage_hint: string;
    created_at: number;
  }): SlashCommand {
    return {
      id: r.id,
      appId: r.app_id,
      command: r.command,
      url: r.url,
      description: r.description,
      usageHint: r.usage_hint,
      createdAt: r.created_at,
    };
  }

  createSlashCommand(input: {
    appId: ID;
    command: string;
    url: string;
    description: string;
    usageHint: string;
  }): SlashCommand {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO slash_commands (id, app_id, command, url, description, usage_hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.appId, input.command, input.url, input.description, input.usageHint, now);
    return { id, ...input, createdAt: now };
  }

  /** Looks a command up by the word the user typed, without its slash. */
  slashCommandByName(command: string): { command: SlashCommand; app: App } | null {
    const r = this.db.prepare("SELECT * FROM slash_commands WHERE command = ?").get(command) as
      Parameters<Store["toCommand"]>[0] | undefined;
    if (!r) return null;
    const app = this.getApp(r.app_id);
    return app ? { command: this.toCommand(r), app } : null;
  }

  getSlashCommand(id: ID): SlashCommand | null {
    const r = this.db.prepare("SELECT * FROM slash_commands WHERE id = ?").get(id) as
      Parameters<Store["toCommand"]>[0] | undefined;
    return r ? this.toCommand(r) : null;
  }

  listSlashCommands(appId: ID): SlashCommand[] {
    const rows = this.db
      .prepare("SELECT * FROM slash_commands WHERE app_id = ? ORDER BY command")
      .all(appId) as unknown as Parameters<Store["toCommand"]>[0][];
    return rows.map((r) => this.toCommand(r));
  }

  /** Every command in the workspace — what the composer's hint list shows. */
  listAllSlashCommands(): SlashCommand[] {
    const rows = this.db
      .prepare("SELECT * FROM slash_commands ORDER BY command")
      .all() as unknown as Parameters<Store["toCommand"]>[0][];
    return rows.map((r) => this.toCommand(r));
  }

  deleteSlashCommand(id: ID): boolean {
    return this.db.prepare("DELETE FROM slash_commands WHERE id = ?").run(id).changes > 0;
  }

  // ---------- outgoing event subscriptions ----------

  private toSubscription(r: {
    id: string;
    app_id: string;
    url: string;
    event_types: string;
    created_at: number;
    dropped_count?: number;
    pending_count?: number;
    failed_count?: number;
    retrying_count?: number;
    last_error?: string | null;
    last_failed_at?: number | null;
  }): EventSubscription {
    return {
      id: r.id,
      appId: r.app_id,
      url: r.url,
      eventTypes: JSON.parse(r.event_types) as string[],
      createdAt: r.created_at,
      ...(r.pending_count !== undefined
        ? {
            delivery: {
              pending: r.pending_count,
              failed: r.failed_count ?? 0,
              retrying: r.retrying_count ?? 0,
              dropped: r.dropped_count ?? 0,
              lastError: r.last_error ?? null,
              lastFailedAt: r.last_failed_at ?? null,
            },
          }
        : {}),
    };
  }

  createSubscription(input: { appId: ID; url: string; eventTypes: string[] }): EventSubscription {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO event_subscriptions (id, app_id, url, event_types, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, input.appId, input.url, JSON.stringify(input.eventTypes), now);
    return { id, ...input, createdAt: now };
  }

  listSubscriptions(appId: ID): EventSubscription[] {
    const rows = this.db
      .prepare(
        `SELECT s.*,
          (SELECT COUNT(*) FROM event_deliveries d
           WHERE d.subscription_id = s.id AND d.failed_at IS NULL) AS pending_count,
          (SELECT COUNT(*) FROM event_deliveries d
           WHERE d.subscription_id = s.id AND d.failed_at IS NOT NULL
             AND d.retry_requested = 0) AS failed_count,
          (SELECT COUNT(*) FROM event_deliveries d
           WHERE d.subscription_id = s.id AND d.retry_requested = 1) AS retrying_count,
          (SELECT d.last_error FROM event_deliveries d
           WHERE d.subscription_id = s.id AND d.failed_at IS NOT NULL
           ORDER BY d.failed_at DESC, d.id DESC LIMIT 1) AS last_error,
          (SELECT d.failed_at FROM event_deliveries d
           WHERE d.subscription_id = s.id AND d.failed_at IS NOT NULL
           ORDER BY d.failed_at DESC, d.id DESC LIMIT 1) AS last_failed_at
         FROM event_subscriptions s WHERE s.app_id = ? ORDER BY s.created_at`,
      )
      .all(appId) as unknown as Parameters<Store["toSubscription"]>[0][];
    return rows.map((r) => this.toSubscription(r));
  }

  getSubscription(id: ID): EventSubscription | null {
    const row = this.db.prepare("SELECT * FROM event_subscriptions WHERE id = ?").get(id) as
      Parameters<Store["toSubscription"]>[0] | undefined;
    return row ? this.toSubscription(row) : null;
  }

  /** Every subscription plus its app, so delivery needs one query per event. */
  listAllSubscriptions(): { subscription: EventSubscription; app: App }[] {
    const rows = this.db
      .prepare(
        "SELECT s.*, a.id AS a_id, a.name AS a_name, a.bot_user_id, a.created_by, a.created_at AS a_created_at, a.scopes AS a_scopes" +
          " FROM event_subscriptions s JOIN apps a ON a.id = s.app_id" +
          " JOIN users u ON u.id = a.bot_user_id WHERE u.deactivated = 0",
      )
      .all() as unknown as (Parameters<Store["toSubscription"]>[0] & {
      a_id: string;
      a_name: string;
      bot_user_id: string;
      created_by: string;
      a_created_at: number;
      a_scopes: string;
    })[];
    return rows.map((r) => ({
      subscription: this.toSubscription(r),
      app: this.toApp({
        id: r.a_id,
        name: r.a_name,
        bot_user_id: r.bot_user_id,
        created_by: r.created_by,
        created_at: r.a_created_at,
        scopes: r.a_scopes,
      }),
    }));
  }

  deleteSubscription(id: ID): boolean {
    return this.db.prepare("DELETE FROM event_subscriptions WHERE id = ?").run(id).changes > 0;
  }

  // ---------- durable outgoing event delivery ----------

  /**
   * The most events one endpoint may have waiting. Delivery is ordered, so a
   * receiver that stops answering holds up everything behind it; without a
   * ceiling its queue would grow for as long as the workspace stays busy, and
   * every row carries a full event body. Past the ceiling the event is counted
   * as dropped instead, which is visible to an administrator and bounded.
   */
  static readonly MAX_PENDING_DELIVERIES = 500;
  /**
   * The most events given up on that one endpoint keeps for an administrator
   * to retry (REV-15). A dead endpoint fails a full queue every few hours, so
   * a week's history would otherwise be thousands of rows; past this the
   * oldest go, counted as dropped. With message text capped at 4,000
   * characters, an endpoint's waiting and given-up rows stay within tens of
   * megabytes.
   */
  static readonly MAX_FAILED_DELIVERIES = 1_000;

  /** True if the event was queued, false if the backlog was already full. */
  enqueueEventDelivery(
    subscriptionId: ID,
    channelId: ID | null,
    eventSeq: number,
    body: string,
    now = Date.now(),
    /** The message whose words the body carries, so an edit or delete can find it. */
    messageId: ID | null = null,
  ): boolean {
    // OFFSET stops the scan at the ceiling rather than counting a long backlog
    // on every event.
    const full = this.db
      .prepare(
        "SELECT 1 FROM event_deliveries WHERE subscription_id = ? AND failed_at IS NULL LIMIT 1 OFFSET ?",
      )
      .get(subscriptionId, Store.MAX_PENDING_DELIVERIES - 1);
    if (full) {
      this.db
        .prepare("UPDATE event_subscriptions SET dropped_count = dropped_count + 1 WHERE id = ?")
        .run(subscriptionId);
      return false;
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO event_deliveries
           (id, subscription_id, channel_id, event_seq, body, next_attempt_at, created_at, message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ulid(), subscriptionId, channelId, eventSeq, body, now, now, messageId);
    return true;
  }

  /**
   * At most one event per subscription is returned. An older retry blocks newer
   * events for that endpoint, preserving event-sequence order. Subscriptions in
   * `busy` (an event of theirs is already on its way) are left out entirely.
   */
  dueEventDeliveries(
    now = Date.now(),
    limit = 10,
    busy: readonly ID[] = [],
  ): {
    id: ID;
    subscriptionId: ID;
    eventSeq: number;
    body: string;
    attempts: number;
    url: string;
    signingSecret: string;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.subscription_id, d.event_seq, d.body, d.attempts,
                s.url, a.signing_secret
         FROM event_deliveries d
         JOIN event_subscriptions s ON s.id = d.subscription_id
         JOIN apps a ON a.id = s.app_id
         JOIN users u ON u.id = a.bot_user_id
         WHERE d.failed_at IS NULL AND d.next_attempt_at <= ? AND u.deactivated = 0
           AND (d.channel_id IS NULL OR EXISTS (
             SELECT 1 FROM channel_members cm
             WHERE cm.channel_id = d.channel_id AND cm.user_id = a.bot_user_id
           ))
           AND NOT EXISTS (
             SELECT 1 FROM event_deliveries older
             WHERE older.subscription_id = d.subscription_id
               AND older.failed_at IS NULL
               AND (older.event_seq < d.event_seq OR
                    (older.event_seq = d.event_seq AND older.id < d.id))
           )
           AND d.subscription_id NOT IN (SELECT value FROM json_each(?))
         ORDER BY d.next_attempt_at, d.event_seq, d.id LIMIT ?`,
      )
      .all(now, JSON.stringify(busy), limit) as unknown as {
      id: string;
      subscription_id: string;
      event_seq: number;
      body: string;
      attempts: number;
      url: string;
      signing_secret: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      subscriptionId: r.subscription_id,
      eventSeq: r.event_seq,
      body: r.body,
      attempts: r.attempts,
      url: r.url,
      signingSecret: r.signing_secret,
    }));
  }

  completeEventDelivery(id: ID, subscriptionId: ID): boolean {
    const done = this.db.prepare("DELETE FROM event_deliveries WHERE id = ?").run(id).changes > 0;
    // A slot has freed up: an event waiting to be retried takes it before a
    // new event can, so a retry drains however busy the workspace is.
    if (done) this.promoteEventRetries(subscriptionId);
    // Events lost to a full backlog stop being current news once the endpoint
    // is answering again. The guard keeps this free on the usual path, where
    // there is nothing to clear.
    this.db
      .prepare(
        "UPDATE event_subscriptions SET dropped_count = 0 WHERE id = ? AND dropped_count != 0",
      )
      .run(subscriptionId);
    return done;
  }

  failEventDelivery(
    id: ID,
    error: string,
    nextAttemptAt: number,
    maxAttempts: number,
    now = Date.now(),
  ): { attempts: number; terminal: boolean } | null {
    this.db
      .prepare(
        `UPDATE event_deliveries SET
           attempts = attempts + 1,
           next_attempt_at = ?,
           last_error = ?,
           failed_at = CASE WHEN attempts + 1 >= ? THEN ? ELSE NULL END
         WHERE id = ?`,
      )
      .run(nextAttemptAt, error.slice(0, 500), maxAttempts, now, id);
    const row = this.db
      .prepare("SELECT attempts, failed_at FROM event_deliveries WHERE id = ?")
      .get(id) as { attempts: number; failed_at: number | null } | undefined;
    return row ? { attempts: row.attempts, terminal: row.failed_at !== null } : null;
  }

  /**
   * Gives up on everything still queued for one endpoint.
   *
   * Called once a delivery has exhausted its attempts. Spending the full ladder
   * on each event in turn would mean a dead endpoint is retried forever while
   * its queue keeps growing, and would leave an administrator repairing it with
   * a backlog that drains one event every few hours. Failing the rest together
   * makes "retry failed" the single way back, and it restores them in order.
   */
  abandonEventBacklog(subscriptionId: ID, error: string, now = Date.now()): number {
    const abandoned = Number(
      this.db
        .prepare(
          `UPDATE event_deliveries SET failed_at = ?, last_error = ?
           WHERE subscription_id = ? AND failed_at IS NULL`,
        )
        .run(now, error.slice(0, 500), subscriptionId).changes,
    );
    // The endpoint failed again, so what was still waiting to be retried waits
    // for another retry, kept with the rest of what was given up on. It is
    // given up on now, so it is kept for the whole history window from now
    // rather than expiring at once for having first failed long ago (F04).
    this.db
      .prepare(
        "UPDATE event_deliveries SET retry_requested = 0, failed_at = ? WHERE subscription_id = ? AND retry_requested = 1",
      )
      .run(now, subscriptionId);
    this.trimFailedEventDeliveries(subscriptionId);
    return abandoned;
  }

  /**
   * Keeps an endpoint's given-up events within MAX_FAILED_DELIVERIES, the
   * newest kept, the rest counted as dropped (REV-15).
   */
  private trimFailedEventDeliveries(subscriptionId: ID): void {
    const trimmed = Number(
      this.db
        .prepare(
          `DELETE FROM event_deliveries WHERE id IN (
             SELECT id FROM event_deliveries
             WHERE subscription_id = ? AND failed_at IS NOT NULL AND retry_requested = 0
             ORDER BY event_seq DESC, id DESC LIMIT -1 OFFSET ?)`,
        )
        .run(subscriptionId, Store.MAX_FAILED_DELIVERIES).changes,
    );
    if (trimmed > 0)
      this.db
        .prepare("UPDATE event_subscriptions SET dropped_count = dropped_count + ? WHERE id = ?")
        .run(trimmed, subscriptionId);
  }

  /**
   * Moves events waiting to be retried into the endpoint's queue as far as
   * it has room under MAX_PENDING_DELIVERIES, oldest first (REV-15). Returns
   * how many went in.
   */
  private promoteEventRetries(subscriptionId: ID, now = Date.now()): number {
    const waiting = this.db
      .prepare(
        "SELECT 1 FROM event_deliveries WHERE subscription_id = ? AND retry_requested = 1 LIMIT 1",
      )
      .get(subscriptionId);
    if (!waiting) return 0;
    const { queued } = this.db
      .prepare(
        "SELECT COUNT(*) AS queued FROM event_deliveries WHERE subscription_id = ? AND failed_at IS NULL",
      )
      .get(subscriptionId) as { queued: number };
    const room = Store.MAX_PENDING_DELIVERIES - queued;
    if (room <= 0) return 0;
    return Number(
      this.db
        .prepare(
          `UPDATE event_deliveries SET attempts = 0, next_attempt_at = ?, failed_at = NULL,
             last_error = NULL, retry_requested = 0
           WHERE id IN (SELECT id FROM event_deliveries
             WHERE subscription_id = ? AND retry_requested = 1
             ORDER BY event_seq, id LIMIT ?)`,
        )
        .run(now, subscriptionId, room).changes,
    );
  }

  /** Every endpoint's waiting retries, as far as each has room. Returns how many went in. */
  promoteAllEventRetries(now = Date.now()): number {
    const subscriptions = this.db
      .prepare("SELECT DISTINCT subscription_id FROM event_deliveries WHERE retry_requested = 1")
      .all() as { subscription_id: string }[];
    let promoted = 0;
    for (const { subscription_id } of subscriptions)
      promoted += this.promoteEventRetries(subscription_id, now);
    return promoted;
  }

  /**
   * Forgets given-up events older than the history window. An event an
   * administrator has asked to retry is not history but accepted work waiting
   * for room, however long the queue stays full, so it stays until it goes
   * out or the endpoint fails again (F04).
   */
  pruneEventDeliveries(failedBefore: number): void {
    this.db
      .prepare("DELETE FROM event_deliveries WHERE failed_at < ? AND retry_requested = 0")
      .run(failedBefore);
  }

  /**
   * Asks for an endpoint's given-up events to be sent again (REV-15). They go
   * back into its queue only as far as it has room, oldest first; the rest are
   * kept, waiting, and take each slot that frees up as the endpoint answers.
   * Returns how many were asked for, and how many still wait for room.
   */
  retryFailedEventDeliveries(
    subscriptionId: ID,
    now = Date.now(),
  ): { retried: number; waiting: number } {
    const retried = Number(
      this.db
        .prepare(
          `UPDATE event_deliveries SET retry_requested = 1
           WHERE subscription_id = ? AND failed_at IS NOT NULL AND retry_requested = 0`,
        )
        .run(subscriptionId).changes,
    );
    this.promoteEventRetries(subscriptionId, now);
    const { waiting } = this.db
      .prepare(
        "SELECT COUNT(*) AS waiting FROM event_deliveries WHERE subscription_id = ? AND retry_requested = 1",
      )
      .get(subscriptionId) as { waiting: number };
    // The tally is what an administrator was shown before deciding to retry, so
    // clearing it here marks that report as read rather than losing it.
    this.db
      .prepare("UPDATE event_subscriptions SET dropped_count = 0 WHERE id = ?")
      .run(subscriptionId);
    return { retried, waiting };
  }

  // ---------- invites ----------

  createInvite(input: { createdBy: ID; expiresAt: number | null; maxUses: number | null }): Invite {
    const code = inviteCode();
    this.db
      .prepare(
        "INSERT INTO invites (code, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)",
      )
      .run(code, input.createdBy, Date.now(), input.expiresAt, input.maxUses);
    return this.getInvite(code)!;
  }

  private toInvite(
    r: {
      code: string;
      created_by: string;
      created_at: number;
      expires_at: number | null;
      max_uses: number | null;
      uses: number;
      revoked_at: number | null;
      creator_deactivated: number | null;
      creator_role: string | null;
      creator_is_bot: number | null;
      creator_can_invite: number | null;
    },
    now: number,
  ): Invite {
    // Revoked first: it is the one somebody chose, and it stays true whatever
    // else changes. A creator who has been deactivated comes next, and unlike
    // revocation it lifts again if they are reactivated.
    const status: InviteStatus =
      r.revoked_at !== null
        ? "revoked"
        : r.creator_deactivated !== 0
          ? "creator_deactivated"
          : !mayInvite(r.creator_role ?? "", r.creator_is_bot ?? 0, r.creator_can_invite)
            ? "creator_not_permitted"
            : r.expires_at !== null && now > r.expires_at
              ? "expired"
              : r.max_uses !== null && r.uses >= r.max_uses
                ? "used_up"
                : "active";
    return {
      code: r.code,
      createdBy: r.created_by,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      maxUses: r.max_uses,
      uses: r.uses,
      revokedAt: r.revoked_at,
      status,
    };
  }

  /** A creator who no longer exists counts as deactivated: nobody vouches for the link. */
  private static readonly INVITE_COLUMNS = `i.code, i.created_by, i.created_at, i.expires_at,
    i.max_uses, i.uses, i.revoked_at, COALESCE(u.deactivated, 1) AS creator_deactivated,
    u.role AS creator_role, u.is_bot AS creator_is_bot, u.can_invite AS creator_can_invite`;

  getInvite(code: string, now = Date.now()): Invite | null {
    const r = this.db
      .prepare(
        `SELECT ${Store.INVITE_COLUMNS} FROM invites i LEFT JOIN users u ON u.id = i.created_by
         WHERE i.code = ?`,
      )
      .get(code) as Parameters<Store["toInvite"]>[0] | undefined;
    return r ? this.toInvite(r, now) : null;
  }

  /** Newest first. Everyone's when `createdBy` is omitted, which is for administrators. */
  listInvites(opts: { createdBy?: ID; limit?: number } = {}, now = Date.now()): Invite[] {
    const rows = this.db
      .prepare(
        `SELECT ${Store.INVITE_COLUMNS} FROM invites i LEFT JOIN users u ON u.id = i.created_by
         ${opts.createdBy ? "WHERE i.created_by = ?" : ""}
         ORDER BY i.created_at DESC, i.code DESC LIMIT ?`,
      )
      .all(...(opts.createdBy ? [opts.createdBy] : []), opts.limit ?? 200) as Parameters<
      Store["toInvite"]
    >[0][];
    return rows.map((r) => this.toInvite(r, now));
  }

  /** True if this call withdrew it; false if it was already withdrawn or never existed. */
  revokeInvite(code: string, by: ID, now = Date.now()): boolean {
    return (
      this.db
        .prepare(
          "UPDATE invites SET revoked_at = ?, revoked_by = ? WHERE code = ? AND revoked_at IS NULL",
        )
        .run(now, by, code).changes > 0
    );
  }

  /** Validates and consumes one use. Returns false for anything but an active invite. */
  consumeInvite(code: string): boolean {
    if (this.getInvite(code)?.status !== "active") return false;
    this.db.prepare("UPDATE invites SET uses = uses + 1 WHERE code = ?").run(code);
    return true;
  }

  // ---------- audit log ----------

  /** Call inside the transaction that makes the change, so neither exists without the other. */
  recordAudit(
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
  listAudit(opts: { before?: ID; limit: number }): AuditEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_log
         ${opts.before ? "WHERE rowid < (SELECT rowid FROM audit_log WHERE id = ?)" : ""}
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...(opts.before ? [opts.before] : []), opts.limit) as {
      id: string;
      at: number;
      actor_id: string | null;
      action: AuditAction;
      target_type: AuditTargetType;
      target_id: string | null;
      details: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actorId: r.actor_id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      details: JSON.parse(r.details) as AuditEntry["details"],
    }));
  }

  // ---------- event log ----------

  appendEvent(event: WorkspaceEvent, channelId: ID | null): EventEnvelope {
    const res = this.db
      .prepare(
        "INSERT INTO events (channel_id, type, payload, created_at, message_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(channelId, event.type, JSON.stringify(event), Date.now(), Store.eventMessageId(event));
    return { seq: Number(res.lastInsertRowid), event };
  }

  /**
   * Which message an event is about, or null if it is not about one. This is
   * stored beside the payload so that deleting a message can find every copy of
   * its words without reading the whole log.
   */
  static eventMessageId(event: WorkspaceEvent): ID | null {
    if (event.type === "message.created" || event.type === "message.updated") {
      return event.message.id;
    }
    if (event.type === "message.deleted") return event.messageId;
    return null;
  }

  /**
   * Takes the text and attachment names of one message out of the event log,
   * leaving the events themselves in place.
   *
   * The events have to stay: a client catching up replays them in order, and a
   * missing sequence number is indistinguishable from a log it has fallen off
   * the end of, which would send it back for a whole new snapshot. What it
   * replays instead is a message with no words in it, immediately followed by
   * the edit or the deletion that supersedes it, so the state it arrives at is
   * the same one it would have reached anyway.
   *
   * Returns how many events were changed.
   */
  redactMessageEvents(messageId: ID, keepSeq?: number): number {
    const rows = this.db
      .prepare(
        `SELECT seq, payload FROM events
         WHERE message_id = ? AND type IN ('message.created', 'message.updated')
         ${keepSeq === undefined ? "" : "AND seq != ?"}`,
      )
      .all(messageId, ...(keepSeq === undefined ? [] : [keepSeq])) as {
      seq: number;
      payload: string;
    }[];
    const changed = this.redactEventRows(rows);
    this.redactQueuedDeliveries(
      this.db
        .prepare(
          `SELECT id, body FROM event_deliveries WHERE message_id = ?
           ${keepSeq === undefined ? "" : "AND event_seq != ?"}`,
        )
        .all(messageId, ...(keepSeq === undefined ? [] : [keepSeq])) as {
        id: string;
        body: string;
      }[],
    );
    return changed;
  }

  /**
   * Takes a message's words out of app events still waiting to be delivered,
   * or that gave up. Those are copies OwnBase still holds, and an edit or a
   * deletion is often someone taking back what they wrote. The events stay,
   * in order and under the same id: a receiver gets a message with no words,
   * then the edit or deletion that supersedes it, as a client replaying the
   * log does. What has already been delivered is the app's, and cannot be
   * called back.
   */
  private redactQueuedDeliveries(rows: { id: string; body: string }[]): void {
    const update = this.db.prepare("UPDATE event_deliveries SET body = ? WHERE id = ?");
    for (const row of rows) {
      let body: {
        ownbase?: { type?: string };
        event?: { text?: string; message?: { text?: string } };
      };
      try {
        body = JSON.parse(row.body);
      } catch {
        continue;
      }
      const type = body.ownbase?.type;
      if (type === "message.created" && body.event) body.event.text = "";
      else if (type === "message.updated" && body.event?.message) body.event.message.text = "";
      else continue;
      const after = JSON.stringify(body);
      if (after !== row.body) update.run(after, row.id);
    }
  }

  /**
   * Brings the log's copies of these messages, quoted in replies to them, up
   * to date: an edit's new words, or nothing at all once they are deleted
   * (null). A reply's events stay where they are, as with `redactMessageEvents`,
   * and the original's own edit or deletion still follows them on replay.
   */
  private requoteEvents(
    quotedIds: ID[],
    now: Pick<ReplyReference, "text" | "fileCount"> | null,
  ): void {
    if (quotedIds.length === 0) return;
    const quoted = new Set(quotedIds);
    const ph = quotedIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT seq, payload FROM events WHERE type IN ('message.created', 'message.updated')
         AND message_id IN (SELECT id FROM messages WHERE reply_to_id IN (${ph}))`,
      )
      .all(...quotedIds) as { seq: number; payload: string }[];
    const update = this.db.prepare("UPDATE events SET payload = ? WHERE seq = ?");
    for (const row of rows) {
      const event = JSON.parse(row.payload) as WorkspaceEvent;
      if (event.type !== "message.created" && event.type !== "message.updated") continue;
      const quote = event.message.replyTo;
      if (!quote || !quoted.has(quote.id)) continue;
      event.message.replyTo = now
        ? { ...quote, ...now }
        : { ...quote, userId: "", text: "", fileCount: 0, deleted: true };
      const after = JSON.stringify(event);
      if (after !== row.payload) update.run(after, row.seq);
    }
  }

  /**
   * As `requoteEvents`, for forwards: the log's copies of messages forwarding
   * these follow an edit's new words, or say the original is gone (null). A
   * hidden one shows no words either way.
   */
  private reforwardEvents(ids: ID[], now: { text: string } | null): void {
    if (ids.length === 0) return;
    const forwarded = new Set(ids);
    const ph = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT seq, payload FROM events WHERE type IN ('message.created', 'message.updated')
         AND message_id IN (SELECT id FROM messages WHERE forwarded_from_id IN (${ph}))`,
      )
      .all(...ids) as { seq: number; payload: string }[];
    const update = this.db.prepare("UPDATE events SET payload = ? WHERE seq = ?");
    for (const row of rows) {
      const event = JSON.parse(row.payload) as WorkspaceEvent;
      if (event.type !== "message.created" && event.type !== "message.updated") continue;
      const ref = event.message.forwardedFrom;
      if (!ref || !forwarded.has(ref.id)) continue;
      event.message.forwardedFrom = now
        ? ref.hidden || ref.deleted
          ? ref
          : { ...ref, text: now.text }
        : { ...ref, userId: "", text: "", files: [], createdAt: 0, deleted: true };
      const after = JSON.stringify(event);
      if (after !== row.payload) update.run(after, row.seq);
    }
  }

  private redactEventRows(rows: { seq: number; payload: string }[]): number {
    const update = this.db.prepare("UPDATE events SET payload = ? WHERE seq = ?");
    let changed = 0;
    for (const row of rows) {
      const event = JSON.parse(row.payload) as WorkspaceEvent;
      if (event.type !== "message.created" && event.type !== "message.updated") continue;
      const before = row.payload;
      event.message.text = "";
      // A filename is often as telling as the message it was attached to.
      event.message.files = [];
      // Labels, values and URLs can be as revealing as the message's words.
      // Superseded/deleted copies must not transmit their buttons on replay.
      event.message.actions = [];
      // A preview names the link and says what is there.
      if (event.message.previews) event.message.previews = [];
      // A poll's choices are words too.
      delete event.message.poll;
      const after = JSON.stringify(event);
      if (after === before) continue;
      update.run(after, row.seq);
      changed++;
    }
    return changed;
  }

  currentSeq(): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(seq), 0) s FROM events").get() as { s: number };
    return r.s;
  }

  minSeq(): number {
    const r = this.db.prepare("SELECT COALESCE(MIN(seq), 0) s FROM events").get() as { s: number };
    return r.s;
  }

  /** Events after `afterSeq` visible to the user. Null = too far behind, client must resync. */
  eventsSince(afterSeq: number, userId: ID, limit = 2000): EventEnvelope[] | null {
    const min = this.minSeq();
    if (min > 0 && afterSeq < min - 1) return null;
    const rows = this.db
      .prepare(
        `SELECT e.seq, e.payload FROM events e
         LEFT JOIN channels c ON c.id = e.channel_id
         WHERE e.seq > ? AND (
           e.channel_id IS NULL
           OR c.type = 'public'
           OR EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = e.channel_id AND m.user_id = ?)
         )
         ORDER BY e.seq LIMIT ?`,
      )
      .all(afterSeq, userId, limit + 1) as { seq: number; payload: string }[];
    if (rows.length > limit) return null;
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload) as WorkspaceEvent }));
  }

  pruneEvents(keep = 20000): void {
    this.db
      .prepare("DELETE FROM events WHERE seq <= (SELECT COALESCE(MAX(seq), 0) FROM events) - ?")
      .run(keep);
  }

  // ---------- search ----------

  /**
   * Full-text search restricted to what the user can see, with modifier
   * filters (from:/in:/has:/before:/after:) applied as plain SQL. Free-text
   * terms go to FTS5; a query with only modifiers skips FTS entirely.
   */
  activityMessages(
    userId: ID,
    opts: { mode: "unread" | "mentions" | "threads"; cursor?: ID; limit: number },
  ): Message[] {
    const conditions = [
      "cm.user_id = ?",
      "m.user_id != ?",
      "m.deleted_at IS NULL",
      Store.NOT_BLOCKED,
    ];
    const params: (string | number)[] = [userId, userId];
    if (opts.mode === "unread") {
      // What the channel shows, replies in threads followed, and anything
      // naming this account; the rest of a thread is its own to open.
      conditions.push(
        Store.UNREAD,
        `(m.thread_root_id IS NULL OR m.broadcast = 1 OR ${Store.MENTIONS_ME} OR EXISTS (
          SELECT 1 FROM thread_follows tf
          WHERE tf.user_id = cm.user_id AND tf.root_id = m.thread_root_id AND tf.following = 1))`,
      );
      params.push(`<@${userId}>`);
    } else if (opts.mode === "threads") {
      // Unread replies in the threads this account follows.
      conditions.push(
        Store.UNREAD,
        `m.thread_root_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM thread_follows tf
          WHERE tf.user_id = cm.user_id AND tf.root_id = m.thread_root_id AND tf.following = 1)`,
      );
    } else {
      // Read from who each message names, not by walking every message.
      conditions.push(Store.NAMES_ME);
      params.push(userId);
    }
    if (opts.cursor) {
      conditions.push("m.id < ?");
      params.push(opts.cursor);
    }
    conditions.push(
      "(m.thread_root_id IS NULL OR EXISTS (SELECT 1 FROM messages root WHERE root.id = m.thread_root_id AND root.deleted_at IS NULL))",
    );
    // Unread and threads walk messages newest first and stop at the page's
    // end. Mentions start from who each message names, where one message can
    // appear twice (named, and the whole room), so they are grouped by message.
    const query =
      opts.mode !== "mentions"
        ? `SELECT m.* FROM messages m JOIN channels c ON c.id = m.channel_id
           JOIN channel_members cm ON cm.channel_id = c.id
           WHERE ${conditions.join(" AND ")} ORDER BY m.id DESC LIMIT ?`
        : `SELECT m.* FROM message_mentions mm
           JOIN channel_members cm ON cm.channel_id = mm.channel_id
           JOIN channels c ON c.id = mm.channel_id JOIN messages m ON m.id = mm.message_id
           WHERE ${conditions.join(" AND ")} GROUP BY m.id ORDER BY m.id DESC LIMIT ?`;
    const rows = this.db.prepare(query).all(...params, opts.limit) as unknown as MessageRow[];
    return this.hydrateMessages(rows);
  }

  /**
   * The condition for "this message is unread", beside `channel_members cm`;
   * the client's `isMessageRead` is the same rule. The channel's cursor reads
   * what the channel shows. A reply is read through its thread: by the
   * thread's cursor, or without one by the membership's `replies_read_seq`.
   * A reply also sent to the channel is read by the channel's cursor as well,
   * unless the thread was marked unread since the channel was last read past
   * where its cursor then stood (`unread_hold`): an explicit unread holds.
   */
  private static readonly UNREAD = `(CASE WHEN m.thread_root_id IS NULL THEN m.seq > cm.last_read_seq
    ELSE m.seq > COALESCE((SELECT tf.last_read_seq FROM thread_follows tf
        WHERE tf.user_id = cm.user_id AND tf.root_id = m.thread_root_id), cm.replies_read_seq)
      AND NOT (m.broadcast = 1 AND m.seq <= cm.last_read_seq
        AND cm.last_read_seq > COALESCE((SELECT tf.unread_hold FROM thread_follows tf
          WHERE tf.user_id = cm.user_id AND tf.root_id = m.thread_root_id), -1)) END)`;

  /**
   * A reply `r` in thread follow `f`'s thread that its reader saw in the
   * channel, and has not marked unread since; see `UNREAD`.
   */
  private static readonly READ_IN_CHANNEL = `(r.broadcast = 1 AND EXISTS (
    SELECT 1 FROM channel_members rcm
    WHERE rcm.channel_id = r.channel_id AND rcm.user_id = f.user_id
      AND r.seq <= rcm.last_read_seq AND rcm.last_read_seq > COALESCE(f.unread_hold, -1)))`;

  /**
   * The condition for "this message mentions me", shared by the Activity list
   * and the badge counts so a count can never disagree with what it opens.
   * A direct mention counts anywhere; a room-wide one only in a room, since
   * `@here` in a DM is just words. A reply that notified the author of what
   * it answers, beside `channel_members cm`, counts for that author.
   */
  private static readonly MENTIONS_ME =
    "(instr(m.text, ?) > 0 OR (c.type IN ('public', 'private') AND (instr(m.text, '<!channel>') > 0 OR instr(m.text, '<!here>') > 0 OR instr(m.text, '<!everyone>') > 0)) OR (m.reply_ping = 1 AND EXISTS (SELECT 1 FROM messages q WHERE q.id = m.reply_to_id AND q.user_id = cm.user_id)))";

  /**
   * `MENTIONS_ME` read from `message_mentions` beside `mm` and `channels c`:
   * the rows naming this account, and the whole room in a room.
   */
  private static readonly NAMES_ME =
    "(mm.user_id = ? OR (mm.user_id = '!' AND c.type IN ('public', 'private')))";

  /**
   * Beside `messages m` and `channel_members cm`: not written by someone the
   * member blocked (E12), whom Activity and the badges leave out.
   */
  private static readonly NOT_BLOCKED =
    "NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.user_id = cm.user_id AND ub.blocked_id = m.user_id)";

  /**
   * Unread mentions per conversation, for the badge beside its name. Read
   * from who each message names, so it costs what this account's mentions
   * cost, not what its channels' histories do.
   */
  unreadMentionCounts(userId: ID): Record<ID, number> {
    const rows = this.db
      .prepare(
        `SELECT m.channel_id, COUNT(DISTINCT m.id) AS n FROM message_mentions mm
         JOIN channel_members cm ON cm.channel_id = mm.channel_id AND cm.user_id = ?
         JOIN channels c ON c.id = mm.channel_id
         JOIN messages m ON m.id = mm.message_id
         WHERE ${Store.NAMES_ME} AND m.user_id != ? AND m.deleted_at IS NULL
         AND ${Store.NOT_BLOCKED}
         AND ${Store.UNREAD}
         AND (m.thread_root_id IS NULL OR EXISTS (
           SELECT 1 FROM messages root WHERE root.id = m.thread_root_id AND root.deleted_at IS NULL
         ))
         GROUP BY m.channel_id`,
      )
      .all(userId, userId, userId) as { channel_id: string; n: number }[];
    return Object.fromEntries(rows.map((row) => [row.channel_id, row.n]));
  }

  /**
   * Members of a channel this text mentions, so only they have to be told
   * their counts changed. Most text names nobody and costs no query; text
   * naming people checks just them, and only a room-wide mention in a room
   * reads every member (REV-06).
   */
  mentionedMemberIds(channelId: ID, text: string, exclude: ID): ID[] {
    const direct = new Set([...text.matchAll(/<@([^>]+)>/g)].map((m) => m[1]!));
    const roomWideToken = /<!(channel|here|everyone)>/.test(text);
    if (direct.size === 0 && !roomWideToken) return [];
    const channel = this.getChannel(channelId);
    if (!channel) return [];
    if (roomWideToken && (channel.type === "public" || channel.type === "private"))
      return this.memberIds(channelId).filter((id) => id !== exclude);
    return [...direct].filter((id) => id !== exclude && this.isMember(channelId, id));
  }

  /**
   * Above this many matches, a search walks the newest messages first rather
   * than starting from its matches (OPT-11). Starting from them costs about a
   * microsecond each, and the walk a few milliseconds whatever it finds, so
   * this is about where the walk starts to pay.
   */
  static SEARCH_FEW_MATCHES = 5000;
  /** How many of the newest messages that walk covers before it gives up. */
  static SEARCH_WINDOW = 20_000;

  /** The queues and sizes `WorkspaceStatus` reports: counts only (OPS-10). */
  operationalCounts(): {
    databaseBytes: number;
    deliveries: { waiting: number; oldestWaitingAt: number | null; failed: number };
    scheduled: { queued: number; held: number; failed: number };
  } {
    const pages = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const size = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
    const deliveries = this.db
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE failed_at IS NULL) AS waiting,
                MIN(created_at) FILTER (WHERE failed_at IS NULL) AS oldest,
                COUNT(*) FILTER (WHERE failed_at IS NOT NULL) AS failed
         FROM event_deliveries`,
      )
      .get() as { waiting: number; oldest: number | null; failed: number };
    const scheduled = this.db
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE status = 'queued') AS queued,
                COUNT(*) FILTER (WHERE status = 'held') AS held,
                COUNT(*) FILTER (WHERE status = 'failed') AS failed
         FROM scheduled_messages`,
      )
      .get() as { queued: number; held: number; failed: number };
    return {
      databaseBytes: pages.page_count * size.page_size,
      deliveries: {
        waiting: deliveries.waiting,
        oldestWaitingAt: deliveries.oldest,
        failed: deliveries.failed,
      },
      scheduled,
    };
  }

  searchMessages(
    userId: ID,
    query: ParsedSearch,
    limit: number,
    opts: { cursor?: ID; channelId?: ID } = {},
  ): Message[] {
    type Filter = [sql: string, ...values: (string | number)[]];
    // Where the newest messages are counted from: the same page and channel.
    const scope: Filter[] = [];
    if (opts.cursor) scope.push(["m.id < ?", opts.cursor]);
    if (opts.channelId) scope.push(["m.channel_id = ?", opts.channelId]);
    const filters: Filter[] = [["m.deleted_at IS NULL"], ...scope];

    if (query.from.length > 0) {
      filters.push([`u.handle IN (${query.from.map(() => "?").join(",")})`, ...query.from]);
    }
    if (query.in.length > 0) {
      filters.push([`c.name IN (${query.in.map(() => "?").join(",")})`, ...query.in]);
    }
    if (query.has.includes("link")) {
      // Parenthesised: this sits inside an AND-joined list.
      filters.push(["(m.text LIKE '%http://%' OR m.text LIKE '%https://%')"]);
    }
    if (query.has.includes("file")) {
      filters.push(["EXISTS (SELECT 1 FROM files f WHERE f.message_id = m.id)"]);
    }
    if (query.types.length > 0) {
      // By media type, or by the name's ending for a file sent as anything.
      const kinds = query.types.flatMap((type): Filter[] => [
        ...FILE_TYPE_MATCH[type].mime.map((mime): Filter => ["lower(f.mime) LIKE ?", mime]),
        ...FILE_TYPE_MATCH[type].ext.map((ext): Filter => ["lower(f.name) LIKE ?", `%.${ext}`]),
      ]);
      filters.push([
        `EXISTS (SELECT 1 FROM files f WHERE f.message_id = m.id
           AND (${kinds.map(([sql]) => sql).join(" OR ")}))`,
        ...kinds.flatMap(([, ...values]) => values),
      ]);
    }
    if (query.before !== null) filters.push(["m.created_at < ?", query.before]);
    if (query.after !== null) filters.push(["m.created_at >= ?", query.after]);

    // Visibility is never optional, whatever the modifiers say.
    filters.push([
      `(c.type = 'public' OR EXISTS (
         SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?
       ))`,
      userId,
    ]);

    const page = (more: Filter[], count: number) => {
      const all = [...filters, ...more];
      return this.db
        .prepare(
          `SELECT m.* FROM messages m
           JOIN channels c ON c.id = m.channel_id
           JOIN users u ON u.id = m.user_id
           WHERE ${all.map(([sql]) => sql).join(" AND ")}
           ORDER BY m.id DESC LIMIT ?`,
        )
        .all(...all.flatMap(([, ...values]) => values), count) as unknown as MessageRow[];
    };
    if (query.terms.length === 0) return this.hydrateMessages(page([], limit));

    // Quote every term so user input can never break FTS5 syntax. The last
    // one matches as the start of a word, so a search run as it is typed
    // finds "mockups" from "mock"; one with no letter or digit has no word
    // to start.
    const fts = query.terms
      .map((t, i) => {
        const phrase = `"${t.replaceAll('"', '""')}"`;
        return i === query.terms.length - 1 && /[\p{L}\p{N}]/u.test(t) ? `${phrase}*` : phrase;
      })
      .join(" ");
    // A message is found by the name of a file attached to it too, when every
    // term is in that one name (IMP-02). Only terms with a letter or digit in
    // them: "." alone would otherwise find every file there is.
    const nameTerms = query.terms.filter((t) => /[\p{L}\p{N}]/u.test(t));
    const named: Filter =
      nameTerms.length > 0
        ? [
            `OR m.id IN (SELECT f.message_id FROM files f WHERE f.message_id IS NOT NULL
               AND ${nameTerms.map(() => "f.name LIKE ? ESCAPE '\\'").join(" AND ")})`,
            ...nameTerms.map((t) => `%${t.replaceAll(/[\\%_]/g, "\\$&")}%`),
          ]
        : [""];
    const [namedSql, ...namedValues] = named;
    const matching: Filter = [
      `(m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) ${namedSql})`,
      fts,
      ...namedValues,
    ];
    const many =
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages_fts WHERE messages_fts MATCH ? LIMIT ?)",
          )
          .get(fts, Store.SEARCH_FEW_MATCHES + 1) as { n: number }
      ).n > Store.SEARCH_FEW_MATCHES;
    // The same matches as one list of rows, for a search that starts from
    // them (F13). Asked as "said, or named", SQLite reads the file names once
    // to pick the rows and again to check each one; read once into the list,
    // a word in a few hundred file names is found in half the time, and no
    // search measured is slower.
    const fromMatches: Filter = [
      `m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?
         ${
           nameTerms.length > 0
             ? `UNION ALL SELECT named.rowid FROM files f CROSS JOIN messages named
                  ON named.id = f.message_id
                WHERE f.message_id IS NOT NULL
                  AND ${nameTerms.map(() => "f.name LIKE ? ESCAPE '\\'").join(" AND ")}`
             : ""
         })`,
      fts,
      ...namedValues,
    ];
    // A word in few messages is found from its matches. A common one would
    // have every match read, joined and sorted for one page: 120,000 of them
    // for "the" in 200,000 messages. So the newest messages are walked first,
    // checked against only their own matches, and the older ones are read
    // from the matches only if the newest hold less than a page.
    if (!many) return this.hydrateMessages(page([fromMatches], limit));
    const window = this.db
      .prepare(
        `SELECT MIN(id) AS edge, MIN(position) AS low, COUNT(*) AS n FROM (
           SELECT m.id, m.rowid AS position FROM messages m
           ${scope.length > 0 ? `WHERE ${scope.map(([sql]) => sql).join(" AND ")}` : ""}
           ORDER BY m.id DESC LIMIT ?
         )`,
      )
      .get(...scope.flatMap(([, ...values]) => values), Store.SEARCH_WINDOW) as {
      edge: ID | null;
      low: number | null;
      n: number;
    };
    if (window.edge === null || window.low === null) return [];
    // Every message from the edge on has a rowid of at least `low`, whatever
    // order rowids were given in, so no match in the window is missed. The
    // unary plus keeps SQLite from starting at the matches instead.
    const newest = page(
      [
        [
          `(+m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid >= ?)
            ${namedSql})`,
          fts,
          window.low,
          ...namedValues,
        ],
        ["m.id >= ?", window.edge],
      ],
      limit,
    );
    if (newest.length === limit || window.n < Store.SEARCH_WINDOW) {
      return this.hydrateMessages(newest);
    }
    const older = page([matching, ["m.id < ?", window.edge]], limit - newest.length);
    return this.hydrateMessages([...newest, ...older]);
  }
}
