import { endpoints, type User } from "@ownbase/protocol";
import {
  requireChannelAccess,
  requireVisibleMessage,
  type ServerContext,
} from "../core/context.js";
import { HttpError } from "../httpError.js";

/** Threads: their history, and following, muting and reading them. */
export function registerThreads(ctx: ServerContext) {
  const { store, route } = ctx;

  route(endpoints.threadHistory, async ({ user: me, query, params }) => {
    requireChannelAccess(store, params.id, me);
    const root = store.messages.get(params.rootId);
    if (!root || root.channelId !== params.id || root.threadRootId)
      throw new HttpError(404, "thread_not_found");
    if (query.around) {
      const target = store.messages.get(query.around);
      if (!target || target.channelId !== root.channelId || target.threadRootId !== root.id)
        throw new HttpError(404, "message_not_found");
    }
    return {
      root,
      ...store.threads.history(root.channelId, root.id, query),
      seq: store.currentSeq(),
    };
  });

  route(endpoints.setThreadFollow, async ({ user: me, body, params }) => {
    const message = requireVisibleMessage(store, params.id, me);
    if (message.threadRootId) throw new HttpError(400, "not_a_thread_root");
    const state = store.threads.setFollow(me.id, message.id, body.following);
    if (!state) throw new HttpError(404, "message_not_found");
    return { state };
  });

  route(endpoints.setThreadMute, async ({ user: me, body, params }) => {
    const message = requireVisibleMessage(store, params.id, me);
    if (message.threadRootId) throw new HttpError(400, "not_a_thread_root");
    const state = store.threads.setMute(me.id, message.id, body.muted);
    if (!state) throw new HttpError(404, "message_not_found");
    return { state };
  });

  route(endpoints.markThreadRead, async ({ user: me, body, params }) => {
    const message = requireVisibleMessage(store, params.id, me);
    if (message.threadRootId) throw new HttpError(400, "not_a_thread_root");
    const state = store.threads.markRead(me.id, message.id, body.seq);
    if (!state) throw new HttpError(404, "message_not_found");
    return { state };
  });

  route(endpoints.markThreadUnread, async ({ user: me, body, params }) => {
    const message = requireVisibleMessage(store, params.id, me);
    if (message.threadRootId) throw new HttpError(400, "not_a_thread_root");
    const { seq } = body;
    const state = store.threads.markUnread(me.id, message.id, seq);
    if (!state) {
      if (!store.threads.follow(me.id, message.id)) throw new HttpError(404, "message_not_found");
      throw new HttpError(400, "invalid_unread_target");
    }
    return { state };
  });

  route(endpoints.listFollowedThreads, async ({ user: me, query }) => {
    return store.threads.followed(me.id, query.limit, query.cursor, query.unreadOnly === "true");
  });

  return {
    snapshot: (user: User) => ({ threadFollows: store.threads.follows(user.id) }),
  };
}
