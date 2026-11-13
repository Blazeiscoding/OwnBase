import { createReadStream } from "node:fs";
import { join } from "node:path";
import { planMembers, registerBody } from "@ownbase/protocol";
import { OutboundError, postToUrl } from "./outbound.js";
import type { Accounts } from "./accounts/feature.js";
import { hashPassword } from "./auth.js";
import type { ServerContext } from "./core/context.js";
import { HttpError } from "./httpError.js";
import { secretToken } from "./ids.js";

/** The handle and name an extension gives a member, by the rules joining holds them to. */
const memberName = registerBody.pick({ handle: true, displayName: true });

/**
 * The server's extensions (P6), such as ee/'s single sign-on (P9): each is
 * registered after the server's own routes, with what it may use of the
 * server, chiefly a way to make members and sign them in its own way.
 */
export async function registerExtensions(
  ctx: ServerContext,
  { accounts }: { accounts: Pick<Accounts, "makeMember" | "startSession"> },
) {
  const { opts, app, store, settings, route, mutate, network, gateway, lifecycle, ticketFor } = ctx;
  const filesDir = opts.dataDir === ":memory:" ? null : join(opts.dataDir, "files");

  /** A member made by an extension, such as single sign-on's first sign-in (P9). */
  const createMember = async (input: { handle: string; displayName: string }) => {
    const named = memberName.safeParse(input);
    if (!named.success)
      throw new HttpError(
        400,
        "invalid_request",
        "That is not a username or name a member can have.",
      );
    // Nobody knows it: the account signs in the extension's way.
    const credentials = await hashPassword(secretToken());
    return mutate((emit) => {
      if (store.people.count() === 0)
        throw new HttpError(409, "workspace_unclaimed", "The workspace has no owner yet.");
      if (store.people.authByHandle(named.data.handle)) throw new HttpError(409, "handle_taken");
      return accounts.makeMember(emit, {
        ...named.data,
        passwordHash: credentials.hash,
        salt: credentials.salt,
        role: "member",
      });
    });
  };

  /** A person changed by an extension, such as SCIM provisioning deactivating someone who left (P10). */
  const updateMember = (
    id: string,
    patch: { displayName?: string; deactivated?: boolean },
    by: string,
  ) => {
    if (
      patch.displayName !== undefined &&
      !memberName.shape.displayName.safeParse(patch.displayName).success
    )
      throw new HttpError(400, "invalid_request", "That is not a name a member can have.");
    return mutate((emit, afterCommit) => {
      const target = store.people.get(id);
      if (!target || target.isBot) throw new HttpError(404, "user_not_found");
      // The owner is the way back in when everything else fails.
      if (patch.deactivated && target.role === "owner")
        throw new HttpError(
          403,
          "owner_is_protected",
          "The workspace's owner cannot be deactivated.",
        );
      const updated = store.people.update(id, patch);
      if (patch.deactivated !== undefined && patch.deactivated !== target.deactivated) {
        store.audit.record({
          actorId: null,
          action: patch.deactivated ? "user.deactivated" : "user.reactivated",
          targetType: "user",
          targetId: id,
          details: { by },
        });
      }
      if (patch.deactivated === true) {
        store.accounts.deleteSessionsFor(id);
        afterCommit(() => gateway.disconnectUser(id));
      }
      if (updated.displayName !== target.displayName || updated.deactivated !== target.deactivated)
        emit({ type: "user.updated", user: updated });
      return updated;
    });
  };

  for (const extension of opts.extensions ?? []) {
    await extension.register?.({
      route,
      memberCount: () => planMembers(store.people.list()),
      log: app.log.child({ extension: extension.name }),
      storage: settings.extensionStorage(extension.name),
      users: {
        get: (id) => store.people.get(id),
        list: () => store.people.list(),
        byHandle: (handle) => {
          const auth = store.people.authByHandle(handle.toLowerCase());
          if (!auth) return null;
          const { passwordHash: _p, salt: _s, ...user } = auth;
          return user;
        },
        create: createMember,
        update: updateMember,
      },
      startSession: (userId, req) => {
        const user = store.people.get(userId);
        if (!user || user.deactivated) throw new HttpError(401, "invalid_credentials");
        return { token: accounts.startSession(req, user.id), user };
      },
      publicUrl: () => network.publicUrl(),
      audit: {
        record: ({ actorId, did, details }) =>
          store.audit.record({
            actorId,
            action: "extension.action",
            targetType: "workspace",
            targetId: null,
            details: { ...details, did },
          }),
        after: (afterId, limit) => store.audit.after(afterId, limit),
        onRecord: (listener) => store.audit.onRecord(listener),
      },
      messages: { recorded: (query) => store.messages.recorded(query) },
      channels: { list: () => store.channels.all() },
      files: {
        // Ids are ULIDs, so a name never leaves the folder; checked all the same.
        open: (id) =>
          filesDir && /^[0-9A-Za-z]+$/.test(id) ? createReadStream(join(filesDir, id)) : null,
      },
      post: async (url, body, { contentType, headers }) => {
        if (opts.isolated)
          throw new OutboundError(
            "blocked_host",
            "this is an isolated copy of the workspace, which contacts nothing outside",
          );
        const res = await postToUrl(url, body, contentType, {
          allowPrivate: opts.allowPrivateHooks,
          signal: lifecycle.signal,
          ...(headers ? { headers } : {}),
        });
        return { status: res.status, body: res.body };
      },
      ticketFor,
    });
  }
}
