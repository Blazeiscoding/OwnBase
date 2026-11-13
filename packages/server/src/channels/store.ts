import type {
  Channel,
  ChannelPrefs,
  ChannelRemoval,
  ChannelType,
  ID,
  NotifyLevel,
  SidebarSection,
} from "@ownbase/protocol";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { oneOf, shape, type RowOf } from "../core/rows.js";
import { GUEST_SQL, IN_CHANNEL_TIMELINE, NAMES_ME, NOT_BLOCKED, UNREAD } from "../core/sqlRules.js";
import { ulid } from "../ids.js";
import type { Store } from "../store.js";

const NOTIFY_LEVELS = { all: true, mentions: true, nothing: true } satisfies Record<
  NotifyLevel,
  true
>;

const channelRow = shape({
  id: "text",
  type: oneOf({ public: true, private: true, dm: true, group_dm: true } satisfies Record<
    ChannelType,
    true
  >),
  name: "text",
  topic: "text",
  description: "text",
  creator_id: "text",
  archived: "number",
  created_at: "number",
});
type ChannelRow = RowOf<typeof channelRow.columns>;
const channelIdRow = channelRow.pick("id");
const lastSeqRow = shape({ id: "text", last_msg_seq: "number" });

/** A `channel_removals` row: a note that someone was taken out of a room. */
const removalRow = shape({
  id: "text",
  channel_id: "text",
  channel_name: "text",
  channel_type: oneOf({ public: true, private: true } satisfies Record<
    ChannelRemoval["channelType"],
    true
  >),
  removed_by: "text",
  created_at: "number",
});

/** One member's own choices for a conversation, as `channel_members` keeps them. */
const prefsRow = shape({
  notify_level: oneOf(NOTIFY_LEVELS),
  notify_chosen: "number",
  muted: "number",
  starred: "number",
  section_id: "text?",
  hidden_seq: "number?",
});
const membershipRow = prefsRow.with({
  channel_id: "text",
  last_read_seq: "number",
  replies_read_seq: "number",
});
const memberRow = shape({ channel_id: "text", user_id: "text" });
const memberIdRow = memberRow.pick("user_id");
const memberChannelRow = memberRow.pick("channel_id");
const readSeqRow = shape({ last_read_seq: "number" });
const perChannelRow = shape({ channel_id: "text", n: "number" });
const notifyDefaultRow = shape({ notify_default: oneOf(NOTIFY_LEVELS) });
const sectionRow = shape({ id: "text", name: "text" });
const idRow = shape({ id: "text" });
const replyRow = shape({ seq: "number", broadcast: "number" });

function toPrefs(r: RowOf<typeof prefsRow.columns>): ChannelPrefs {
  return {
    notifyLevel: r.notify_level,
    notifyChosen: r.notify_chosen === 1,
    muted: r.muted === 1,
    starred: r.starred === 1,
    sectionId: r.section_id,
    hiddenSeq: r.hidden_seq,
  };
}

/** Conversations and who is in them: rooms and DMs, membership, each member's prefs and read place, sidebar sections, and removal notes. */
export class ChannelStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

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
      type: r.type,
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
      ch.managerIds = memberIdRow
        .all(
          this.db.prepare(
            "SELECT user_id FROM channel_members WHERE channel_id = ? AND is_manager = 1 ORDER BY user_id",
          ),
          r.id,
        )
        .map((m) => m.user_id);
    }
    return ch;
  }

  create(input: {
    type: ChannelType;
    name?: string;
    topic?: string;
    description?: string;
    creatorId: ID;
    memberIds: ID[]; // including creator
    dmKey?: string;
    /** When it was made somewhere else, for a conversation brought in from another app. */
    createdAt?: number;
  }): Channel {
    const now = input.createdAt ?? Date.now();
    const id = ulid(now);
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
    return this.get(id)!;
  }

  get(id: ID): Channel | null {
    const r = channelRow.get(this.db.prepare("SELECT * FROM channels WHERE id = ?"), id);
    return r ? this.toChannel(r) : null;
  }

  /** Every conversation, archived and direct ones included, oldest first. */
  all(): Channel[] {
    return channelRow
      .all(this.db.prepare("SELECT * FROM channels ORDER BY id"))
      .map((r) => this.toChannel(r));
  }

  byName(name: string): Channel | null {
    const r = channelRow.get(
      this.db.prepare("SELECT * FROM channels WHERE name = ? AND type IN ('public','private')"),
      name,
    );
    return r ? this.toChannel(r) : null;
  }

  findDmByKey(dmKey: string): Channel | null {
    const r = channelRow.get(this.db.prepare("SELECT * FROM channels WHERE dm_key = ?"), dmKey);
    return r ? this.toChannel(r) : null;
  }

  retireDmKey(channelId: ID): void {
    this.db
      .prepare("UPDATE channels SET dm_key = NULL WHERE id = ? AND type = 'group_dm'")
      .run(channelId);
  }

  update(
    id: ID,
    patch: { name?: string; topic?: string; description?: string; archived?: boolean },
  ): Channel {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
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
      this.db.prepare(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    }
    // Messages waiting for this channel to reopen can go at the next flush.
    if (patch.archived === false) this.store.scheduled.wakeHeld({ channelId: id });
    return this.get(id)!;
  }

  /** Public channels + non-public channels the user belongs to; a guest, public only. */
  visibleTo(userId: ID): Channel[] {
    const rows = channelRow.all(
      this.db.prepare(
        `SELECT DISTINCT c.* FROM channels c
         LEFT JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
         WHERE c.type = 'public' OR (m.user_id IS NOT NULL AND NOT ${GUEST_SQL})
         ORDER BY c.name`,
      ),
      userId,
      userId,
    );
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
      memberRow.all(
        this.db.prepare(
          `SELECT channel_id, user_id FROM channel_members WHERE is_manager = 1
           ORDER BY channel_id, user_id`,
        ),
      ),
    );
    const members = group(
      memberRow.all(
        this.db.prepare(
          `SELECT m.channel_id, m.user_id FROM channel_members mine
           JOIN channels c ON c.id = mine.channel_id AND c.type IN ('dm', 'group_dm')
           JOIN channel_members m ON m.channel_id = mine.channel_id
           WHERE mine.user_id = ?
           ORDER BY m.channel_id, m.user_id`,
        ),
        userId,
      ),
    );
    return rows.map((r) => this.toChannel(r, { managers, members }));
  }

  /**
   * How many active people are in each channel (public or private) this
   * account can see, for the channel browser to say how big each one is.
   */
  roomMemberCounts(userId: ID): Record<ID, number> {
    const rows = perChannelRow.all(
      this.db.prepare(
        `SELECT c.id AS channel_id, COUNT(u.id) AS n FROM channels c
         JOIN channel_members m ON m.channel_id = c.id
         JOIN users u ON u.id = m.user_id AND u.deactivated = 0
         WHERE c.type = 'public' OR (c.type = 'private' AND EXISTS (
           SELECT 1 FROM channel_members mine
           WHERE mine.channel_id = c.id AND mine.user_id = ?) AND NOT ${GUEST_SQL})
         GROUP BY c.id`,
      ),
      userId,
      userId,
    );
    return Object.fromEntries(rows.map((r) => [r.channel_id, r.n]));
  }

  publicIds(): ID[] {
    return channelIdRow
      .all(this.db.prepare("SELECT id FROM channels WHERE type = 'public'"))
      .map((r) => r.id);
  }

  addMember(channelId: ID, userId: ID, notifyLevel: NotifyLevel = "mentions"): boolean {
    // What was written before joining is history to read, not news to catch
    // up on, any more than it was this member's to be told about: a new
    // member starts with the channel read, as in Slack, replies and all.
    const seq = this.store.currentSeq();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_members
           (channel_id, user_id, joined_at, notify_level, last_read_seq, replies_read_seq)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(channelId, userId, Date.now(), notifyLevel, seq, seq);
    if (res.changes > 0) this.store.scheduled.wakeHeld({ channelId, userId });
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
    this.store.outbox.access(channelId, userId);
    return true;
  }

  /** Adds someone at another member's asking; they are told their access wherever they are. */
  inviteMember(channelId: ID, userId: ID): boolean {
    if (!this.addMember(channelId, userId)) return false;
    this.store.outbox.access(channelId, userId);
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
    return memberIdRow
      .all(this.db.prepare("SELECT user_id FROM channel_members WHERE channel_id = ?"), channelId)
      .map((r) => r.user_id);
  }

  memberships(userId: ID): {
    channelId: ID;
    lastReadSeq: number;
    repliesReadSeq: number;
    prefs: ChannelPrefs;
  }[] {
    const rows = membershipRow.all(
      this.db.prepare(
        `SELECT channel_id, last_read_seq, replies_read_seq, notify_level, notify_chosen, muted,
                starred, section_id, hidden_seq
         FROM channel_members WHERE user_id = ?`,
      ),
      userId,
    );
    return rows.map((r) => ({
      channelId: r.channel_id,
      lastReadSeq: r.last_read_seq,
      repliesReadSeq: r.replies_read_seq,
      prefs: toPrefs(r),
    }));
  }

  prefs(channelId: ID, userId: ID): ChannelPrefs | null {
    const r = prefsRow.get(
      this.db.prepare(
        `SELECT notify_level, notify_chosen, muted, starred, section_id, hidden_seq
         FROM channel_members WHERE channel_id = ? AND user_id = ?`,
      ),
      channelId,
      userId,
    );
    return r ? toPrefs(r) : null;
  }

  setPrefs(
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
    const prefs = this.prefs(channelId, userId);
    if (prefs) this.tellPrefs(channelId, userId);
    return prefs;
  }

  /** Preferences are personal: only this account's own devices hear of them. */
  private tellPrefs(channelId: ID, userId: ID): void {
    this.store.outbox.person(
      userId,
      () => {
        const prefs = this.prefs(channelId, userId);
        return prefs ? { type: "prefs", channelId, prefs } : null;
      },
      { key: `prefs:${channelId}` },
    );
  }

  /** What this account's conversations notify about unless one is set on its own (v53). */
  notifyDefault(userId: ID): NotifyLevel {
    return (
      notifyDefaultRow.get(this.db.prepare("SELECT notify_default FROM users WHERE id = ?"), userId)
        ?.notify_default ?? "mentions"
    );
  }

  setNotifyDefault(userId: ID, level: NotifyLevel): void {
    this.db.prepare("UPDATE users SET notify_default = ? WHERE id = ?").run(level, userId);
    this.store.outbox.person(userId, { type: "notify.default", level });
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

  /** One account's sidebar sections, in its order. */
  sections(userId: ID): SidebarSection[] {
    return sectionRow.all(
      this.db.prepare(
        "SELECT id, name FROM sidebar_sections WHERE user_id = ? ORDER BY position, created_at, id",
      ),
      userId,
    );
  }

  ownsSection(userId: ID, sectionId: ID): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sidebar_sections WHERE id = ? AND user_id = ?")
      .get(sectionId, userId);
  }

  /** Adds a section at the end of the account's list. */
  createSection(userId: ID, name: string): SidebarSection {
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
    this.store.outbox.person(
      userId,
      () => ({ type: "sidebar.sections", sections: this.sections(userId) }),
      { key: "sidebar.sections" },
    );
  }

  /** Renames one of the account's sections; false when it has no such section. */
  renameSection(userId: ID, sectionId: ID, name: string): boolean {
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
  deleteSection(userId: ID, sectionId: ID): ID[] | null {
    const gone = this.db
      .prepare("DELETE FROM sidebar_sections WHERE id = ? AND user_id = ?")
      .run(sectionId, userId);
    if (gone.changes === 0) return null;
    const freed = memberChannelRow.all(
      this.db.prepare(
        `UPDATE channel_members SET section_id = NULL WHERE user_id = ? AND section_id = ?
         RETURNING channel_id`,
      ),
      userId,
      sectionId,
    );
    for (const row of freed) this.tellPrefs(row.channel_id, userId);
    this.tellSections(userId);
    return freed.map((row) => row.channel_id);
  }

  /** Puts the account's sections in this order; false unless `ids` is every one of them. */
  orderSections(userId: ID, ids: ID[]): boolean {
    const have = this.sections(userId).map((section) => section.id);
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
    return this.store.outbox.hold(() => {
      const before = readSeqRow.get(
        this.db.prepare(
          "SELECT last_read_seq FROM channel_members WHERE channel_id = ? AND user_id = ?",
        ),
        channelId,
        userId,
      );
      const row = readSeqRow.get(
        this.db.prepare(
          "UPDATE channel_members SET last_read_seq = MAX(last_read_seq, ?) WHERE channel_id = ? AND user_id = ? RETURNING last_read_seq",
        ),
        Math.min(seq, this.store.currentSeq()),
        channelId,
        userId,
      );
      const after = row?.last_read_seq ?? 0;
      this.store.outbox.person(userId, { type: "channel.read", channelId, seq: after });
      this.store.outbox.mentions([userId]);
      if (!before || after <= before.last_read_seq) return { seq: after, threads: [] };
      // Threads with a copy this read passes, and threads marked unread that it
      // reads past where the channel stood: their held copies are read now.
      const roots = idRow.all(
        this.db.prepare(
          `SELECT thread_root_id AS id FROM messages
           WHERE channel_id = ? AND broadcast = 1 AND thread_root_id IS NOT NULL
             AND deleted_at IS NULL AND seq > ? AND seq <= ?
           UNION
           SELECT f.root_id FROM thread_follows f JOIN messages root ON root.id = f.root_id
           WHERE f.user_id = ? AND root.channel_id = ?
             AND f.unread_hold IS NOT NULL AND f.unread_hold < ?`,
        ),
        channelId,
        before.last_read_seq,
        after,
        userId,
        channelId,
        after,
      );
      const threads = roots.filter(({ id }) => this.readChannelCopies(userId, id, after));
      // Replies also sent to the channel were read there, and so in their threads.
      for (const { id } of threads) this.store.threads.tellFollow(userId, id);
      return { seq: after, threads: threads.map(({ id }) => id) };
    });
  }

  /**
   * Moves a thread's cursor over the channel copies up to `channelRead`; true
   * if it moved. Not while the thread is held unread at or past `channelRead`.
   */
  private readChannelCopies(userId: ID, rootId: ID, channelRead: number): boolean {
    const current = this.store.threads.follow(userId, rootId);
    if (!current || (current.unreadHold !== undefined && channelRead <= current.unreadHold))
      return false;
    const replies = replyRow.all(
      this.db.prepare(
        `SELECT seq, broadcast FROM messages
         WHERE thread_root_id = ? AND deleted_at IS NULL AND seq > ? ORDER BY seq`,
      ),
      rootId,
      current.lastReadSeq,
    );
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
      .run(userId, rootId, read, this.store.threads.nextFollowRevision());
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
    const row = readSeqRow.get(
      this.db.prepare(
        `UPDATE channel_members SET last_read_seq = ? WHERE channel_id = ? AND user_id = ?
         RETURNING last_read_seq`,
      ),
      Math.max(0, seq - 1),
      channelId,
      userId,
    );
    const now = row?.last_read_seq ?? 0;
    this.store.outbox.person(userId, { type: "channel.unread", channelId, seq: now });
    this.store.outbox.mentions([userId]);
    return now;
  }

  lastMessageSeq(channelId: ID): number {
    return (
      lastSeqRow
        .pick("last_msg_seq")
        .get(this.db.prepare("SELECT last_msg_seq FROM channels WHERE id = ?"), channelId)
        ?.last_msg_seq ?? 0
    );
  }

  /** channelId -> last message seq, for every channel the user can see. */
  lastSeqMap(userId: ID): Record<ID, number> {
    const rows = lastSeqRow.all(
      this.db.prepare(
        `SELECT DISTINCT c.id, c.last_msg_seq FROM channels c
         LEFT JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
         WHERE c.type = 'public' OR m.user_id IS NOT NULL`,
      ),
      userId,
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.id] = r.last_msg_seq;
    return out;
  }

  /** How many unread notes of removals the handshake carries, newest first. */
  static readonly REMOVALS_SENT = 100;

  private static fromRemovalRow(row: RowOf<typeof removalRow.columns>): ChannelRemoval {
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
  addRemoval(userId: ID, channel: Channel, removedBy: ID): ChannelRemoval | null {
    if (channel.type !== "public" && channel.type !== "private") return null;
    const row = removalRow.get(
      this.db.prepare(
        `INSERT INTO channel_removals
           (id, user_id, channel_id, channel_name, channel_type, removed_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      ),
      ulid(),
      userId,
      channel.id,
      channel.name,
      channel.type,
      removedBy,
      Date.now(),
    )!;
    const removal = ChannelStore.fromRemovalRow(row);
    // They hear who removed them, in Activity, wherever they are.
    this.store.outbox.person(userId, { type: "channel.removal", removal }, { ahead: true });
    return removal;
  }

  /** One account's unread notes of removals, newest first. */
  removals(userId: ID, limit = ChannelStore.REMOVALS_SENT): ChannelRemoval[] {
    const rows = removalRow.all(
      this.db.prepare(
        `SELECT * FROM channel_removals WHERE user_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      ),
      userId,
      limit,
    );
    return rows.map(ChannelStore.fromRemovalRow);
  }

  /**
   * Reads, and so clears, some of one account's notes of removals. Returns the
   * ids that were there; another account's are left alone.
   */
  readRemovals(userId: ID, ids: readonly ID[]): ID[] {
    const remove = this.db.prepare(
      "DELETE FROM channel_removals WHERE id = ? AND user_id = ? RETURNING id",
    );
    const read: ID[] = [];
    for (const id of new Set(ids)) if (remove.get(id, userId)) read.push(id);
    if (read.length > 0)
      this.store.outbox.person(userId, { type: "channel.removals.read", ids: read });
    return read;
  }

  /**
   * Unread mentions per conversation, for the badge beside its name. Read
   * from who each message names, so it costs what this account's mentions
   * cost, not what its channels' histories do.
   */
  unreadMentionCounts(userId: ID): Record<ID, number> {
    const rows = perChannelRow.all(
      this.db.prepare(
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
      ),
      userId,
      userId,
      userId,
    );
    return Object.fromEntries(rows.map((row) => [row.channel_id, row.n]));
  }
}
