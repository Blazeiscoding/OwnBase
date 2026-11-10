import { endpoints, type ID, type ReportedMessage, type User } from "@ownbase/protocol";
import type { registerAccounts } from "../accounts/feature.js";
import { hashPassword } from "../auth.js";
import type { ServerContext } from "../core/context.js";
import type { Files } from "../files/feature.js";
import { HttpError } from "../httpError.js";
import { secretToken } from "../ids.js";
import type { registerMessages } from "../messages/feature.js";

/**
 * Whose role or account an admin may change: not their own, never the
 * owner's, another admin's only as the owner.
 */
function mayChange(me: User, target: User): void {
  if (target.id === me.id) throw new HttpError(400, "cannot_change_self");
  if (target.role === "owner") throw new HttpError(403, "owner_is_protected");
  if (target.role === "admin" && me.role !== "owner") {
    throw new HttpError(403, "admins_are_equals", "Only the owner can change another admin.");
  }
}

/**
 * An admin looking after the workspace's people: the audit log, everyone's
 * roles and accounts, password and two-step resets, and reported messages.
 */
export function registerMemberAdmin(
  ctx: ServerContext,
  deps: {
    accounts: ReturnType<typeof registerAccounts>;
    messages: ReturnType<typeof registerMessages>;
    files: Files;
  },
) {
  const { store, gateway, route, mutate, requireUser } = ctx;
  const { accounts, messages, files } = deps;

  route(endpoints.listAudit, async ({ query }) => {
    const entries = store.audit.list({ before: query.before, limit: query.limit + 1 });
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
    mayChange(me, target);
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
        store.audit.record({
          actorId: me.id,
          action: "user.role_changed",
          targetType: "user",
          targetId: target.id,
          details: { from: target.role, to: body.role },
        });
      }
      if (body.canInvite !== undefined && body.canInvite !== hadInvitePermission) {
        store.audit.record({
          actorId: me.id,
          action: body.canInvite
            ? "user.invite_permission_granted"
            : "user.invite_permission_removed",
          targetType: "user",
          targetId: target.id,
        });
      }
      if (body.deactivated !== undefined && body.deactivated !== target.deactivated) {
        store.audit.record({
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
      store.audit.record({
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
      store.audit.record({
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
    for (const open of store.reports.open()) {
      const channel = store.channels.get(open.channelId);
      if (!channel) continue;
      reports.push({ ...open, message: store.messages.get(open.messageId), channel });
    }
    return { reports };
  });

  route(endpoints.resolveReport, async ({ user: me, body, params }) => {
    const { action } = body;
    const open = store.reports.open().find((held) => held.messageId === params.id);
    if (!open) throw new HttpError(404, "report_not_found");
    const author = store.people.get(open.authorId);
    if (action === "deactivate" && author) mayChange(me, author);
    mutate((emit, afterCommit) => {
      const message = store.messages.get(open.messageId);
      if (action !== "dismiss" && message) messages.removeMessageWithin(message, emit);
      if (action === "deactivate" && author && !author.deactivated) {
        const updated = store.people.update(author.id, { deactivated: true });
        store.audit.record({
          actorId: me.id,
          action: "user.deactivated",
          targetType: "user",
          targetId: author.id,
        });
        store.accounts.deleteSessionsFor(author.id);
        afterCommit(() => gateway.disconnectUser(author.id));
        emit({ type: "user.updated", user: updated });
      }
      const reports = store.reports.resolve(open.messageId, me.id, action);
      store.audit.record({
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
}
