import type {
  App,
  AppEventType,
  AppScope,
  AuditAction,
  AuditEntry,
  AuditTargetType,
  Channel,
  ChannelPrefs,
  ChannelRemoval,
  ChannelType,
  EventEnvelope,
  EventSubscription,
  Friendship,
  ID,
  Invite,
  InviteStatus,
  MessageAction,
  MessageReport,
  NotifyLevel,
  ReplyReference,
  ReportReason,
  Role,
  SessionInfo,
  SidebarSection,
  SlashCommand,
  User,
  Webhook,
  WorkspaceEvent,
} from "@ownbase/protocol";
import { APP_SCOPES, isAdministrator } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { Settings } from "./core/settings.js";
import { GUEST_SQL, IN_CHANNEL_TIMELINE, NAMES_ME, NOT_BLOCKED, UNREAD } from "./core/sqlRules.js";
import { Outbox } from "./events/outbox.js";
import { FileStore } from "./files/store.js";
import { inviteCode, ulid } from "./ids.js";
import { MessageStore } from "./messages/store.js";
import { PollStore } from "./polls/store.js";
import { ReminderStore } from "./reminders/store.js";
import { SavedStore } from "./saved/store.js";
import { ScheduledStore } from "./scheduled/store.js";
import { SearchStore } from "./search/store.js";
import { ThreadStore } from "./threads/store.js";

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

export interface MessageRow {
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
interface ChannelRemovalRow {
  id: string;
  user_id: string;
  channel_id: string;
  channel_name: string;
  channel_type: "public" | "private";
  removed_by: string;
  created_at: number;
}

/**
 * Buttons come back out of one JSON column. A row written by a future version,
 * or corrupted somehow, costs its buttons rather than the whole message.
 */
export function parseActions(raw: string | null): MessageAction[] {
  if (!raw || raw === "[]") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MessageAction[]) : [];
  } catch {
    return [];
  }
}

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
    canInvite: mayInvite(r.role as Role, r.is_bot, r.can_invite),
    ...(r.time_zone ? { timeZone: r.time_zone } : {}),
    ...(r.away === 1 ? { away: true as const } : {}),
    ...(r.avatar_version ? { avatarVersion: r.avatar_version } : {}),
  };
}

/** One member's own choices for a conversation, as `channel_members` keeps them. */
type PrefsRow = {
  notify_level: string;
  notify_chosen: number;
  muted: number;
  starred: number;
  section_id: string | null;
  hidden_seq: number | null;
};

function toPrefs(r: PrefsRow): ChannelPrefs {
  return {
    notifyLevel: r.notify_level as NotifyLevel,
    notifyChosen: r.notify_chosen === 1,
    muted: r.muted === 1,
    starred: r.starred === 1,
    sectionId: r.section_id,
    hiddenSeq: r.hidden_seq,
  };
}

/**
 * The one rule for who may create invite codes, used for the flag clients see
 * and for the codes a creator has already handed out. An app never may.
 */
function mayInvite(
  role: Role | null,
  isBot: number,
  canInvite: number | undefined | null,
): boolean {
  if (isBot === 1) return false;
  return isAdministrator(role) || canInvite === 1;
}

/** How long a session survives without being used. */
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

export class Store {
  /** What the writes here have to tell people, sent once they are committed. */
  readonly outbox: Outbox = new Outbox(this);
  /** The workspace's settings, kept in `meta`; see core/settings.ts. */
  readonly settings: Settings;
  // features: fields
  readonly messages: MessageStore;
  readonly files: FileStore;
  readonly search: SearchStore;
  readonly threads: ThreadStore;
  readonly scheduled: ScheduledStore;
  readonly saved: SavedStore;
  readonly polls: PollStore;
  readonly reminders: ReminderStore;

  constructor(readonly db: DatabaseSync) {
    this.settings = new Settings(this);
    // features: made
    this.messages = new MessageStore(db, this);
    this.files = new FileStore(db, this);
    this.search = new SearchStore(db, this);
    this.threads = new ThreadStore(db, this);
    this.scheduled = new ScheduledStore(db, this);
    this.saved = new SavedStore(db, this);
    this.polls = new PollStore(db, this);
    this.reminders = new ReminderStore(db, this);
  }

  /** Only synchronous database work belongs here; publish events after this returns. */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    const mark = this.outbox.begin();
    let value: T;
    try {
      value = work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.outbox.rollback(mark);
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.outbox.commit();
    return value;
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
      this.outbox.person(id, () => ({ type: "friends", friends: this.listFriends(id) }), {
        key: "friends",
      });
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
    this.outbox.person(userId, () => ({ type: "blocks", blocked: this.blockedIds(userId) }), {
      key: "blocks",
    });
    // A request they sent meanwhile shows now.
    if (!blocked) this.tellFriends(userId);
    this.outbox.mentions([userId]);
    return true;
  }

  /** Keeps someone's report of a message; false when they have one open for it already. */
  reportMessage(messageId: ID, reporterId: ID, reason: string, note: string): boolean {
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
    this.outbox.admins("reports", () => ({ type: "reports", open: this.openReportCount() }));
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
    if (patch.deactivated === false) this.scheduled.wakeHeld({ userId: id });
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
    if (patch.archived === false) this.scheduled.wakeHeld({ channelId: id });
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

  /**
   * How many active people are in each channel (public or private) this
   * account can see, for the channel browser to say how big each one is.
   */
  roomMemberCounts(userId: ID): Record<ID, number> {
    const rows = this.db
      .prepare(
        `SELECT c.id AS channel_id, COUNT(u.id) AS n FROM channels c
         JOIN channel_members m ON m.channel_id = c.id
         JOIN users u ON u.id = m.user_id AND u.deactivated = 0
         WHERE c.type = 'public' OR (c.type = 'private' AND EXISTS (
           SELECT 1 FROM channel_members mine
           WHERE mine.channel_id = c.id AND mine.user_id = ?) AND NOT ${GUEST_SQL})
         GROUP BY c.id`,
      )
      .all(userId, userId) as { channel_id: ID; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.channel_id, Number(r.n)]));
  }

  listPublicChannelIds(): ID[] {
    const rows = this.db.prepare("SELECT id FROM channels WHERE type = 'public'").all() as {
      id: string;
    }[];
    return rows.map((r) => r.id);
  }

  // ---------- membership ----------

  addMember(channelId: ID, userId: ID, notifyLevel: NotifyLevel = "mentions"): boolean {
    // What was written before joining is history to read, not news to catch
    // up on, any more than it was this member's to be told about: a new
    // member starts with the channel read, as in Slack, replies and all.
    const seq = this.currentSeq();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_members
           (channel_id, user_id, joined_at, notify_level, last_read_seq, replies_read_seq)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(channelId, userId, Date.now(), notifyLevel, seq, seq);
    if (res.changes > 0) this.scheduled.wakeHeld({ channelId, userId });
    return res.changes > 0;
  }

  /**
   * Takes someone out of a conversation. They are told their access ahead of
   * the change's events: out of a private one they no longer hear its
   * `member.left`, so that notice is what clears it from their screens.
   */
  removeMember(channelId: ID, userId: ID): boolean {
    const res = this.db
      .prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
      .run(channelId, userId);
    if (res.changes === 0) return false;
    this.retireDmKey(channelId);
    this.outbox.access(channelId, userId);
    return true;
  }

  /** Adds someone at another member's asking; they are told their access wherever they are. */
  inviteMember(channelId: ID, userId: ID): boolean {
    if (!this.addMember(channelId, userId)) return false;
    this.outbox.access(channelId, userId);
    return true;
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
        `SELECT channel_id, last_read_seq, replies_read_seq, notify_level, notify_chosen, muted,
                starred, section_id, hidden_seq
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
        `SELECT notify_level, notify_chosen, muted, starred, section_id, hidden_seq
         FROM channel_members WHERE channel_id = ? AND user_id = ?`,
      )
      .get(channelId, userId) as PrefsRow | undefined;
    return r ? toPrefs(r) : null;
  }

  setChannelPrefs(
    channelId: ID,
    userId: ID,
    patch: {
      notifyLevel?: NotifyLevel;
      notifyChosen?: boolean;
      muted?: boolean;
      starred?: boolean;
      sectionId?: ID | null;
      hiddenSeq?: number | null;
    },
  ): ChannelPrefs | null {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.notifyLevel !== undefined) {
      sets.push("notify_level = ?");
      params.push(patch.notifyLevel);
    }
    // A level chosen here is this conversation's own, unless it is put back on
    // the default in the same change.
    const chosen = patch.notifyChosen ?? (patch.notifyLevel !== undefined ? true : undefined);
    if (chosen !== undefined) {
      sets.push("notify_chosen = ?");
      params.push(chosen ? 1 : 0);
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
    if (patch.hiddenSeq !== undefined) {
      sets.push("hidden_seq = ?");
      params.push(patch.hiddenSeq);
    }
    if (sets.length > 0) {
      this.db
        .prepare(
          `UPDATE channel_members SET ${sets.join(", ")} WHERE channel_id = ? AND user_id = ?`,
        )
        .run(...params, channelId, userId);
    }
    const prefs = this.getChannelPrefs(channelId, userId);
    if (prefs) this.tellPrefs(channelId, userId);
    return prefs;
  }

  /** Preferences are personal: only this account's own devices hear of them. */
  private tellPrefs(channelId: ID, userId: ID): void {
    this.outbox.person(
      userId,
      () => {
        const prefs = this.getChannelPrefs(channelId, userId);
        return prefs ? { type: "prefs", channelId, prefs } : null;
      },
      { key: `prefs:${channelId}` },
    );
  }

  /** What this account's conversations notify about unless one is set on its own (v53). */
  notifyDefault(userId: ID): NotifyLevel {
    const row = this.db.prepare("SELECT notify_default FROM users WHERE id = ?").get(userId) as
      { notify_default: string } | undefined;
    return (row?.notify_default as NotifyLevel | undefined) ?? "mentions";
  }

  setNotifyDefault(userId: ID, level: NotifyLevel): void {
    this.db.prepare("UPDATE users SET notify_default = ? WHERE id = ?").run(level, userId);
    this.outbox.person(userId, { type: "notify.default", level });
  }

  /**
   * What waits for this account, for another of its devices showing a
   * different workspace: unread mentions as the badge counts them, and
   * whether any conversation it has not muted has something unread, by the
   * rule the sidebar uses (a closed DM or one with someone blocked aside).
   */
  unreadSummary(userId: ID): { mentions: number; unread: boolean } {
    const mentions = Object.values(this.unreadMentionCounts(userId)).reduce((a, n) => a + n, 0);
    const row = this.db
      .prepare(
        `SELECT 1 FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
         WHERE cm.user_id = ? AND cm.muted = 0 AND c.archived = 0
           AND c.last_msg_seq > cm.last_read_seq
           AND (cm.hidden_seq IS NULL OR c.last_msg_seq > cm.hidden_seq)
           AND NOT (c.type = 'dm' AND EXISTS (
             SELECT 1 FROM channel_members other JOIN user_blocks ub
               ON ub.user_id = cm.user_id AND ub.blocked_id = other.user_id
             WHERE other.channel_id = c.id AND other.user_id <> cm.user_id))
         LIMIT 1`,
      )
      .get(userId);
    return { mentions, unread: !!row };
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
    this.tellSections(userId);
    return { id, name };
  }

  private tellSections(userId: ID): void {
    this.outbox.person(
      userId,
      () => ({ type: "sidebar.sections", sections: this.sidebarSections(userId) }),
      { key: "sidebar.sections" },
    );
  }

  /** Renames one of the account's sections; false when it has no such section. */
  renameSidebarSection(userId: ID, sectionId: ID, name: string): boolean {
    const renamed =
      this.db
        .prepare("UPDATE sidebar_sections SET name = ? WHERE id = ? AND user_id = ?")
        .run(name, sectionId, userId).changes > 0;
    if (renamed) this.tellSections(userId);
    return renamed;
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
    for (const row of freed) this.tellPrefs(row.channel_id, userId);
    this.tellSections(userId);
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
    this.tellSections(userId);
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
    return this.outbox.hold(() => {
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
      this.outbox.person(userId, { type: "channel.read", channelId, seq: after });
      this.outbox.mentions([userId]);
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
      // Replies also sent to the channel were read there, and so in their threads.
      for (const { id } of threads) this.threads.tellFollow(userId, id);
      return { seq: after, threads: threads.map(({ id }) => id) };
    });
  }

  /**
   * Moves a thread's cursor over the channel copies up to `channelRead`; true
   * if it moved. Not while the thread is held unread at or past `channelRead`.
   */
  private readChannelCopies(userId: ID, rootId: ID, channelRead: number): boolean {
    const current = this.threads.follow(userId, rootId);
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
      .run(userId, rootId, read, this.threads.nextFollowRevision());
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
    const now = row?.last_read_seq ?? 0;
    this.outbox.person(userId, { type: "channel.unread", channelId, seq: now });
    this.outbox.mentions([userId]);
    return now;
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

  // ---------- removals ----------

  /** How many unread notes of removals the handshake carries, newest first. */
  static readonly REMOVALS_SENT = 100;

  private static removalFrom(row: ChannelRemovalRow): ChannelRemoval {
    return {
      id: row.id,
      channelId: row.channel_id,
      channelName: row.channel_name,
      channelType: row.channel_type,
      removedBy: row.removed_by,
      createdAt: row.created_at,
    };
  }

  /**
   * Notes that `removedBy` removed `userId` from `channel`, for their
   * Activity. A direct conversation has no note: nobody is removed from one.
   */
  addChannelRemoval(userId: ID, channel: Channel, removedBy: ID): ChannelRemoval | null {
    if (channel.type !== "public" && channel.type !== "private") return null;
    const row = this.db
      .prepare(
        `INSERT INTO channel_removals
           (id, user_id, channel_id, channel_name, channel_type, removed_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        ulid(),
        userId,
        channel.id,
        channel.name,
        channel.type,
        removedBy,
        Date.now(),
      ) as unknown as ChannelRemovalRow;
    const removal = Store.removalFrom(row);
    // They hear who removed them, in Activity, wherever they are.
    this.outbox.person(userId, { type: "channel.removal", removal }, { ahead: true });
    return removal;
  }

  /** One account's unread notes of removals, newest first. */
  channelRemovals(userId: ID, limit = Store.REMOVALS_SENT): ChannelRemoval[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_removals WHERE user_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(userId, limit) as unknown as ChannelRemovalRow[];
    return rows.map(Store.removalFrom);
  }

  /**
   * Reads, and so clears, some of one account's notes of removals. Returns the
   * ids that were there; another account's are left alone.
   */
  readChannelRemovals(userId: ID, ids: readonly ID[]): ID[] {
    const remove = this.db.prepare(
      "DELETE FROM channel_removals WHERE id = ? AND user_id = ? RETURNING id",
    );
    const read: ID[] = [];
    for (const id of new Set(ids)) if (remove.get(id, userId)) read.push(id);
    if (read.length > 0) this.outbox.person(userId, { type: "channel.removals.read", ids: read });
    return read;
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
      eventTypes: JSON.parse(r.event_types) as AppEventType[],
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

  createSubscription(input: {
    appId: ID;
    url: string;
    eventTypes: AppEventType[];
  }): EventSubscription {
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
          : !mayInvite(r.creator_role as Role | null, r.creator_is_bot ?? 0, r.creator_can_invite)
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
  redactQueuedDeliveries(rows: { id: string; body: string }[]): void {
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
  requoteEvents(quotedIds: ID[], now: Pick<ReplyReference, "text" | "fileCount"> | null): void {
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
  reforwardEvents(ids: ID[], now: { text: string } | null): void {
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

  redactEventRows(rows: { seq: number; payload: string }[]): number {
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
         WHERE ${NAMES_ME} AND m.user_id != ? AND m.deleted_at IS NULL
         AND ${NOT_BLOCKED}
         AND ${UNREAD}
         AND (m.thread_root_id IS NULL OR EXISTS (
           SELECT 1 FROM messages root WHERE root.id = m.thread_root_id AND root.deleted_at IS NULL
         ))
         GROUP BY m.channel_id`,
      )
      .all(userId, userId, userId) as { channel_id: string; n: number }[];
    return Object.fromEntries(rows.map((row) => [row.channel_id, row.n]));
  }

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
}
