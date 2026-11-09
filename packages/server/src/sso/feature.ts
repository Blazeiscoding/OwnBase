import { planMembers, type ID } from "@ownbase/protocol";
import { hashPassword, newSessionToken } from "../auth.js";
import type { RecordEvent } from "../core/commit.js";
import type { ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";
import { secretToken } from "../ids.js";

/**
 * The server's extensions (P6), such as ee/'s single sign-on (P9): each is
 * registered after the server's own routes, with what it may use of the
 * server, chiefly a way to make members and sign them in its own way.
 */
export async function registerExtensions(
  ctx: ServerContext,
  { joinPublicChannels }: { joinPublicChannels: (userId: ID, emit: RecordEvent) => void },
) {
  const { opts, app, store, settings, route, mutate, network } = ctx;

  /** A member made by an extension, such as single sign-on's first sign-in (P9). */
  const createMember = async (input: { handle: string; displayName: string }) => {
    // Nobody knows it: the account signs in the extension's way.
    const credentials = await hashPassword(secretToken());
    return mutate((emit) => {
      if (store.people.count() === 0)
        throw new HttpError(409, "workspace_unclaimed", "The workspace has no owner yet.");
      if (store.people.authByHandle(input.handle)) throw new HttpError(409, "handle_taken");
      const user = store.people.create({
        handle: input.handle,
        displayName: input.displayName,
        passwordHash: credentials.hash,
        salt: credentials.salt,
        role: "member",
      });
      emit({ type: "user.joined", user });
      joinPublicChannels(user.id, emit);
      return user;
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
        byHandle: (handle) => {
          const auth = store.people.authByHandle(handle.toLowerCase());
          if (!auth) return null;
          const { passwordHash: _p, salt: _s, ...user } = auth;
          return user;
        },
        create: createMember,
      },
      startSession: (userId, req) => {
        const user = store.people.get(userId);
        if (!user || user.deactivated) throw new HttpError(401, "invalid_credentials");
        const { token, tokenHash } = newSessionToken();
        store.accounts.createSession(tokenHash, user.id, network.deviceName(req));
        return { token, user };
      },
      publicUrl: () => network.publicUrl(),
    });
  }
}
