/**
 * SQL for rules more than one feature's queries share: what is unread, what
 * mentions someone, who is blocked, what a channel's timeline shows.
 */

/** True for the user bound as the next parameter when that user is a guest. */
export const GUEST_SQL = "EXISTS (SELECT 1 FROM users g WHERE g.id = ? AND g.role = 'guest')";

/**
 * What belongs in a channel's own timeline: top-level messages, plus the thread
 * replies whose authors chose to send them to the channel too. Defined once so
 * paging, jumping and the live tail cannot drift apart on what a channel holds.
 */
export const IN_CHANNEL_TIMELINE = "(thread_root_id IS NULL OR broadcast = 1)";

/**
 * The condition for "this message is unread", beside `channel_members cm`;
 * the client's `isMessageRead` is the same rule. The channel's cursor reads
 * what the channel shows. A reply is read through its thread: by the
 * thread's cursor, or without one by the membership's `replies_read_seq`.
 * A reply also sent to the channel is read by the channel's cursor as well,
 * unless the thread was marked unread since the channel was last read past
 * where its cursor then stood (`unread_hold`): an explicit unread holds.
 */
export const UNREAD = `(CASE WHEN m.thread_root_id IS NULL THEN m.seq > cm.last_read_seq
    ELSE m.seq > COALESCE((SELECT tf.last_read_seq FROM thread_follows tf
        WHERE tf.user_id = cm.user_id AND tf.root_id = m.thread_root_id), cm.replies_read_seq)
      AND NOT (m.broadcast = 1 AND m.seq <= cm.last_read_seq
        AND cm.last_read_seq > COALESCE((SELECT tf.unread_hold FROM thread_follows tf
          WHERE tf.user_id = cm.user_id AND tf.root_id = m.thread_root_id), -1)) END)`;

/**
 * A reply `r` in thread follow `f`'s thread that its reader saw in the
 * channel, and has not marked unread since; see `UNREAD`.
 */
export const READ_IN_CHANNEL = `(r.broadcast = 1 AND EXISTS (
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
export const MENTIONS_ME =
  "(instr(m.text, ?) > 0 OR (c.type IN ('public', 'private') AND (instr(m.text, '<!channel>') > 0 OR instr(m.text, '<!here>') > 0 OR instr(m.text, '<!everyone>') > 0)) OR (m.reply_ping = 1 AND EXISTS (SELECT 1 FROM messages q WHERE q.id = m.reply_to_id AND q.user_id = cm.user_id)))";

/**
 * `MENTIONS_ME` read from `message_mentions` beside `mm` and `channels c`:
 * the rows naming this account, and the whole room in a room.
 */
export const NAMES_ME =
  "(mm.user_id = ? OR (mm.user_id = '!' AND c.type IN ('public', 'private')))";

/**
 * Beside `messages m` and `channel_members cm`: not written by someone the
 * member blocked (E12), whom Activity and the badges leave out.
 */
export const NOT_BLOCKED =
  "NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.user_id = cm.user_id AND ub.blocked_id = m.user_id)";
