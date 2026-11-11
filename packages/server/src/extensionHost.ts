import { planMembers, registerBody } from "@ownbase/protocol";
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
  const { opts, app, store, settings, route, mutate, network } = ctx;

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
        return { token: accounts.startSession(req, user.id), user };
      },
      publicUrl: () => network.publicUrl(),
    });
  }
}
