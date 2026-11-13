import type { ID, PushPreview } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { countOf, oneOf, shape } from "../core/rows.js";

const subscriptionRow = shape({
  endpoint: "text",
  user_id: "text",
  p256dh: "text",
  auth: "text",
  preview: oneOf<PushPreview>({ full: true, sender: true, none: true }),
});
const userRow = shape({ user_id: "text" });

/** One browser to push to, for one of its account's sessions. */
export interface PushSubscription {
  endpoint: string;
  userId: ID;
  p256dh: string;
  auth: string;
  preview: PushPreview;
}

/** Browsers one account may have subscribed at once; the oldest goes past it. */
export const SUBSCRIPTIONS_PER_ACCOUNT = 10;

/** Push subscriptions (G09), one per session, gone with it. */
export class PushStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Keeps a session's subscription. A browser has one endpoint, so one that
   * another session kept, such as before signing in as someone else, moves
   * to this one.
   */
  add(sessionHash: string, subscription: PushSubscription, now = Date.now()): void {
    this.db
      .prepare("DELETE FROM push_subscriptions WHERE endpoint = ? OR session_hash = ?")
      .run(subscription.endpoint, sessionHash);
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, session_hash, user_id, p256dh, auth, preview, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        subscription.endpoint,
        sessionHash,
        subscription.userId,
        subscription.p256dh,
        subscription.auth,
        subscription.preview,
        now,
      );
    this.db
      .prepare(
        `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN (
           SELECT endpoint FROM push_subscriptions WHERE user_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      )
      .run(subscription.userId, subscription.userId, SUBSCRIPTIONS_PER_ACCOUNT);
  }

  removeSession(sessionHash: string): boolean {
    return (
      this.db.prepare("DELETE FROM push_subscriptions WHERE session_hash = ?").run(sessionHash)
        .changes > 0
    );
  }

  /** The push service said this browser is gone. */
  removeEndpoint(endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  forUser(userId: ID): PushSubscription[] {
    return subscriptionRow
      .all(
        this.db.prepare(
          "SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at, rowid",
        ),
        userId,
      )
      .map(fromRow);
  }

  forSession(sessionHash: string): PushSubscription | null {
    const row = subscriptionRow.get(
      this.db.prepare("SELECT * FROM push_subscriptions WHERE session_hash = ?"),
      sessionHash,
    );
    return row ? fromRow(row) : null;
  }

  /** The members of a conversation with a browser to push to, in a fixed order. */
  membersWithSubscriptions(channelId: ID): ID[] {
    return userRow
      .all(
        this.db.prepare(
          `SELECT DISTINCT cm.user_id FROM channel_members cm
           JOIN push_subscriptions ps ON ps.user_id = cm.user_id
           WHERE cm.channel_id = ? ORDER BY cm.user_id`,
        ),
        channelId,
      )
      .map((row) => row.user_id);
  }

  count(): number {
    return countOf(this.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions"));
  }
}

function fromRow(row: ReturnType<typeof subscriptionRow.read>): PushSubscription {
  return {
    endpoint: row.endpoint,
    userId: row.user_id,
    p256dh: row.p256dh,
    auth: row.auth,
    preview: row.preview,
  };
}
