import type { FileKind, FileMeta, ID, SharedFile } from "@ownbase/protocol";
import { FILE_KIND_TYPES, FILE_TYPE_MATCH } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { shape, type RowOf } from "../core/rows.js";
import { ulid } from "../ids.js";
import type { Store } from "../store.js";

export const fileRow = shape({
  id: "text",
  channel_id: "text",
  user_id: "text",
  message_id: "text?",
  name: "text",
  mime: "text",
  size: "number",
  width: "number?",
  height: "number?",
  created_at: "number",
});

/** The columns a file's `FileMeta` is read from. */
export const fileMetaRow = fileRow.pick("id", "name", "mime", "size", "width", "height");

export function toFileMeta(r: RowOf<typeof fileMetaRow.columns>): FileMeta {
  return { id: r.id, name: r.name, mime: r.mime, size: r.size, width: r.width, height: r.height };
}

const sharedFileRow = fileMetaRow.with({
  message_id: "text",
  channel_id: "text",
  thread_root_id: "text?",
  user_id: "text",
  created_at: "number",
});
const idRow = fileRow.pick("id");
const fileIdRow = shape({ file_id: "text" });
const deletionCountsRow = shape({
  waiting: "number",
  retrying: "number",
  rejected: "number",
  oldest: "number?",
});
const ticketRow = shape({
  file_id: "text",
  user_id: "text",
  session_hash: "text",
  expires_at: "number",
});

/** Attachments: their rows, their download tickets, and the queue that removes their blobs. */
export class FileStore {
  private removalsQueued = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

  create(input: {
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

  get(id: ID): (FileMeta & { channelId: ID; userId: ID }) | null {
    const r = fileRow.get(this.db.prepare("SELECT * FROM files WHERE id = ?"), id);
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
  listShared(
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
    if (this.store.people.isGuest(userId)) where.push("c.type = 'public'");
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
    const rows = sharedFileRow.all(
      this.db.prepare(
        `SELECT f.id, f.name, f.mime, f.size, f.width, f.height, f.message_id,
                m.channel_id, m.thread_root_id, m.user_id, m.created_at
         FROM files f
         CROSS JOIN messages m ON m.id = f.message_id
         CROSS JOIN channels c ON c.id = m.channel_id
         WHERE f.message_id IS NOT NULL AND m.deleted_at IS NULL AND ${where.join(" AND ")}
         ORDER BY f.message_id DESC, f.id DESC LIMIT ?`,
      ),
      ...params,
      query.limit + 1,
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      files: page.map((r) => ({
        file: toFileMeta(r),
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
  attach(
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
  heldBySchedule(fileIds: ID[], except: ID | null = null): boolean {
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
  abandonedIds(olderThan: number): ID[] | null {
    const spokenFor = new Set<ID>();
    for (const row of shape({ file_ids: "text" }).all(
      this.db.prepare("SELECT file_ids FROM scheduled_messages"),
    )) {
      let ids: unknown;
      try {
        ids = JSON.parse(row.file_ids);
      } catch {
        return null;
      }
      if (!Array.isArray(ids)) return null;
      for (const id of ids) spokenFor.add(String(id));
    }
    for (const row of fileIdRow.all(this.db.prepare("SELECT file_id FROM scheduled_files")))
      spokenFor.add(row.file_id);
    const candidates = idRow.all(
      this.db.prepare("SELECT id FROM files WHERE message_id IS NULL AND created_at < ?"),
      olderThan,
    );
    return candidates.map((row) => row.id).filter((id) => !spokenFor.has(id));
  }

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
    this.store.transaction(() => {
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
    const row = ticketRow.get(
      this.db.prepare(
        "DELETE FROM download_tokens WHERE token_hash = ? RETURNING file_id, user_id, session_hash, expires_at",
      ),
      tokenHash,
    );
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
  unknownIds(blobIds: ID[]): ID[] {
    if (blobIds.length === 0) return [];
    const known = new Set<string>();
    // Chunked: SQLite's variable limit is not large enough for a busy workspace.
    for (let i = 0; i < blobIds.length; i += 500) {
      const batch = blobIds.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = idRow.all(
        this.db.prepare(`SELECT id FROM files WHERE id IN (${placeholders})`),
        ...batch,
      );
      for (const row of rows) known.add(row.id);
    }
    return blobIds.filter((id) => !known.has(id));
  }

  /** File ids belonging to a message — used to delete blobs when the message goes. */
  idsForMessage(messageId: ID): ID[] {
    const rows = idRow.all(this.db.prepare("SELECT id FROM files WHERE message_id = ?"), messageId);
    return rows.map((r) => r.id);
  }

  delete(fileIds: ID[]): void {
    const stmt = this.db.prepare("DELETE FROM files WHERE id = ?");
    for (const id of fileIds) stmt.run(id);
  }

  /** Queues these files' blobs for removal, in the transaction that removed their rows. */
  queueDeletions(fileIds: ID[]): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO pending_file_deletions (file_id, queued_at) VALUES (?, ?)",
    );
    const now = Date.now();
    for (const id of fileIds) stmt.run(id, now);
    if (fileIds.length > 0) this.removalsQueued = true;
  }

  /** Whether removals were queued since this was last asked. */
  takeRemovalsQueued(): boolean {
    const queued = this.removalsQueued;
    this.removalsQueued = false;
    return queued;
  }

  /** Every removal still to do, set-aside ones included, oldest first. */
  pendingDeletions(): ID[] {
    return fileIdRow
      .all(
        this.db.prepare("SELECT file_id FROM pending_file_deletions ORDER BY queued_at, file_id"),
      )
      .map((row) => row.file_id);
  }

  /**
   * Removals due by `now`, in a stable order, at most `limit` (REV-02). One
   * that failed comes back only when its wait is over, so failures cannot
   * fill every page ahead of a removal that would succeed.
   */
  dueDeletions(now: number, limit: number): ID[] {
    return fileIdRow
      .all(
        this.db.prepare(
          `SELECT file_id FROM pending_file_deletions
           WHERE rejected = 0 AND next_attempt_at <= ?
           ORDER BY next_attempt_at, file_id LIMIT ?`,
        ),
        now,
        limit,
      )
      .map((row) => row.file_id);
  }

  completeDeletion(fileId: ID): void {
    this.db.prepare("DELETE FROM pending_file_deletions WHERE file_id = ?").run(fileId);
  }

  /** Waits longer after each failure: a minute, five, thirty, then two hours. */
  static readonly DELETION_RETRY_MS = [60_000, 300_000, 1_800_000, 7_200_000];

  /** A removal that failed; it is tried again later, and the rest go on. */
  deferDeletion(fileId: ID, now: number): void {
    const row = shape({ attempts: "number" }).get(
      this.db.prepare("SELECT attempts FROM pending_file_deletions WHERE file_id = ?"),
      fileId,
    );
    if (!row) return;
    const waits = FileStore.DELETION_RETRY_MS;
    const wait = waits[Math.min(row.attempts, waits.length - 1)]!;
    this.db
      .prepare(
        "UPDATE pending_file_deletions SET attempts = attempts + 1, next_attempt_at = ? WHERE file_id = ?",
      )
      .run(now + wait, fileId);
  }

  /** A removal that can never succeed: set aside, never tried again, still counted. */
  rejectDeletion(fileId: ID): void {
    this.db.prepare("UPDATE pending_file_deletions SET rejected = 1 WHERE file_id = ?").run(fileId);
  }

  /** How attachment removal stands, in counts and times only. */
  deletionCounts(): {
    waiting: number;
    retrying: number;
    rejected: number;
    oldestQueuedAt: number | null;
  } {
    const row = deletionCountsRow.get(
      this.db.prepare(
        `SELECT COUNT(*) FILTER (WHERE rejected = 0 AND attempts = 0) AS waiting,
                COUNT(*) FILTER (WHERE rejected = 0 AND attempts > 0) AS retrying,
                COUNT(*) FILTER (WHERE rejected = 1) AS rejected,
                MIN(queued_at) FILTER (WHERE rejected = 0) AS oldest
         FROM pending_file_deletions`,
      ),
    )!;
    return {
      waiting: row.waiting,
      retrying: row.retrying,
      rejected: row.rejected,
      oldestQueuedAt: row.oldest,
    };
  }

  /** True when every id is one of this user's own unattached uploads in this channel. */
  unattached(fileIds: ID[], channelId: ID, userId: ID): boolean {
    const stmt = this.db.prepare(
      "SELECT 1 FROM files WHERE id = ? AND user_id = ? AND channel_id = ? AND message_id IS NULL",
    );
    return fileIds.every((id) => stmt.get(id, userId, channelId) !== undefined);
  }
}
