import { endpoints } from "@ownbase/protocol";
import { createWriteStream, mkdirSync } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BackupManifest } from "../backups/backup.js";
import { requireChannelAccess, type ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";
import { ulid } from "../ids.js";
import { imageSize } from "../imageSize.js";
import { StorageBudget } from "../storageBudget.js";

/** Upload size limit when the host sets none: 100 MB. */
export const maxFileSizeOf = (opts: { maxFileSize?: number }) =>
  opts.maxFileSize ?? 100 * 1024 * 1024;

/** Attachments: uploading, downloading and listing them, and removing their blobs once nothing needs them. */
export function registerFiles(ctx: ServerContext) {
  const { opts, app, store, route, requireUser, ticketFor, ration, background, lifecycle } = ctx;
  const maxFileSize = maxFileSizeOf(opts);

  // Uploads live beside the database so one folder is the whole workspace.
  const filesDir = opts.dataDir === ":memory:" ? null : join(opts.dataDir, "files");
  if (filesDir) mkdirSync(filesDir, { recursive: true });
  const blobPath = (fileId: string) => join(filesDir!, fileId);
  const storage = new StorageBudget(filesDir, opts.maxStorageBytes || null);
  const abandonedUploadTtlMs = opts.abandonedUploadTtlMs ?? 24 * 3600_000;

  /** Removals taken per turn; a full page means more may be due, taken on the next turn. */
  const FILE_CLEANUP_PAGE = 100;
  let fileCleanup: Promise<void> | null = null;
  /**
   * While a backup copies attachments, scheduled or for the owner to
   * download, none is removed, so a blob its snapshot names is still there
   * when the copy reaches it. Removals wait in their queue and go when the
   * last copy running ends.
   */
  let backupsCopying = 0;
  /**
   * Removes the blobs of committed deletions due by `now`, a page at a time
   * (REV-02). One that fails waits longer each time while the rest go on, so
   * a few that cannot be removed never hold back the many that can, and a
   * full page is followed by the next on a later turn rather than fifteen
   * seconds on. A name this server never gives a file is set aside for good,
   * still counted. Storage stays counted until a blob is actually gone.
   */
  const flushFileDeletions = (now = Date.now()): Promise<void> => {
    if (fileCleanup) return fileCleanup;
    if (backupsCopying > 0) return Promise.resolve();
    let more = false;
    fileCleanup = (async () => {
      const due = store.files.dueDeletions(now, FILE_CLEANUP_PAGE);
      more = due.length === FILE_CLEANUP_PAGE;
      for (const id of due) {
        if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
          app.log.error({ fileId: id }, "invalid attachment cleanup id; set aside");
          store.files.rejectDeletion(id);
          continue;
        }
        try {
          if (filesDir) await unlink(blobPath(id));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            app.log.warn({ fileId: id, err }, "attachment cleanup deferred");
            store.files.deferDeletion(id, Date.now());
            continue;
          }
        }
        store.files.completeDeletion(id);
        storage.release(id);
      }
    })()
      .catch((err) => {
        more = false;
        app.log.error({ err }, "attachment cleanup failed; pending work retained");
      })
      .finally(() => {
        fileCleanup = null;
        if (more) nextCleanupPage(now);
      });
    return fileCleanup;
  };
  const nextCleanupPage = lifecycle.laterTurn((after: number) =>
    background.run("attachment cleanup", () => flushFileDeletions(Math.max(after, Date.now()))),
  );

  /**
   * Frees uploads nobody ever sent. Without this an attachment chosen and then
   * thought better of holds its bytes for the life of the workspace, which the
   * storage cap turns from untidy into a workspace that slowly fills up.
   */
  const expireAbandonedUploads = (): number => {
    const ids = store.files.abandonedIds(Date.now() - abandonedUploadTtlMs);
    if (ids.length === 0) return 0;
    store.transaction(() => {
      store.files.delete(ids);
      store.files.queueDeletions(ids);
    });
    app.log.info({ count: ids.length }, "expired abandoned uploads");
    return ids.length;
  };

  /**
   * Blobs on disk that no `files` row accounts for. A process killed between
   * writing the bytes and recording them leaves one behind: it counts against
   * the workspace cap, and without this nothing would ever ask to delete it.
   *
   * Safe only before uploads can start, since a blob being written right now
   * has no row yet either. It runs once, at startup, for that reason.
   */
  const reconcileOrphanedBlobs = (): number => {
    if (!filesDir) return 0;
    const orphans = store.files.unknownIds(storage.storedIds());
    if (orphans.length === 0) return 0;
    // Through the usual queue, so a blob that will not delete is retried rather
    // than lost track of, and its bytes are released when it really goes.
    store.files.queueDeletions(orphans);
    app.log.warn({ count: orphans.length }, "queued orphaned attachment blobs");
    return orphans.length;
  };

  route(endpoints.storageUsage, async () => {
    return {
      usedBytes: storage.usedBytes,
      limitBytes: storage.limitBytes,
      maxFileBytes: maxFileSize,
      availableBytes:
        storage.limitBytes === null ? null : Math.max(0, storage.limitBytes - storage.usedBytes),
    };
  });

  route(endpoints.uploadFile, async ({ req, user: me, params }) => {
    ration("upload", me.id);
    const channel = requireChannelAccess(store, params.id, me);
    if (!filesDir) throw new HttpError(501, "uploads_disabled");

    const part = await req.file();
    if (!part) throw new HttpError(400, "no_file");

    const id = ulid();
    let size = 0;
    let headerSize = 0;
    const header: Buffer[] = [];
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        if (!storage.reserve(id, chunk.length)) {
          done(
            new HttpError(
              507,
              "storage_quota_exceeded",
              "The workspace has no room left for files. Ask whoever hosts it to free space or raise the limit.",
            ),
          );
          return;
        }
        size += chunk.length;
        if (headerSize < 64 * 1024) {
          const part = Buffer.from(chunk.subarray(0, 64 * 1024 - headerSize));
          header.push(part);
          headerSize += part.length;
        }
        done(null, chunk);
      },
    });
    try {
      await pipeline(part.file, meter, createWriteStream(blobPath(id), { flags: "wx" }));
      if (part.file.truncated)
        throw new HttpError(
          413,
          "file_too_large",
          `Files must be smaller than ${maxFileSize} bytes.`,
        );
      // Upload streaming yields; access may have been revoked while bytes arrived.
      requireUser(req);
      requireChannelAccess(store, channel.id, me);
      const dims = part.mimetype.startsWith("image/") ? imageSize(Buffer.concat(header)) : null;
      const file = store.files.create({
        id,
        channelId: channel.id,
        userId: me.id,
        name: part.filename.slice(0, 255),
        mime: part.mimetype,
        size,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
      });
      return { file };
    } catch (err) {
      try {
        await unlink(blobPath(id));
        storage.release(id);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code === "ENOENT") storage.release(id);
        else store.files.queueDeletions([id]);
      }
      throw err;
    }
  });

  route(endpoints.listSharedFiles, async ({ user: me, query }) => {
    return store.files.listShared(me.id, query);
  });

  route(endpoints.fileDownloadToken, async ({ req, reply, user: me, params }) => {
    const file = store.files.get(params.id);
    if (!file || !filesDir || !store.canAccess(file.channelId, me.id)) {
      throw new HttpError(404, "file_not_found");
    }
    try {
      const stored = await stat(blobPath(file.id));
      if (!stored.isFile() || stored.size !== file.size) throw new Error("file unavailable");
    } catch {
      throw new HttpError(404, "file_not_found");
    }
    // Disk access yields; issue nothing if the session or file disappeared.
    requireUser(req);
    if (!store.files.get(file.id) || !store.canAccess(file.channelId, me.id)) {
      throw new HttpError(404, "file_not_found");
    }
    reply.header("cache-control", "no-store");
    return ticketFor(req, me, endpoints.file, { id: file.id });
  });

  route(endpoints.file, async ({ req, reply, params, query, user }) => {
    const file = store.files.get(params.id);
    if (!file || !filesDir || !store.canAccess(file.channelId, user.id)) {
      throw new HttpError(404, "file_not_found");
    }
    let body;
    let handle;
    try {
      handle = await open(blobPath(file.id), "r");
      const stored = await handle.stat();
      if (!stored.isFile() || stored.size !== file.size) throw new Error("file unavailable");
      // Disk access yields; sign-out, deletion or private-room departure may have happened.
      const current = requireUser(req);
      if (!store.files.get(file.id) || !store.canAccess(file.channelId, current.id))
        throw new Error("file access changed");
      body = handle.createReadStream();
    } catch {
      await handle?.close();
      throw new HttpError(404, "file_not_found");
    }
    const encodedName = encodeURIComponent(file.name);
    // A member can lose access after a download. A fresh request must reach
    // the server so the current session and channel permissions are checked.
    return reply
      .header("content-type", file.mime)
      .header("x-content-type-options", "nosniff")
      .header("content-length", String(file.size))
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header("accept-ranges", "none")
      .header(
        "content-disposition",
        `${query.download === undefined ? "inline" : "attachment"}; filename*=UTF-8''${encodedName}`,
      )
      .send(body);
  });

  lifecycle.onDrain(() => flushFileDeletions());
  // A change that removed files, such as a message with attachments, has its blobs removed once it commits.
  ctx.onPublished(() => {
    if (store.files.takeRemovalsQueued()) background.run("attachment cleanup", flushFileDeletions);
  });

  // Each queue on its own, so one failing neither stops the server starting nor skips the others.
  lifecycle.onStart(() => {
    background.run("orphaned attachments", reconcileOrphanedBlobs);
    background.run("abandoned uploads", expireAbandonedUploads);
    background.run("attachment cleanup", flushFileDeletions);
    lifecycle.every(15_000, () => background.run("attachment cleanup", flushFileDeletions));
  });
  lifecycle.hourly(() => {
    background.maintain("abandoned uploads", () => {
      if (expireAbandonedUploads() > 0) void flushFileDeletions();
    });
  });

  return {
    storage,
    flushFileDeletions,
    expireAbandonedUploads,
    /**
     * Takes a backup with removals held. A page of removals already under way
     * is left to finish: its rows went in the transaction that queued them, so
     * the snapshot taken after this cannot name its blobs.
     */
    holdingRemovals:
      (take: (out: string, signal: AbortSignal) => Promise<BackupManifest>) =>
      async (out: string, signal: AbortSignal) => {
        backupsCopying++;
        try {
          return await take(out, signal);
        } finally {
          backupsCopying--;
          background.run("attachment cleanup", flushFileDeletions);
        }
      },
  };
}

export type Files = ReturnType<typeof registerFiles>;
