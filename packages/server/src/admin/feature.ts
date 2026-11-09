import {
  endpoints,
  type ID,
  type ReportedMessage,
  type User,
  type WorkspaceStatus,
} from "@ownbase/protocol";
import { statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { registerAccounts } from "../accounts/feature.js";
import { hashPassword } from "../auth.js";
import type { Backups } from "../backups/feature.js";
import { checkedPicture, type ServerContext } from "../core/context.js";
import { SCHEMA_VERSION } from "../db.js";
import type { Files } from "../files/feature.js";
import { HttpError } from "../httpError.js";
import { secretToken } from "../ids.js";
import type { registerMessages } from "../messages/feature.js";
import { SERVER_VERSION } from "../version.js";
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
  const { opts, db, store, gateway, route, ration, mutate, network, requireUser } = ctx;
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

  route(endpoints.listAudit, async ({ query }) => {
    const entries = store.listAudit({ before: query.before, limit: query.limit + 1 });
    const page = entries.slice(0, query.limit);
    return { entries: page, nextCursor: entries.length > query.limit ? page.at(-1)!.id : null };
  });

  route(endpoints.listAllUsers, async () => {
    const lastSeen = store.people.lastSeenByUser();
    const twoStepIds = store.accounts.twoStepUserIds();
    return {
      users: store.people.list().map((u) => ({
        ...u,
        lastSeenAt: lastSeen[u.id] ?? null,
        // Who has two-step sign-in, for an admin who may reset it (E11).
        twoStep: twoStepIds.has(u.id),
      })),
    };
  });

  route(endpoints.updateUserAdmin, async ({ user: me, body, params }) => {
    const target = store.people.get(params.id);
    if (!target) throw new HttpError(404, "user_not_found");
    if (target.id === me.id) throw new HttpError(400, "cannot_change_self");
    if (target.role === "owner") throw new HttpError(403, "owner_is_protected");
    if (target.role === "admin" && me.role !== "owner") {
      throw new HttpError(403, "admins_are_equals", "Only the owner can change another admin.");
    }
    if (body.role !== undefined && target.isBot) {
      throw new HttpError(400, "bots_have_no_role");
    }
    // A guest becomes a member only by choosing a handle and password itself.
    if (target.role === "guest" && (body.role !== undefined || body.canInvite !== undefined)) {
      throw new HttpError(400, "guest_account", "A guest can create an account themselves.");
    }
    if (body.canInvite !== undefined) {
      if (target.isBot) throw new HttpError(400, "bots_cannot_invite");
      // An admin can always invite, so allowing or refusing it would be a
      // setting that does nothing — refused rather than silently stored.
      const resultingRole = body.role ?? target.role;
      if (resultingRole !== "member") {
        throw new HttpError(400, "admins_can_always_invite");
      }
    }

    return mutate((emit, afterCommit) => {
      const hadInvitePermission =
        body.canInvite !== undefined && store.people.invitePermission(target.id);
      const updated = store.people.update(target.id, {
        role: body.role,
        deactivated: body.deactivated,
        canInvite: body.canInvite,
      });
      // Only what actually changed: setting a role someone already has is not
      // an event anybody needs to account for.
      if (body.role !== undefined && body.role !== target.role) {
        store.recordAudit({
          actorId: me.id,
          action: "user.role_changed",
          targetType: "user",
          targetId: target.id,
          details: { from: target.role, to: body.role },
        });
      }
      if (body.canInvite !== undefined && body.canInvite !== hadInvitePermission) {
        store.recordAudit({
          actorId: me.id,
          action: body.canInvite
            ? "user.invite_permission_granted"
            : "user.invite_permission_removed",
          targetType: "user",
          targetId: target.id,
        });
      }
      if (body.deactivated !== undefined && body.deactivated !== target.deactivated) {
        store.recordAudit({
          actorId: me.id,
          action: body.deactivated ? "user.deactivated" : "user.reactivated",
          targetType: "user",
          targetId: target.id,
        });
      }

      if (body.deactivated === true) {
        // Revoking access has to reach what is already in their hands: every
        // session token, and every socket that authenticated with one.
        store.accounts.deleteSessionsFor(target.id);
        afterCommit(() => gateway.disconnectUser(target.id));
      }
      // Everyone sees the change, so a deactivated person drops out of the member
      // lists and the composer's autocomplete without a reload.
      emit({ type: "user.updated", user: updated });
      return { user: updated };
    });
  });

  /**
   * Whose password or two-step sign-in an admin may reset (E11 shares them):
   * not their own, an app's or a guest's; never the owner's; another admin's
   * only as the owner.
   */
  const resettable = (me: User, targetId: ID): { me: User; target: User } => {
    const target = store.people.get(targetId);
    if (!target) throw new HttpError(404, "user_not_found");
    if (target.id === me.id) throw new HttpError(400, "cannot_reset_self");
    if (target.isBot) throw new HttpError(400, "bots_have_no_password");
    if (target.role === "guest") throw new HttpError(400, "guest_account");
    if (target.role === "owner") throw new HttpError(403, "owner_is_protected");
    if (target.role === "admin" && me.role !== "owner") {
      throw new HttpError(
        403,
        "admins_are_equals",
        "Only the owner can reset another admin's password.",
      );
    }
    return { me, target };
  };

  route(endpoints.resetPassword, async ({ req, params }) => {
    // Checked again after hashing, which yields.
    const authorize = () => resettable(requireUser(req), params.id);
    authorize();
    const temporaryPassword = secretToken().slice(0, 16);
    const credentials = await accounts.hashing(() => hashPassword(temporaryPassword));
    const { me: actor, target } = authorize();
    const revokedSessions = store.transaction(() => {
      store.accounts.setPassword(target.id, credentials.hash, credentials.salt, true);
      const revoked = store.accounts.revokeSessions(target.id);
      store.recordAudit({
        actorId: actor.id,
        action: "user.password_reset",
        targetType: "user",
        targetId: target.id,
        details: { sessionsEnded: revoked.length },
      });
      return revoked;
    });
    for (const tokenHash of revokedSessions) {
      gateway.disconnectSession(tokenHash);
    }
    return { temporaryPassword };
  });

  route(endpoints.resetTwoStep, async ({ user, params }) => {
    const { me: actor, target } = resettable(user, params.id);
    store.transaction(() => {
      if (!store.accounts.disableTwoStep(target.id))
        throw new HttpError(409, "two_step_off", "Their two-step sign-in is already off.");
      store.recordAudit({
        actorId: actor.id,
        action: "user.two_step_reset",
        targetType: "user",
        targetId: target.id,
        details: {},
      });
    });
    return { ok: true };
  });

  route(endpoints.listReports, async () => {
    const reports: ReportedMessage[] = [];
    for (const open of store.people.openReports()) {
      const channel = store.channels.get(open.channelId);
      if (!channel) continue;
      reports.push({ ...open, message: store.messages.get(open.messageId), channel });
    }
    return { reports };
  });

  route(endpoints.resolveReport, async ({ user: me, body, params }) => {
    const { action } = body;
    const open = store.people.openReports().find((held) => held.messageId === params.id);
    if (!open) throw new HttpError(404, "report_not_found");
    const author = store.people.get(open.authorId);
    if (action === "deactivate" && author) {
      if (author.id === me.id) throw new HttpError(400, "cannot_change_self");
      if (author.role === "owner") throw new HttpError(403, "owner_is_protected");
      if (author.role === "admin" && me.role !== "owner") {
        throw new HttpError(403, "admins_are_equals", "Only the owner can change another admin.");
      }
    }
    mutate((emit, afterCommit) => {
      const message = store.messages.get(open.messageId);
      if (action !== "dismiss" && message) messages.removeMessageWithin(message, emit);
      if (action === "deactivate" && author && !author.deactivated) {
        const updated = store.people.update(author.id, { deactivated: true });
        store.recordAudit({
          actorId: me.id,
          action: "user.deactivated",
          targetType: "user",
          targetId: author.id,
        });
        store.accounts.deleteSessionsFor(author.id);
        afterCommit(() => gateway.disconnectUser(author.id));
        emit({ type: "user.updated", user: updated });
      }
      const reports = store.people.resolveReports(open.messageId, me.id, action);
      store.recordAudit({
        actorId: me.id,
        action: "report.resolved",
        targetType: "user",
        targetId: open.authorId,
        details: { resolution: action, reports },
      });
    });
    await files.flushFileDeletions();
    return { ok: true };
  });

  route(endpoints.transferOwnership, async ({ user: me, params }) => {
    const target = store.people.get(params.id);
    if (!target) throw new HttpError(404, "user_not_found");
    if (target.id === me.id) throw new HttpError(400, "already_owner");
    if (target.isBot || target.deactivated || target.role === "guest")
      throw new HttpError(400, "invalid_owner");
    return mutate((emit) => {
      const newOwner = store.people.update(target.id, { role: "owner" });
      const formerOwner = store.people.update(me.id, { role: "admin" });
      store.recordAudit({
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
