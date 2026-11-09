import { endpoints, type ID, type WorkspaceStatus } from "@ownbase/protocol";
import { createHash } from "node:crypto";
import { statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hashToken, newSessionToken } from "../auth.js";
import { CapabilityMap } from "../core/capabilities.js";
import { ConfigError } from "../config.js";
import type { ServerContext } from "../core/context.js";
import { bearerToken } from "../core/network.js";
import { DOWNLOAD_TOKEN_TTL_MS, type Files } from "../files/feature.js";
import { HttpError } from "../httpError.js";
import type { ServerOptions } from "../server.js";
import { backupWorkspace, separateDirectories } from "./backup.js";
import { BackupSchedule, type ScheduledBackups } from "./backupSchedule.js";
import { WorkspaceCopies } from "./workspaceCopy.js";

/** Room left beyond a copy, so making one never fills the disk the workspace writes to. */
const COPY_HEADROOM_BYTES = 64 * 1024 * 1024;

/**
 * The scheduled backups `opts` asks for, refused before the database opens
 * when they cannot work. None in an isolated copy, which would otherwise
 * write into, and prune, the original's backups.
 */
export async function scheduledBackupsOf(
  opts: Pick<ServerOptions, "dataDir" | "isolated" | "scheduledBackups">,
): Promise<ScheduledBackups | undefined> {
  const scheduled = opts.isolated ? undefined : opts.scheduledBackups;
  if (!scheduled) return undefined;
  if (opts.dataDir === ":memory:")
    throw new ConfigError("Scheduled backups need a workspace folder, not one in memory.");
  if (!Number.isSafeInteger(scheduled.everyMs) || scheduled.everyMs <= 0)
    throw new ConfigError("Scheduled backups need a time between them greater than zero.");
  if (!Number.isSafeInteger(scheduled.keep) || scheduled.keep < 1)
    throw new ConfigError("Scheduled backups need to keep at least one.");
  try {
    await separateDirectories(opts.dataDir, scheduled.dir);
  } catch {
    throw new ConfigError(
      `Backups must go outside the workspace folder, and the workspace must not be inside theirs: ${scheduled.dir}`,
    );
  }
  return scheduled;
}

/** Free space at `path`, or at the nearest folder above it that exists; null if unknown. */
const freeBytesAt = (path: string): number | null => {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    try {
      const disk = statfsSync(dir);
      return disk.bavail * disk.bsize;
    } catch {
      if (dirname(dir) === dir) return null;
    }
  }
};

const megabytes = (bytes: number) =>
  `${Math.ceil(bytes / (1024 * 1024)).toLocaleString("en-US")} MB`;

/**
 * Copies of the workspace: backups taken on a timer (P3), and the copy the
 * owner downloads (P4). Both take an ordinary backup with attachment
 * removals held.
 */
export function registerBackups(
  ctx: ServerContext,
  deps: { files: Files; scheduled: ScheduledBackups | undefined },
) {
  const { opts, store, settings, route } = ctx;
  const { files, scheduled } = deps;

  /** Set once the server is listening; null when scheduled backups are off. */
  let backups: BackupSchedule | null = null;
  /** The owner's downloadable copy; null for a workspace kept in memory. */
  let copies: WorkspaceCopies | null = null;

  /** Tickets to download the copy: like a file's, spent on first use and a minute long. */
  const copyTickets = new CapabilityMap<{
    copyId: string;
    userId: ID;
    sessionHash: string;
    expiresAt: number;
  }>(16);

  route(endpoints.workspaceCopy, async ({ reply }) => {
    reply.header("cache-control", "no-store");
    return { copy: copies?.state() ?? null };
  });

  route(endpoints.makeWorkspaceCopy, async ({ reply, user: me }) => {
    reply.header("cache-control", "no-store");
    if (!copies)
      throw new HttpError(409, "copies_unavailable", "A workspace kept in memory has no copy.");
    const current = copies.state();
    if (current?.state === "making") return { copy: current };
    // Checked first: a full disk stops every write, chat included.
    const needed = store.databaseBytes() + files.storage.usedBytes + COPY_HEADROOM_BYTES;
    const free = freeBytesAt(copies.root);
    if (free !== null && free < needed)
      throw new HttpError(
        507,
        "not_enough_space",
        `A copy needs about ${megabytes(needed)} free on the server, and it has ${megabytes(free)}.`,
      );
    const made = copies.make();
    if (!made)
      throw new HttpError(
        409,
        "copy_downloading",
        "The copy is being downloaded. Make a new one once that has finished.",
      );
    store.audit.record({
      actorId: me.id,
      action: "workspace.copy_made",
      targetType: "workspace",
      targetId: null,
    });
    return { copy: made };
  });

  route(endpoints.copyDownloadToken, async ({ req, reply, user: me }) => {
    const current = copies?.state();
    if (current?.state !== "ready")
      throw new HttpError(404, "no_copy", "There is no copy ready to download.");
    const { token, tokenHash } = newSessionToken();
    const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
    copyTickets.set(tokenHash, {
      copyId: current.id,
      userId: me.id,
      sessionHash: hashToken(bearerToken(req)!),
      expiresAt,
    });
    reply.header("cache-control", "no-store");
    return { token, expiresAt };
  });

  route(endpoints.copyFile, async ({ reply, params, query, user }) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const ticket = query.download;
    let ownerId: ID;
    if (!user) {
      if (!ticket || !/^[a-f0-9]{64}$/.test(ticket)) throw new HttpError(404, "no_copy");
      const hash = hashToken(ticket);
      const spent = copyTickets.get(hash);
      copyTickets.delete(hash);
      const owner = spent ? store.accounts.getSessionUser(spent.sessionHash) : null;
      if (
        !spent ||
        spent.copyId !== params.id ||
        !owner ||
        owner.id !== spent.userId ||
        owner.role !== "owner" ||
        store.accounts.mustChangePassword(owner.id)
      )
        throw new HttpError(404, "no_copy");
      ownerId = owner.id;
    } else {
      ownerId = user.id;
    }
    const zip = copies?.open(params.id);
    if (!zip) throw new HttpError(404, "no_copy", "That copy is gone. Make a new one.");
    store.audit.record({
      actorId: ownerId,
      action: "workspace.copy_downloaded",
      targetType: "workspace",
      targetId: null,
      details: { bytes: zip.length },
    });
    const day = new Date().toISOString().slice(0, 10);
    const name = `${settings.get("workspaceName")} ${day}.zip`;
    return reply
      .header("content-type", "application/zip")
      .header("x-content-type-options", "nosniff")
      .header("content-length", String(zip.length))
      .header(
        "content-disposition",
        `attachment; filename="workspace-${day}.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .send(zip.stream);
  });

  return {
    /** Starts the schedule and clears copies a previous run left; once the server is listening. */
    async start() {
      const takeBackup =
        opts.takeBackup ?? ((out: string) => backupWorkspace({ dataDir: opts.dataDir, out }));
      backups = scheduled
        ? new BackupSchedule({
            ...scheduled,
            run: files.holdingRemovals(scheduled.run ?? takeBackup),
            log: ctx.log,
          })
        : null;
      await backups?.start();
      if (opts.dataDir === ":memory:") return;
      copies = new WorkspaceCopies({
        root:
          opts.copiesDir ??
          (scheduled
            ? join(scheduled.dir, ".copies")
            : join(
                tmpdir(),
                "ownbase-copies",
                createHash("sha256").update(resolve(opts.dataDir)).digest("hex").slice(0, 16),
              )),
        take: files.holdingRemovals(takeBackup),
        log: ctx.log,
      });
      await copies.start().catch((err: unknown) => {
        ctx.log.error({ err }, "copies left from before could not be removed");
      });
    },
    status: () => backups?.status() ?? null,
    runNow: () => backups?.runNow() ?? Promise.resolve(),
    /** Scheduled backups for admin status: times and counts, never the folder or an error's text. */
    summary(): NonNullable<WorkspaceStatus["backups"]> {
      const status = backups?.status();
      if (!status) return { enabled: false };
      return {
        enabled: true,
        everyMs: status.everyMs,
        keep: status.keep,
        lastSuccessAt: status.lastSuccessAt,
        failures: status.failures,
        nextAt: status.nextAt,
        running: status.running,
        ...(status.offsite
          ? {
              offsite: {
                lastSuccessAt: status.offsite.lastSuccessAt,
                failures: status.offsite.failures,
              },
            }
          : {}),
      };
    },
    /** Before the drain: removals held for a backup go once it has ended. */
    stop: () => Promise.all([backups?.stop(), copies?.stop()]),
  };
}

export type Backups = ReturnType<typeof registerBackups>;
