import type {
  CallNotice,
  FileMeta,
  ForwardReference,
  ID,
  LinkPreview,
  Message,
  MessageAction,
  ReactionGroup,
  ReplyReference,
} from "@ownbase/protocol";
import { broadcastsIn, isRoom, replyExcerpt, userMentionsIn } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { shape, type RowOf } from "../core/rows.js";
import { IN_CHANNEL_TIMELINE } from "../core/sqlRules.js";
import { fileMetaRow, toFileMeta } from "../files/store.js";
import { orderedUlid, ulid } from "../ids.js";
import { previewLinks, type FetchedPreview } from "../linkPreview.js";
import type { Store } from "../store.js";
import { redactMessages, reforward, requote } from "./eventLog.js";

/** A `messages` row, as `SELECT *` (or `m.*`) reads it. */
export const messageRow = shape({
  id: "text",
  channel_id: "text",
  user_id: "text",
  text: "text",
  thread_root_id: "text?",
  broadcast: "number",
  nonce: "text?",
  seq: "number",
  created_at: "number",
  edited_at: "number?",
  deleted_at: "number?",
  actions: "text",
  reply_to_id: "text?",
  reply_ping: "number",
  forwarded_from_id: "text?",
  /** A note the server left about a call (E10). */
  call_kind: "text?",
});
export type MessageRow = RowOf<typeof messageRow.columns>;

const idRow = messageRow.pick("id");
const authorRow = messageRow.pick("user_id");
const sendKeyRow = shape({ messageId: "text", requestHash: "text?" });
const forwardSourceRow = messageRow
  .pick("id", "channel_id", "deleted_at", "forwarded_from_id", "text")
  .with({ file_count: "number" });
const quotedRow = messageRow
  .pick("id", "user_id", "text", "deleted_at")
  .with({ file_count: "number" });
const originalRow = messageRow
  .pick("id", "channel_id", "user_id", "text", "created_at", "deleted_at")
  .with({ channel_type: "text" });
const attachedFileRow = fileMetaRow.with({ message_id: "text" });
const reactionRow = shape({ message_id: "text", emoji: "text", user_id: "text" });

/** A `link_previews` row; `has_image` stands for the picture when only whether there is one is read. */
const previewRow = shape({
  id: "text",
  message_id: "text",
  url: "text",
  title: "text",
  description: "text",
  site_name: "text",
  image: "bytes?",
  image_type: "text?",
  image_width: "number?",
  image_height: "number?",
  removed: "number",
});
const shownPreviewRow = previewRow
  .pick("id", "message_id", "url", "title", "description", "site_name")
  .with({ image_width: "number?", image_height: "number?", has_image: "number" });
const previewOwnerRow = shape({ message_id: "text", channel_id: "text", user_id: "text" });
// Read only where `image IS NOT NULL`, and written with its type.
const previewImageRow = shape({ image: "bytes", image_type: "text" });

/**
 * Buttons come back out of one JSON column. A row written by a future version,
 * or corrupted somehow, costs its buttons rather than the whole message.
 */
function parseActions(raw: string): MessageAction[] {
  if (raw === "[]") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MessageAction[]) : [];
  } catch {
    return [];
  }
}

/** Messages: writing, editing and removing them, their link previews and reactions, and reading them back whole. */
export class MessageStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

  request(userId: ID, nonce: string): { messageId: ID; requestHash: string | null } | null {
    return (
      sendKeyRow.get(
        this.db.prepare(
          "SELECT message_id AS messageId, request_hash AS requestHash FROM message_requests WHERE user_id = ? AND nonce = ?",
        ),
        userId,
        nonce,
      ) ?? null
    );
  }

  /** Whether this key sent a message retention has since removed; see `purgeBefore`. */
  requestPurged(userId: ID, nonce: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM purged_message_requests WHERE user_id = ? AND nonce = ?")
      .get(userId, nonce);
  }

  pruneRequestsPurged(before: number): number {
    return Number(
      this.db.prepare("DELETE FROM purged_message_requests WHERE sent_at < ?").run(before).changes,
    );
  }

  recordRequest(userId: ID, nonce: string, messageId: ID, requestHash: string): void {
    this.db
      .prepare(
        "INSERT INTO message_requests (user_id, nonce, message_id, request_hash) VALUES (?, ?, ?, ?)",
      )
      .run(userId, nonce, messageId, requestHash);
  }

  create(input: {
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
    /**
     * When it was written and last edited somewhere else, for history brought
     * in from another app. Its id is made from that time, since messages are
     * read back in the order of their ids.
     */
    imported?: { createdAt: number; editedAt: number | null };
  }): Message {
    // Messages are read back in the order of their ids, so that order has to
    // be the order they were made in, within one millisecond too.
    const createdAt = input.imported?.createdAt ?? Date.now();
    const id = orderedUlid(createdAt);
    const original = input.replyToId && input.replyPing ? this.pingable(input.replyToId) : null;
    const pinged = original !== input.userId ? original : null;
    this.db
      .prepare(
        `INSERT INTO messages
           (id, channel_id, user_id, text, thread_root_id, broadcast, nonce, created_at, actions,
            reply_to_id, reply_ping, forwarded_from_id, call_kind, edited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.channelId,
        input.userId,
        input.text,
        input.threadRootId,
        input.threadRootId && input.broadcast ? 1 : 0,
        input.nonce,
        createdAt,
        JSON.stringify(input.actions ?? []),
        input.replyToId ?? null,
        pinged ? 1 : 0,
        input.forwardedFromId ?? null,
        input.call?.kind ?? null,
        input.imported?.editedAt ?? null,
      );
    this.indexMentions(id, input.channelId, input.text, { pinged });
    return this.get(id)!;
  }

  /**
   * The message a forward would pass on, as a send checks it: where it is,
   * whether it is deleted, and whether it is itself a forward with no words or
   * files of its own (`bare`), whose original is then passed on instead.
   */
  forwardSource(
    id: ID,
  ): { id: ID; channelId: ID; deleted: boolean; forwardedFromId: ID | null; bare: boolean } | null {
    const row = forwardSourceRow.get(
      this.db.prepare(
        `SELECT m.id, m.channel_id, m.deleted_at, m.forwarded_from_id, m.text,
           (SELECT COUNT(*) FROM files f WHERE f.message_id = m.id) AS file_count
         FROM messages m WHERE m.id = ?`,
      ),
      id,
    );
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
    const row = messageRow
      .pick("channel_id", "thread_root_id", "broadcast", "deleted_at")
      .get(
        this.db.prepare(
          "SELECT channel_id, thread_root_id, broadcast, deleted_at FROM messages WHERE id = ?",
        ),
        id,
      );
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
    const row = authorRow.get(
      this.db.prepare(
        `SELECT q.user_id FROM messages m JOIN messages q ON q.id = m.reply_to_id
         WHERE m.id = ? AND m.reply_ping = 1`,
      ),
      messageId,
    );
    return row?.user_id ?? null;
  }

  /** Who a reply to this message would notify: its author, while it is there. */
  private pingable(messageId: ID): ID | null {
    const row = authorRow.get(
      this.db.prepare("SELECT user_id FROM messages WHERE id = ? AND deleted_at IS NULL"),
      messageId,
    );
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
    const named: Set<string> = userMentionsIn(text);
    if (broadcastsIn(text).size > 0) named.add("!");
    const pinged = created ? created.pinged : this.replyPinged(messageId);
    if (pinged) named.add(pinged);
    if (named.size === 0) return;
    const insert = this.db.prepare(
      "INSERT INTO message_mentions (message_id, channel_id, user_id) VALUES (?, ?, ?)",
    );
    for (const userId of named) insert.run(messageId, channelId, userId);
  }

  /** Drops a message's buttons, for an app that has answered and moved on. */
  clearActions(id: ID): void {
    this.db.prepare("UPDATE messages SET actions = '[]' WHERE id = ?").run(id);
  }

  /**
   * Called after the event log assigns a seq to message.created. A reply
   * belongs to its thread, so only a message in the channel itself, or a
   * reply also sent there, moves the channel's newest seq and so its badge.
   */
  stampSeq(messageId: ID, channelId: ID, seq: number, inChannel = true): void {
    this.db.prepare("UPDATE messages SET seq = ? WHERE id = ?").run(seq, messageId);
    if (inChannel)
      this.db
        .prepare("UPDATE channels SET last_msg_seq = MAX(last_msg_seq, ?) WHERE id = ?")
        .run(seq, channelId);
  }

  get(id: ID): Message | null {
    const r = messageRow.get(
      this.db.prepare("SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL"),
      id,
    );
    if (!r) return null;
    return this.hydrate([r])[0]!;
  }

  /** Mention counts follow both the people the old words named and those the new ones do. */
  edit(id: ID, text: string): Message {
    const before = messageRow
      .pick("channel_id", "user_id", "text")
      .get(this.db.prepare("SELECT channel_id, user_id, text FROM messages WHERE id = ?"), id);
    const row = messageRow
      .pick("channel_id")
      .get(
        this.db.prepare(
          "UPDATE messages SET text = ?, edited_at = ? WHERE id = ? RETURNING channel_id",
        ),
        text,
        Date.now(),
        id,
      );
    if (row) this.indexMentions(id, row.channel_id, text);
    if (before)
      this.store.outbox.mentions([
        ...this.mentionedMemberIds(before.channel_id, before.text, before.user_id),
        ...this.mentionedMemberIds(before.channel_id, text, before.user_id),
      ]);
    // Previews of links the new words no longer have go with the old ones.
    this.prunePreviews(id, previewLinks(text));
    // Every earlier version of the words, wherever the log still holds it. An
    // edit is often how someone takes back what they wrote, and leaving the
    // first draft on disk would make the correction cosmetic. The caller emits
    // the new version after this returns, so nothing appended yet is the one
    // being kept. Replies quoting it hold a copy of their own.
    redactMessages(this.db, "(?)", id);
    const message = this.get(id)!;
    requote(this.db, [id], { text: replyExcerpt(text), fileCount: message.files.length });
    reforward(this.db, [id], { text });
    return message;
  }

  delete(id: ID): void {
    // Soft-delete, and blank the text so it drops out of the FTS index.
    this.db
      .prepare("UPDATE messages SET deleted_at = ?, text = '', actions = '[]' WHERE id = ?")
      .run(Date.now(), id);
    this.db.prepare("DELETE FROM reactions WHERE message_id = ?").run(id);
    this.db.prepare("DELETE FROM pins WHERE message_id = ?").run(id);
    this.db.prepare("DELETE FROM saved_items WHERE message_id = ?").run(id);
    this.db.prepare("DELETE FROM message_mentions WHERE message_id = ?").run(id);
    this.db.prepare("DELETE FROM link_previews WHERE message_id = ?").run(id);
    this.db.prepare("DELETE FROM polls WHERE message_id = ?").run(id);
    redactMessages(this.db, "(?)", id);
    requote(this.db, [id], null);
    reforward(this.db, [id], null);
  }

  /** The links a message has previews for or had one removed, with which. */
  previewRows(messageId: ID): { url: string; removed: boolean }[] {
    return previewRow
      .pick("url", "removed")
      .all(
        this.db.prepare(
          "SELECT url, removed FROM link_previews WHERE message_id = ? ORDER BY position",
        ),
        messageId,
      )
      .map((r) => ({ url: r.url, removed: r.removed === 1 }));
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
    const row = previewOwnerRow.get(
      this.db.prepare(
        `SELECT p.message_id, m.channel_id, m.user_id FROM link_previews p
         JOIN messages m ON m.id = p.message_id
         WHERE p.id = ? AND p.removed = 0 AND m.deleted_at IS NULL`,
      ),
      id,
    );
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
    const row = previewImageRow.get(
      this.db.prepare(
        "SELECT image, image_type FROM link_previews WHERE id = ? AND removed = 0 AND image IS NOT NULL",
      ),
      id,
    );
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
  purgeBefore(
    before: number,
    limits: { roots?: number; messages?: number } = {},
  ): { messages: number; fileIds: ID[]; roots: { id: ID; channelId: ID }[] } {
    const rootLimit = limits.roots ?? 2000;
    const messageBudget = limits.messages ?? 5000;
    const candidates = shape({ id: "text", channelId: "text", replies: "number" }).all(
      this.db.prepare(
        `SELECT m.id, m.channel_id AS channelId,
           (SELECT COUNT(*) FROM messages r WHERE r.thread_root_id = m.id) AS replies
         FROM messages m
         WHERE m.thread_root_id IS NULL AND m.created_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM messages r WHERE r.thread_root_id = m.id AND r.created_at >= ?
           )
         ORDER BY m.id LIMIT ?`,
      ),
      before,
      before,
      rootLimit,
    );
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

      const fileIds = idRow
        .all(this.db.prepare(`SELECT id FROM files WHERE message_id IN ${doomed}`))
        .map((r) => r.id);
      // Later replies quoting what goes stay, and say it is gone.
      const quoted = idRow
        .all(
          this.db.prepare(
            `SELECT DISTINCT reply_to_id AS id FROM messages
             WHERE reply_to_id IN ${doomed} AND id NOT IN ${doomed}`,
          ),
        )
        .map((r) => r.id);
      // So do later forwards of it.
      const forwarded = idRow
        .all(
          this.db.prepare(
            `SELECT DISTINCT forwarded_from_id AS id FROM messages
             WHERE forwarded_from_id IN ${doomed} AND id NOT IN ${doomed}`,
          ),
        )
        .map((r) => r.id);

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
      this.store.files.queueDeletions(fileIds);

      // The rows are gone; the log, and any app event still waiting to leave,
      // still hold what they said.
      redactMessages(this.db, doomed);
      requote(this.db, quoted, null);
      reforward(this.db, forwarded, null);
      return { messages, fileIds, roots: removed };
    } finally {
      this.db.exec("DELETE FROM temp.purge_messages");
    }
  }

  /** Newest-first page of top-level channel messages (or thread replies). */
  list(opts: { channelId: ID; before?: ID; limit: number; threadRootId?: ID }): Message[] {
    const before = opts.before ? [opts.before] : [];
    const rows = opts.threadRootId
      ? messageRow.all(
          this.db.prepare(
            `SELECT * FROM messages
             WHERE channel_id = ? AND thread_root_id = ? AND deleted_at IS NULL ${opts.before ? "AND id < ?" : ""}
             ORDER BY id DESC LIMIT ?`,
          ),
          opts.channelId,
          opts.threadRootId,
          ...before,
          opts.limit,
        )
      : messageRow.all(
          this.db.prepare(
            `SELECT * FROM messages
             WHERE channel_id = ? AND ${IN_CHANNEL_TIMELINE} AND deleted_at IS NULL ${opts.before ? "AND id < ?" : ""}
             ORDER BY id DESC LIMIT ?`,
          ),
          opts.channelId,
          ...before,
          opts.limit,
        );
    return this.hydrate(rows);
  }

  /**
   * The newest message each direct conversation this account is in shows,
   * for the list of direct messages to say who said what last. One per
   * conversation that has any, leaving out what someone blocked wrote; read
   * through the channel index, newest first, so it costs one step each.
   */
  latestDirect(userId: ID): Message[] {
    const rows = messageRow.all(
      this.db.prepare(
        `SELECT m.* FROM channel_members cm
         JOIN channels c ON c.id = cm.channel_id
         JOIN messages m ON m.id = (
           SELECT n.id FROM messages n
           WHERE n.channel_id = c.id AND (n.thread_root_id IS NULL OR n.broadcast = 1)
             AND n.deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM user_blocks ub
               WHERE ub.user_id = cm.user_id AND ub.blocked_id = n.user_id)
           ORDER BY n.id DESC LIMIT 1)
         WHERE cm.user_id = ? AND c.type IN ('dm', 'group_dm') AND c.archived = 0
         ORDER BY m.id DESC LIMIT 500`,
      ),
      userId,
    );
    return this.hydrate(rows);
  }

  /**
   * A window of messages centred on one message, for jumping to a search hit
   * or a pinned message. Returns newest-first like listMessages, plus whether
   * more exist on either side so the client knows it is not at the tail.
   */
  around(
    channelId: ID,
    messageId: ID,
    limit: number,
  ): { messages: Message[]; hasMoreOlder: boolean; hasMoreNewer: boolean } {
    const half = Math.max(1, Math.floor(limit / 2));

    // Ask for one extra on each side purely to detect whether more exist.
    const olderRows = messageRow.all(
      this.db.prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND ${IN_CHANNEL_TIMELINE} AND deleted_at IS NULL AND id < ?
         ORDER BY id DESC LIMIT ?`,
      ),
      channelId,
      messageId,
      half + 1,
    );
    const newerRows = messageRow.all(
      this.db.prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND ${IN_CHANNEL_TIMELINE} AND deleted_at IS NULL AND id > ?
         ORDER BY id ASC LIMIT ?`,
      ),
      channelId,
      messageId,
      half + 1,
    );
    const targetRow = messageRow.get(
      this.db.prepare(
        `SELECT * FROM messages
         WHERE id = ? AND channel_id = ? AND ${IN_CHANNEL_TIMELINE} AND deleted_at IS NULL`,
      ),
      messageId,
      channelId,
    );

    const hasMoreOlder = olderRows.length > half;
    const hasMoreNewer = newerRows.length > half;
    const older = olderRows.slice(0, half);
    const newer = newerRows.slice(0, half).reverse(); // newest-first

    const rows = [...newer, ...(targetRow ? [targetRow] : []), ...older];
    return { messages: this.hydrate(rows), hasMoreOlder, hasMoreNewer };
  }

  /**
   * The first message someone else wrote in a conversation's history after an
   * event seq: where `readerId`, who had read up to that seq, takes up reading
   * again. Their own messages are not news to them, as the New line skips
   * them. Null when nobody else has said anything there since.
   */
  firstAfterSeq(channelId: ID, seq: number, readerId: ID): ID | null {
    const row = idRow.get(
      this.db.prepare(
        `SELECT id FROM messages
         WHERE channel_id = ? AND ${IN_CHANNEL_TIMELINE} AND deleted_at IS NULL AND seq > ?
           AND user_id != ?
         ORDER BY id ASC LIMIT 1`,
      ),
      channelId,
      seq,
      readerId,
    );
    return row?.id ?? null;
  }

  /** Page forward from a message, for scrolling back down toward the tail. */
  after(channelId: ID, afterId: ID, limit: number): Message[] {
    const rows = messageRow.all(
      this.db.prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND ${IN_CHANNEL_TIMELINE} AND deleted_at IS NULL AND id > ?
         ORDER BY id ASC LIMIT ?`,
      ),
      channelId,
      afterId,
      limit,
    );
    // Callers expect newest-first.
    return this.hydrate(rows.reverse());
  }

  hydrate(rows: MessageRow[]): Message[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => "?").join(",");

    const reactionRows = reactionRow.all(
      this.db.prepare(
        `SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${ph}) ORDER BY created_at`,
      ),
      ...ids,
    );
    const reactionsByMsg = new Map<string, ReactionGroup[]>();
    for (const rr of reactionRows) {
      let groups = reactionsByMsg.get(rr.message_id);
      if (!groups) reactionsByMsg.set(rr.message_id, (groups = []));
      let g = groups.find((g) => g.emoji === rr.emoji);
      if (!g) groups.push((g = { emoji: rr.emoji, userIds: [] }));
      g.userIds.push(rr.user_id);
    }

    const replyRows = shape({ thread_root_id: "text", c: "number" }).all(
      this.db.prepare(
        `SELECT thread_root_id, COUNT(*) c FROM messages
         WHERE thread_root_id IN (${ph}) AND deleted_at IS NULL GROUP BY thread_root_id`,
      ),
      ...ids,
    );
    const replyCounts = new Map(replyRows.map((r) => [r.thread_root_id, r.c]));

    const pinRows = reactionRow
      .pick("message_id")
      .all(this.db.prepare(`SELECT message_id FROM pins WHERE message_id IN (${ph})`), ...ids);
    const pinned = new Set(pinRows.map((r) => r.message_id));

    const fileRows = attachedFileRow.all(
      this.db.prepare(
        `SELECT id, message_id, name, mime, size, width, height FROM files
         WHERE message_id IN (${ph}) ORDER BY created_at`,
      ),
      ...ids,
    );
    const filesByMsg = new Map<string, FileMeta[]>();
    for (const f of fileRows) {
      const meta = toFileMeta(f);
      const list = filesByMsg.get(f.message_id);
      if (list) list.push(meta);
      else filesByMsg.set(f.message_id, [meta]);
    }

    // What each reply answers, read as it is now: edited, deleted or gone.
    const quotedIds = [...new Set(rows.flatMap((r) => (r.reply_to_id ? [r.reply_to_id] : [])))];
    const quotes = new Map(
      quotedIds.length === 0
        ? []
        : quotedRow
            .all(
              this.db.prepare(
                `SELECT q.id, q.user_id, q.text, q.deleted_at,
                   (SELECT COUNT(*) FROM files f WHERE f.message_id = q.id) AS file_count
                 FROM messages q WHERE q.id IN (${quotedIds.map(() => "?").join(",")})`,
              ),
              ...quotedIds,
            )
            .map((q) => [q.id, q]),
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
        : originalRow
            .all(
              this.db.prepare(
                `SELECT m.id, m.channel_id, m.user_id, m.text, m.created_at, m.deleted_at,
                   c.type AS channel_type
                 FROM messages m JOIN channels c ON c.id = m.channel_id
                 WHERE m.id IN (${forwardedIds.map(() => "?").join(",")})`,
              ),
              ...forwardedIds,
            )
            .map((o) => [o.id, o]),
    );
    const originalFiles = new Map<string, FileMeta[]>();
    if (originals.size > 0) {
      const ids = [...originals.keys()];
      for (const f of attachedFileRow.all(
        this.db.prepare(
          `SELECT id, message_id, name, mime, size, width, height FROM files
           WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at`,
        ),
        ...ids,
      )) {
        const meta = toFileMeta(f);
        const list = originalFiles.get(f.message_id);
        if (list) list.push(meta);
        else originalFiles.set(f.message_id, [meta]);
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
      for (const p of shownPreviewRow.all(
        this.db.prepare(
          `SELECT id, message_id, url, title, description, site_name, image_width, image_height,
             image IS NOT NULL AS has_image
           FROM link_previews
           WHERE removed = 0 AND message_id IN (${live.map(() => "?").join(",")})
           ORDER BY message_id, position`,
        ),
        ...live,
      )) {
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

    const polls = this.store.polls.ofMessages(live);

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
      previews: previews.get(r.id) ?? [],
      ...(polls.has(r.id) ? { poll: polls.get(r.id)! } : {}),
      ...(r.call_kind === "missed" ? { call: { kind: "missed" as const } } : {}),
    }));
  }

  addReaction(messageId: ID, userId: ID, emoji: string, at = Date.now()): boolean {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(messageId, userId, emoji, at);
    return res.changes > 0;
  }

  removeReaction(messageId: ID, userId: ID, emoji: string): boolean {
    const res = this.db
      .prepare("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
      .run(messageId, userId, emoji);
    return res.changes > 0;
  }

  /**
   * Members of a channel this text mentions, so only they have to be told
   * their counts changed. Most text names nobody and costs no query; text
   * naming people checks just them, and only a room-wide mention in a room
   * reads every member (REV-06).
   */
  mentionedMemberIds(channelId: ID, text: string, exclude: ID): ID[] {
    const direct = userMentionsIn(text);
    const roomWideToken = broadcastsIn(text).size > 0;
    if (direct.size === 0 && !roomWideToken) return [];
    const channel = this.store.channels.get(channelId);
    if (!channel) return [];
    if (roomWideToken && isRoom(channel.type))
      return this.store.channels.memberIds(channelId).filter((id) => id !== exclude);
    return [...direct].filter(
      (id) => id !== exclude && this.store.channels.isMember(channelId, id),
    );
  }
}
