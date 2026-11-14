import type { ID, Invite, InviteStatus, SessionInfo, User } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { countOf, oneOfOrNull, shape, type RowOf } from "../core/rows.js";
import { inviteCode, ulid } from "../ids.js";
import { mayInvite, ROLES, toUser, userRow } from "../people/store.js";
import { SESSION_TTL_MS, type Store } from "../store.js";

const twoStepRow = shape({
  two_step_secret: "text?",
  two_step_step: "number?",
  codes_left: "number",
});
const idRow = shape({ id: "text" });
const tokenRow = shape({ token_hash: "text" });
const sessionRow = shape({
  id: "text",
  created_at: "number",
  last_seen_at: "number",
  expires_at: "number",
  user_agent: "text",
});
const mustChangeRow = shape({ must_change_password: "number" });
/** An `invites` row with what its creator may do; see `INVITE_COLUMNS`. */
const inviteRow = shape({
  code: "text",
  created_by: "text",
  created_at: "number",
  expires_at: "number?",
  max_uses: "number?",
  uses: "number",
  revoked_at: "number?",
  creator_deactivated: "number",
  creator_role: oneOfOrNull(ROLES),
  creator_is_bot: "number?",
  creator_can_invite: "number?",
});

/** Signing in: sessions, passwords, two-step keys and recovery codes, guests, and invites. */
export class AccountStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

  /**
   * An account's two-step sign-in (E11): its authenticator key, or null for
   * none; the last time step a code was accepted for; and how many recovery
   * codes it has left.
   */
  twoStep(userId: ID): { secret: string | null; step: number | null; codesLeft: number } {
    const row = twoStepRow.get(
      this.db.prepare(
        `SELECT two_step_secret, two_step_step,
           (SELECT COUNT(*) FROM two_step_codes c WHERE c.user_id = u.id AND c.used_at IS NULL)
             AS codes_left
         FROM users u WHERE id = ?`,
      ),
      userId,
    );
    return {
      secret: row?.two_step_secret ?? null,
      step: row?.two_step_step ?? null,
      codesLeft: row?.codes_left ?? 0,
    };
  }

  /** The accounts with two-step sign-in on, for the admins' list (E11). */
  twoStepUserIds(): Set<ID> {
    const rows = idRow.all(
      this.db.prepare("SELECT id FROM users WHERE two_step_secret IS NOT NULL"),
    );
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
    const r = userRow.get(
      this.db.prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND u.deactivated = 0 AND s.expires_at > ?`,
      ),
      tokenHash,
      now,
    );
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

  /** How many sessions are signed in now, everyone's, for the host's metrics. */
  liveSessions(now = Date.now()): number {
    return countOf(this.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?"), now);
  }

  /** How many guests are signed in now, which bounds how many more are let in. */
  liveGuestSessions(now = Date.now()): number {
    return countOf(
      this.db.prepare(
        `SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE u.role = 'guest' AND s.expires_at > ?`,
      ),
      now,
    );
  }

  /**
   * Everyone a new public channel takes in: active people, not apps, and a
   * guest only while still signed in, since an ended guest never comes back.
   */
  listPeopleIds(now = Date.now()): ID[] {
    const rows = idRow.all(
      this.db.prepare(
        `SELECT u.id FROM users u
         WHERE u.deactivated = 0 AND u.is_bot = 0
           AND (u.role != 'guest' OR EXISTS (
             SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?))
         ORDER BY u.id`,
      ),
      now,
    );
    return rows.map((r) => r.id);
  }

  /** Ends every guest's session, reporting the tokens so their sockets close too. */
  revokeGuestSessions(): string[] {
    const where = "user_id IN (SELECT id FROM users WHERE role = 'guest')";
    const rows = tokenRow.all(this.db.prepare(`SELECT token_hash FROM sessions WHERE ${where}`));
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
    return this.store.people.get(id)!;
  }

  /** One person's signed-in devices, newest first. */
  listSessions(userId: ID): Omit<SessionInfo, "current">[] {
    const rows = sessionRow.all(
      this.db.prepare(
        `SELECT id, created_at, last_seen_at, expires_at, user_agent FROM sessions
         WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`,
      ),
      userId,
      Date.now(),
    );
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
    const rows = tokenRow.all(
      this.db.prepare(`SELECT token_hash FROM sessions WHERE ${clause}`),
      ...params,
    );
    this.db.prepare(`DELETE FROM sessions WHERE ${clause}`).run(...params);
    return rows.map((r) => r.token_hash);
  }

  /** The listable id of the session behind a token, so it can mark itself. */
  sessionIdFor(tokenHash: string): ID | null {
    return (
      idRow.get(this.db.prepare("SELECT id FROM sessions WHERE token_hash = ?"), tokenHash)?.id ??
      null
    );
  }

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
    return Number(this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes);
  }

  /**
   * Replaces someone's password. Their sessions are the caller's to revoke.
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

  /**
   * The same password hashed again, stored only if the hash is still `old`,
   * so a change or reset made meanwhile wins. Whether it was stored.
   */
  rehashPassword(
    userId: ID,
    old: { passwordHash: string; salt: string },
    next: { hash: string; salt: string },
  ): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE users SET password_hash = ?, salt = ? WHERE id = ? AND password_hash = ? AND salt = ?",
          )
          .run(next.hash, next.salt, userId, old.passwordHash, old.salt).changes,
      ) > 0
    );
  }

  mustChangePassword(userId: ID): boolean {
    const row = mustChangeRow.get(
      this.db.prepare("SELECT must_change_password FROM users WHERE id = ?"),
      userId,
    );
    return row?.must_change_password === 1;
  }

  createInvite(input: { createdBy: ID; expiresAt: number | null; maxUses: number | null }): Invite {
    const code = inviteCode();
    this.db
      .prepare(
        "INSERT INTO invites (code, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)",
      )
      .run(code, input.createdBy, Date.now(), input.expiresAt, input.maxUses);
    return this.getInvite(code)!;
  }

  private toInvite(r: RowOf<typeof inviteRow.columns>, now: number): Invite {
    // Revoked first: it is the one somebody chose, and it stays true whatever
    // else changes. A creator who has been deactivated comes next, and unlike
    // revocation it lifts again if they are reactivated.
    const status: InviteStatus =
      r.revoked_at !== null
        ? "revoked"
        : r.creator_deactivated !== 0
          ? "creator_deactivated"
          : !mayInvite(r.creator_role, r.creator_is_bot ?? 0, r.creator_can_invite)
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
    const r = inviteRow.get(
      this.db.prepare(
        `SELECT ${AccountStore.INVITE_COLUMNS} FROM invites i LEFT JOIN users u ON u.id = i.created_by
         WHERE i.code = ?`,
      ),
      code,
    );
    return r ? this.toInvite(r, now) : null;
  }

  /** Newest first. Everyone's when `createdBy` is omitted, which is for administrators. */
  listInvites(opts: { createdBy?: ID; limit?: number } = {}, now = Date.now()): Invite[] {
    const rows = inviteRow.all(
      this.db.prepare(
        `SELECT ${AccountStore.INVITE_COLUMNS} FROM invites i LEFT JOIN users u ON u.id = i.created_by
         ${opts.createdBy ? "WHERE i.created_by = ?" : ""}
         ORDER BY i.created_at DESC, i.code DESC LIMIT ?`,
      ),
      ...(opts.createdBy ? [opts.createdBy] : []),
      opts.limit ?? 200,
    );
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

  consumeInvite(code: string): boolean {
    if (this.getInvite(code)?.status !== "active") return false;
    this.db.prepare("UPDATE invites SET uses = uses + 1 WHERE code = ?").run(code);
    return true;
  }
}
