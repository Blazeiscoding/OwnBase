import { endpoints, type WorkspaceStatus } from "@ownbase/protocol";
import { statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { registerAccounts } from "../accounts/feature.js";
import type { Backups } from "../backups/feature.js";
import { checkedPicture, type ServerContext } from "../core/context.js";
import { SCHEMA_VERSION } from "../db.js";
import type { Files } from "../files/feature.js";
import { HttpError } from "../httpError.js";
import type { registerMessages } from "../messages/feature.js";
import { SERVER_VERSION } from "../version.js";
import { registerMemberAdmin } from "./members.js";
import type { Workspace } from "./workspace.js";

/** A file's size, or 0 where there is none (a database in memory, no log yet). */
const sizeOf = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

const toMs = (ns: number) => Math.round(ns / 1e5) / 10;

/**
 * Running the workspace: its settings, its people's roles and accounts,
 * reported messages, the audit log, and its operational status (OPS-10).
 */
export function registerAdmin(
  ctx: ServerContext,
  deps: {
    instanceId: string;
    workspace: Workspace;
    accounts: ReturnType<typeof registerAccounts>;
    messages: ReturnType<typeof registerMessages>;
    files: Files;
    backups: Backups;
  },
) {
  const { opts, db, store, gateway, route, ration, mutate, network } = ctx;
  const { instanceId, workspace, accounts, messages, files, backups } = deps;
  const extensions = opts.extensions ?? [];

  route(endpoints.health, async ({ reply }) => {
    db.prepare("SELECT 1").get();
    reply.header("Cache-Control", "no-store");
    return { status: "ok", instanceId };
  });

  route(endpoints.workspaceIcon, async ({ req, reply, query }) => {
    ration("publicByAddress", network.callerAddress(req));
    const current = workspace.icon();
    if (!current) {
      reply.header("cache-control", "no-store");
      throw new HttpError(404, "no_icon", "This workspace has no icon.");
    }
    const etag = `"${current.version}"`;
    reply
      .header("content-type", current.type)
      .header("x-content-type-options", "nosniff")
      .header("etag", etag)
      .header(
        "cache-control",
        query.v === current.version ? "public, max-age=31536000, immutable" : "no-cache",
      );
    if (req.headers["if-none-match"] === etag) return reply.status(304).send();
    return reply.header("content-length", String(current.bytes.length)).send(current.bytes);
  });

  const startedAt = Date.now();
  // How late the event loop runs, kept for the last full minute, so a slow
  // stretch shows without one bad second from an hour ago staying forever.
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  let lastMinuteDelay: WorkspaceStatus["eventLoopDelayMs"] = null;
  const loopDelayTimer = setInterval(() => {
    lastMinuteDelay = {
      p50: toMs(loopDelay.percentile(50)),
      p99: toMs(loopDelay.percentile(99)),
      max: toMs(loopDelay.max),
    };
    loopDelay.reset();
  }, 60_000);
  loopDelayTimer.unref();
  ctx.lifecycle.onClose(() => {
    clearInterval(loopDelayTimer);
    loopDelay.disable();
  });

  route(endpoints.workspaceStatus, async ({ reply }) => {
    reply.header("Cache-Control", "no-store");
    const inMemory = opts.dataDir === ":memory:";
    let diskFreeBytes: number | null = null;
    if (!inMemory) {
      try {
        const disk = statfsSync(opts.dataDir);
        diskFreeBytes = disk.bavail * disk.bsize;
      } catch {
        // Not every platform or mount answers; saying so beats a guess.
      }
    }
    return {
      serverVersion: SERVER_VERSION,
      schemaVersion: SCHEMA_VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      database: {
        bytes: store.databaseBytes(),
        walBytes: inMemory ? 0 : sizeOf(join(opts.dataDir, "workspace.db-wal")),
      },
      attachments: {
        bytes: files.storage.usedBytes,
        limitBytes: files.storage.limitBytes,
        removal: store.files.deletionCounts(),
      },
      diskFreeBytes,
      deliveries: store.deliveryCounts(),
      scheduled: store.scheduled.counts(),
      retention: {
        enabled: messages.retentionOn,
        lastSuccessAt: messages.retention.lastSuccessAt,
        failures: messages.retention.failures,
      },
      backups: backups.summary(),
      connections: { sockets: gateway.socketCount(), people: gateway.onlineUserIds().length },
      eventLoopDelayMs: lastMinuteDelay,
      backgroundFailures: ctx.background.failures().map(([queue, failing]) => ({
        queue,
        ...failing,
      })),
      ...(extensions.length > 0
        ? {
            extensions: extensions.flatMap((extension) =>
              extension.status ? [extension.status()] : [],
            ),
          }
        : {}),
    };
  });

  registerMemberAdmin(ctx, { accounts, messages, files });

  route(endpoints.transferOwnership, async ({ user: me, params }) => {
    const target = store.people.get(params.id);
    if (!target) throw new HttpError(404, "user_not_found");
    if (target.id === me.id) throw new HttpError(400, "already_owner");
    if (target.isBot || target.deactivated || target.role === "guest")
      throw new HttpError(400, "invalid_owner");
    return mutate((emit) => {
      const newOwner = store.people.update(target.id, { role: "owner" });
      const formerOwner = store.people.update(me.id, { role: "admin" });
      store.audit.record({
        actorId: me.id,
        action: "workspace.ownership_transferred",
        targetType: "user",
        targetId: target.id,
        details: { previousOwner: me.id },
      });
      emit({ type: "user.updated", user: newOwner });
      emit({ type: "user.updated", user: formerOwner });
      return { owner: newOwner, previousOwner: formerOwner };
    });
  });

  route(endpoints.renameWorkspace, async ({ user: me, body }) => {
    return { workspaceName: workspace.rename(body.name, me.id) };
  });

  route(endpoints.setAccessPolicy, async ({ user: me, body }) => {
    workspace.changeAccessPolicy(body.accessPolicy, me.id);
    return { accessPolicy: workspace.accessPolicy() };
  });

  route(endpoints.setLinkPreviews, async ({ user: me, body }) => {
    workspace.setLinkPreviews(body.enabled, me.id);
    return { enabled: ctx.settings.get("linkPreviews") };
  });

  route(endpoints.setWorkspaceIcon, async ({ req, user: me, body }) => {
    const picture = checkedPicture(req, body);
    workspace.changeIcon(picture, me.id);
    return { iconVersion: picture.version };
  });

  route(endpoints.removeWorkspaceIcon, async ({ user: me }) => {
    workspace.changeIcon(null, me.id);
    return { iconVersion: null };
  });

  route(endpoints.extensionSettings, async ({ reply }) => {
    reply.header("cache-control", "no-store");
    return { panels: extensions.flatMap((extension) => extension.settingsPanels?.() ?? []) };
  });
}
