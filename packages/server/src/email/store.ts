import type { EmailAddressInfo, ID } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { oneOf, shape } from "../core/rows.js";
import { ROLES } from "../people/store.js";

/** What a mailed link is for (G10). */
export type EmailLinkPurpose = "verify" | "reset";

const addressRow = shape({ email: "text?", email_verified_at: "number?" });
const pendingRow = shape({ email: "text" });
const linkRow = shape({
  user_id: "text",
  email: "text",
  expires_at: "number",
});
const ownerRow = shape({
  id: "text",
  handle: "text",
  display_name: "text",
  role: oneOf(ROLES),
  deactivated: "number",
  is_bot: "number",
  password_hash: "text",
});

/** The account an address belongs to, with what decides whether it may be mailed. */
export interface AddressOwner {
  id: ID;
  handle: string;
  displayName: string;
  role: keyof typeof ROLES;
  deactivated: boolean;
  isBot: boolean;
  /** False for a guest, or an account made by single sign-on: no password to set. */
  hasPassword: boolean;
}

/** Email addresses on accounts, and the links mailed to confirm one or set a new password (G10). */
export class EmailStore {
  constructor(private readonly db: DatabaseSync) {}

  /** The account's confirmed address, and one waiting on its link. */
  addressOf(userId: ID, now = Date.now()): EmailAddressInfo {
    const row = addressRow.get(
      this.db.prepare("SELECT email, email_verified_at FROM users WHERE id = ?"),
      userId,
    );
    const pending = pendingRow.get(
      this.db.prepare(
        `SELECT email FROM email_links
         WHERE user_id = ? AND purpose = 'verify' AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      ),
      userId,
      now,
    );
    return {
      email: row?.email ?? null,
      verifiedAt: row?.email_verified_at ?? null,
      pending: pending?.email ?? null,
    };
  }

  /** Who confirmed this address, in any case. */
  ownerOf(email: string): AddressOwner | null {
    const row = ownerRow.get(
      this.db.prepare(
        `SELECT id, handle, display_name, role, deactivated, is_bot, password_hash
         FROM users WHERE lower(email) = lower(?)`,
      ),
      email,
    );
    return row
      ? {
          id: row.id,
          handle: row.handle,
          displayName: row.display_name,
          role: row.role,
          deactivated: row.deactivated === 1,
          isBot: row.is_bot === 1,
          hasPassword: row.password_hash !== "",
        }
      : null;
  }

  /**
   * Keeps a link's token, by its hash, in place of any earlier one of the
   * account's for the same purpose: only the newest link mailed works.
   */
  addLink(
    link: { tokenHash: string; userId: ID; purpose: EmailLinkPurpose; email: string },
    ttlMs: number,
    now = Date.now(),
  ): void {
    this.db
      .prepare("DELETE FROM email_links WHERE user_id = ? AND purpose = ?")
      .run(link.userId, link.purpose);
    this.db
      .prepare(
        `INSERT INTO email_links (token_hash, user_id, purpose, email, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(link.tokenHash, link.userId, link.purpose, link.email, now, now + ttlMs);
  }

  /** A link that still works, without using it up. */
  peekLink(
    tokenHash: string,
    purpose: EmailLinkPurpose,
    now = Date.now(),
  ): { userId: ID; email: string } | null {
    const row = linkRow.get(
      this.db.prepare(
        "SELECT user_id, email, expires_at FROM email_links WHERE token_hash = ? AND purpose = ?",
      ),
      tokenHash,
      purpose,
    );
    if (!row || row.expires_at <= now) return null;
    return { userId: row.user_id, email: row.email };
  }

  /** Uses a link up, if it still works. Call inside the transaction that acts on it. */
  takeLink(
    tokenHash: string,
    purpose: EmailLinkPurpose,
    now = Date.now(),
  ): { userId: ID; email: string } | null {
    const link = this.peekLink(tokenHash, purpose, now);
    this.db
      .prepare("DELETE FROM email_links WHERE token_hash = ? AND purpose = ?")
      .run(tokenHash, purpose);
    return link;
  }

  /** Every link of the account's for `purpose`, or for any purpose. */
  dropLinks(userId: ID, purpose?: EmailLinkPurpose): void {
    if (purpose)
      this.db
        .prepare("DELETE FROM email_links WHERE user_id = ? AND purpose = ?")
        .run(userId, purpose);
    else this.db.prepare("DELETE FROM email_links WHERE user_id = ?").run(userId);
  }

  /** Makes `email` the account's confirmed address. The unique index refuses one another account has. */
  confirm(userId: ID, email: string, now = Date.now()): void {
    this.db
      .prepare("UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?")
      .run(email, now, userId);
  }

  remove(userId: ID): void {
    this.db
      .prepare("UPDATE users SET email = NULL, email_verified_at = NULL WHERE id = ?")
      .run(userId);
    this.dropLinks(userId);
  }

  pruneLinks(now = Date.now()): void {
    this.db.prepare("DELETE FROM email_links WHERE expires_at <= ?").run(now);
  }
}
