import type { EventEnvelope, ID, WorkspaceEvent } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { AccountStore } from "./accounts/store.js";
import { AuditLog } from "./admin/auditLog.js";
import { ReportStore } from "./admin/reportStore.js";
import { DeliveryStore } from "./apps/deliveryStore.js";
import { AppStore } from "./apps/store.js";
import { ChannelStore } from "./channels/store.js";
import { Settings } from "./core/settings.js";
import { Outbox } from "./events/outbox.js";
import { FileStore } from "./files/store.js";
import { MessageStore } from "./messages/store.js";
import { PeopleStore } from "./people/store.js";
import { PollStore } from "./polls/store.js";
import { ReminderStore } from "./reminders/store.js";
import { SavedStore } from "./saved/store.js";
import { ScheduledStore } from "./scheduled/store.js";
import { SearchStore } from "./search/store.js";
import { ThreadStore } from "./threads/store.js";

/** How long a session survives without being used. */
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

export class Store {
  /** What the writes here have to tell people, sent once they are committed. */
  readonly outbox: Outbox = new Outbox({
    memberIds: (channelId) => this.channels.memberIds(channelId),
    unreadMentionCounts: (userId) => this.channels.unreadMentionCounts(userId),
  });
  /** The workspace's settings, kept in `meta`; see core/settings.ts. */
  readonly settings: Settings;
  readonly accounts: AccountStore;
  readonly people: PeopleStore;
  readonly channels: ChannelStore;
  readonly messages: MessageStore;
  readonly files: FileStore;
  readonly search: SearchStore;
  readonly threads: ThreadStore;
  readonly scheduled: ScheduledStore;
  readonly saved: SavedStore;
  readonly polls: PollStore;
  readonly reminders: ReminderStore;
  readonly apps: AppStore;
  readonly deliveries: DeliveryStore;
  readonly audit: AuditLog;
  readonly reports: ReportStore;

  constructor(readonly db: DatabaseSync) {
    this.settings = new Settings(this);
    this.accounts = new AccountStore(db, this);
    this.people = new PeopleStore(db, this);
    this.channels = new ChannelStore(db, this);
    this.messages = new MessageStore(db, this);
    this.files = new FileStore(db, this);
    this.search = new SearchStore(db, this);
    this.threads = new ThreadStore(db, this);
    this.scheduled = new ScheduledStore(db, this);
    this.saved = new SavedStore(db, this);
    this.polls = new PollStore(db, this);
    this.reminders = new ReminderStore(db, this);
    this.apps = new AppStore(db, this);
    this.deliveries = new DeliveryStore(db);
    this.audit = new AuditLog(db);
    this.reports = new ReportStore(db, this);
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

  listMeta(prefix: string): { key: string; value: string }[] {
    return this.db
      .prepare("SELECT key, value FROM meta WHERE substr(key, 1, ?) = ? ORDER BY key")
      .all(prefix.length, prefix) as { key: string; value: string }[];
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
    return this.channels.isMember(channelId, userId) && !this.people.isGuest(userId);
  }

  // ---------- event log ----------

  /**
   * `messageId` is the message it is about, kept beside the payload so that
   * removing the message finds every copy of its words without reading the
   * whole log (messages/eventLog.ts).
   */
  appendEvent(event: WorkspaceEvent, channelId: ID | null, messageId: ID | null): EventEnvelope {
    const res = this.db
      .prepare(
        "INSERT INTO events (channel_id, type, payload, created_at, message_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(channelId, event.type, JSON.stringify(event), Date.now(), messageId);
    return { seq: Number(res.lastInsertRowid), event };
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

  /** The database's size on disk, without its write-ahead log. */
  databaseBytes(): number {
    const pages = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const size = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
    return pages.page_count * size.page_size;
  }

  /** App events waiting and given up on, for admin status: counts only (OPS-10). */
  deliveryCounts(): { waiting: number; oldestWaitingAt: number | null; failed: number } {
    const deliveries = this.db
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE failed_at IS NULL) AS waiting,
                MIN(created_at) FILTER (WHERE failed_at IS NULL) AS oldest,
                COUNT(*) FILTER (WHERE failed_at IS NOT NULL) AS failed
         FROM event_deliveries`,
      )
      .get() as { waiting: number; oldest: number | null; failed: number };
    return {
      waiting: deliveries.waiting,
      oldestWaitingAt: deliveries.oldest,
      failed: deliveries.failed,
    };
  }
}
