import { endpoints, type User } from "@ownbase/protocol";
import {
  checkedPicture,
  guestRestricted,
  requireVisibleMessage,
  type ServerContext,
} from "../core/context.js";
import { SoonestTimer } from "../core/soonest.js";
import { HttpError } from "../httpError.js";

/** People: profiles and statuses, pictures, the member list, friends, blocks, and reporting a message. */
export function registerPeople(ctx: ServerContext) {
  const { store, gateway, route, mutate } = ctx;

  // A status set to clear itself (UX-61) is cleared at its time, for everyone
  // to see, by one timer set for the soonest.
  const statusExpiry = new SoonestTimer({
    lifecycle: ctx.lifecycle,
    next: () => store.people.nextStatusExpiry(),
    due: () =>
      ctx.background.maintain("expired statuses", () => {
        const due = store.people.expiredStatusUserIds(Date.now());
        if (due.length > 0)
          mutate((emit) => {
            for (const id of due) {
              const user = store.people.update(id, {
                statusText: "",
                statusEmoji: "",
                statusExpiresAt: null,
              });
              emit({ type: "user.updated", user });
            }
          });
      }),
  });

  route(endpoints.me, async ({ user }) => ({ user }));

  route(endpoints.updateMe, async ({ user: me, body }) => {
    const statusChanged =
      body.statusText !== undefined ||
      body.statusEmoji !== undefined ||
      body.statusExpiresAt !== undefined;
    const result = mutate((emit) => {
      const user = store.people.update(me.id, {
        ...body,
        // A new status without an end keeps no earlier status's end.
        ...((body.statusText !== undefined || body.statusEmoji !== undefined) &&
        body.statusExpiresAt === undefined
          ? { statusExpiresAt: null }
          : {}),
      });
      emit({ type: "user.updated", user });
      return { user };
    });
    if (statusChanged) statusExpiry.arm();
    if (body.away !== undefined) gateway.refreshPresence(me.id);
    return result;
  });

  route(endpoints.avatar, async ({ req, reply, params, query }) => {
    const picture = store.people.avatar(params.id);
    // A version that is not the picture's names one that is gone: the
    // bytes now are another picture's, kept for good under that name.
    if (!picture || (query.v !== undefined && query.v !== picture.version)) {
      reply.header("cache-control", "no-store");
      throw new HttpError(404, "no_avatar", "They have no profile picture.");
    }
    const etag = `"${picture.version}"`;
    reply
      .header("content-type", picture.type)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("etag", etag)
      .header(
        "cache-control",
        query.v === picture.version ? "private, max-age=31536000, immutable" : "no-cache",
      );
    if (req.headers["if-none-match"] === etag) return reply.status(304).send();
    return reply.header("content-length", String(picture.bytes.length)).send(picture.bytes);
  });

  route(endpoints.removeAvatar, async ({ user: me }) => {
    return mutate((emit) => {
      const user = store.people.setAvatar(me.id, null);
      emit({ type: "user.updated", user });
      return { user };
    });
  });

  route(endpoints.listUsers, async () => {
    return { users: store.people.list() };
  });

  route(endpoints.friends, async ({ user }) => ({ friends: store.people.friends(user.id) }));
  route(endpoints.requestFriend, async ({ user: me, params }) => {
    const other = store.people.get(params.id);
    if (!other || other.deactivated || other.isBot || other.id === me.id)
      throw new HttpError(400, "invalid_friend");
    if (other.role === "guest") throw guestRestricted();
    store.people.requestFriend(me.id, other.id);
    return { friends: store.people.friends(me.id) };
  });
  route(endpoints.acceptFriend, async ({ user: me, params }) => {
    if (!store.people.acceptFriend(me.id, params.id)) throw new HttpError(404, "request_not_found");
    return { friends: store.people.friends(me.id) };
  });
  route(endpoints.removeFriend, async ({ user: me, params }) => {
    store.people.removeFriend(me.id, params.id);
    return { friends: store.people.friends(me.id) };
  });

  route(endpoints.blockUser, async ({ user: me, params }) => {
    const other = store.people.get(params.id);
    if (!other) throw new HttpError(404, "user_not_found");
    if (other.id === me.id) throw new HttpError(400, "cannot_block_self");
    if (other.isBot)
      throw new HttpError(
        400,
        "cannot_block_app",
        "Apps cannot be blocked. Ask an admin about one.",
      );
    const befriended = store.people.friends(me.id).some((friend) => friend.userId === other.id);
    store.transaction(() => {
      if (store.people.setBlocked(me.id, other.id, true) && befriended)
        store.people.removeFriend(me.id, other.id);
    });
    return { blocked: store.people.blockedIds(me.id) };
  });

  route(endpoints.unblockUser, async ({ user: me, params }) => {
    store.people.setBlocked(me.id, params.id, false);
    return { blocked: store.people.blockedIds(me.id) };
  });

  route(endpoints.reportMessage, async ({ user: me, body, params }) => {
    const message = requireVisibleMessage(store, params.id, me);
    if (message.userId === me.id) throw new HttpError(400, "cannot_report_own_message");
    store.reports.file(message.id, me.id, body.reason, body.note?.trim() ?? "");
    return { ok: true };
  });

  route(endpoints.setAvatar, async ({ req, user: me, body }) => {
    const picture = checkedPicture(req, body, "profile picture");
    return mutate((emit) => {
      const user = store.people.setAvatar(me.id, picture);
      emit({ type: "user.updated", user });
      return { user };
    });
  });

  return {
    /** Statuses that ended while the server was stopped clear as it starts. */
    start: () => statusExpiry.arm(),
    snapshot: (user: User) => ({
      users: store.people.list(),
      friends: store.people.friends(user.id),
      blocked: store.people.blockedIds(user.id),
    }),
  };
}
