import type { FollowedThread, ID, Message, ThreadFollow } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { READ_IN_CHANNEL } from "../core/sqlRules.js";
import type { MessageRow, Store } from "../store.js";

/** Threads: a root's replies, and who follows each thread, how far they have read and whether it is muted. */
export class ThreadStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

  /** Thread pages are oldest-first and contain only direct replies to this root. */
  history(
    channelId: ID,
    rootId: ID,
    opts: { before?: ID; after?: ID; around?: ID; limit: number },
  ): { messages: Message[]; hasMoreOlder: boolean; hasMoreNewer: boolean } {
    if (opts.around) {
      const olderLimit = Math.floor((opts.limit - 1) / 2);
      const older = this.history(channelId, rootId, {
        before: opts.around,
        limit: olderLimit,
      });
      const newer = this.history(channelId, rootId, {
        after: opts.around,
        limit: opts.limit - 1 - olderLimit,
      });
      const target = this.store.messages.get(opts.around);
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
      messages: this.store.messages.hydrate(rows),
      hasMoreOlder: exists("<", first),
      hasMoreNewer: exists(">", last),
    };
  }

  /** The replies still standing in a thread, oldest first. */
  replyIds(rootId: ID): ID[] {
    return (
      this.db
        .prepare(
          "SELECT id FROM messages WHERE thread_root_id = ? AND deleted_at IS NULL ORDER BY id",
        )
        .all(rootId) as { id: string }[]
    ).map((r) => r.id);
  }

  /**
   * A thread's follow state for one account. A thread this account has not
   * touched has no row: it reads as not followed, and read as far as the
   * membership's `replies_read_seq`, which is where a reply counts as read
   * without a cursor of its own thread (see migration v30).
   */
  follow(userId: ID, rootId: ID): ThreadFollow | null {
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
  nextFollowRevision(): number {
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

  setFollow(userId: ID, rootId: ID, following: boolean): ThreadFollow | null {
    const current = this.follow(userId, rootId);
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
    this.tellFollow(userId, rootId);
    return this.follow(userId, rootId);
  }

  /**
   * Mutes a thread for one account, or lifts that. Muting unfollows it and
   * keeps it unfollowed when this account replies; lifting it leaves it
   * unfollowed. Neither reads it: the cursor stays where it was.
   */
  setMute(userId: ID, rootId: ID, muted: boolean): ThreadFollow | null {
    const current = this.follow(userId, rootId);
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
    this.tellFollow(userId, rootId);
    return this.follow(userId, rootId);
  }

  /**
   * Advances a thread's read cursor, followed or not: reading a thread is how
   * its replies, and the mentions in them, are read, and it reads nothing else
   * in the channel. A thread not followed gets a cursor without following it.
   * Clamped to what exists, so a client reporting a seq from a message it has
   * since lost cannot park the cursor in the future and hide later replies.
   */
  markRead(userId: ID, rootId: ID, seq: number): ThreadFollow | null {
    const current = this.follow(userId, rootId);
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
    this.tellFollow(userId, rootId);
    // Reading a thread, or leaving it unread, moves the mentions in its replies.
    this.store.outbox.mentions([userId]);
    return this.follow(userId, rootId);
  }

  /**
   * Leaves the root or a reply and everything after it unread. Marking a
   * thread unread is a statement of intent to come back, so it follows it too,
   * ending a mute.
   * It holds against the channel's cursor where that stands now: a reply also
   * sent to the channel stays unread until the thread is read, or the channel
   * is read past this point.
   */
  markUnread(userId: ID, rootId: ID, seq: number): ThreadFollow | null {
    if (!this.follow(userId, rootId)) return null;
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
    this.tellFollow(userId, rootId);
    // Reading a thread, or leaving it unread, moves the mentions in its replies.
    this.store.outbox.mentions([userId]);
    return this.follow(userId, rootId);
  }

  /** This account's devices hear its state for one thread as it ends up. */
  tellFollow(userId: ID, rootId: ID): void {
    this.store.outbox.person(
      userId,
      () => {
        const state = this.follow(userId, rootId);
        return state ? { type: "thread.follow", state } : null;
      },
      { key: `thread.follow:${rootId}` },
    );
  }

  /**
   * Tells everyone following a thread, and whoever else is named, their state
   * for it after a reply: each needs its new watermark.
   */
  tellFollowers(rootId: ID, also: ID[]): void {
    for (const userId of new Set([...this.followers(rootId), ...also]))
      this.tellFollow(userId, rootId);
  }

  /**
   * Writing in a thread follows it. The author of a reply is caught up by
   * definition; the root's author starts from their own message so the reply
   * that just arrived counts as unread. An account that explicitly unfollowed
   * keeps that choice unless it is the one replying; one that muted the thread
   * keeps it even then, caught up to its own reply.
   */
  autoFollow(rootId: ID, replierId: ID, replySeq: number): void {
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
      const read = this.follow(root.user_id, rootId)?.lastReadSeq ?? 0;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO thread_follows (user_id, root_id, following, last_read_seq, revision)
           VALUES (?, ?, 1, ?, ?)`,
        )
        .run(root.user_id, rootId, Math.max(root.seq, read), this.nextFollowRevision());
    }
  }

  /** Every follow row this account can still reach, for the handshake snapshot. */
  follows(userId: ID): ThreadFollow[] {
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
  followed(
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
              AND r.seq > f.last_read_seq AND NOT ${READ_IN_CHANNEL}) AS unread_count
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
    const roots = this.store.messages.hydrate(page);
    const last = page.at(-1);
    // Each thread's newest reply, for the list to show where it has got to;
    // not one deleted, nor one by someone this account blocked.
    const newest = this.db.prepare(
      `SELECT r.* FROM messages r
       WHERE r.thread_root_id = ? AND r.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.user_id = ? AND ub.blocked_id = r.user_id)
       ORDER BY r.id DESC LIMIT 1`,
    );
    const replyRows = page.flatMap((row) =>
      (newest.all(row.id, userId) as unknown as MessageRow[]).slice(0, 1),
    );
    const replies = new Map(
      this.store.messages.hydrate(replyRows).map((reply) => [reply.threadRootId, reply]),
    );
    return {
      threads: roots.map((root, index) => ({
        root,
        lastSeq: page[index]!.last_seq,
        unreadCount: page[index]!.unread_count,
        latestReply: replies.get(root.id) ?? null,
      })),
      nextCursor: rows.length > limit && last ? `${last.last_seq}:${last.id}` : null,
    };
  }

  /** Everyone currently following a thread, for fanning an update out to them. */
  followers(rootId: ID): ID[] {
    const rows = this.db
      .prepare("SELECT user_id FROM thread_follows WHERE root_id = ? AND following = 1")
      .all(rootId) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  /** How many followed threads have replies this account has not seen. */
  unreadCount(userId: ID): number {
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
           AND r.seq > f.last_read_seq AND NOT ${READ_IN_CHANNEL}
         )`,
      )
      .get(userId, userId) as { n: number };
    return row.n;
  }
}
