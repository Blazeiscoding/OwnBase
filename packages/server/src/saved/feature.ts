import { endpoints, type User } from "@ownbase/protocol";
import {
  requireChannelAccess,
  requireVisibleMessage,
  type ServerContext,
} from "../core/context.js";

/** Pins, which a channel shares, and saved messages, which are each account's own. */
export function registerSaved(ctx: ServerContext) {
  const { store, route, mutate } = ctx;

  route(endpoints.pinMessage, async ({ user: me, params }) => {
    const message = requireVisibleMessage(store, params.id, me);
    mutate((emit) => {
      if (store.saved.pin(message.channelId, message.id, me.id)) {
        emit({
          type: "pin.added",
          channelId: message.channelId,
          messageId: message.id,
          userId: me.id,
        });
      }
    });
    return { ok: true };
  });

  route(endpoints.unpinMessage, async ({ user: me, params }) => {
    const message = requireVisibleMessage(store, params.id, me);
    mutate((emit) => {
      if (store.saved.unpin(message.id)) {
        emit({ type: "pin.removed", channelId: message.channelId, messageId: message.id });
      }
    });
    return { ok: true };
  });

  route(endpoints.listPins, async ({ user: me, query, params }) => {
    requireChannelAccess(store, params.id, me);
    return store.saved.listPins(params.id, query.limit, query.cursor);
  });

  route(endpoints.saveMessage, async ({ user: me, params }) => {
    const message = requireVisibleMessage(store, params.id, me);
    store.saved.save(me.id, message.id);
    return { ok: true };
  });

  route(endpoints.unsaveMessage, async ({ user: me, params }) => {
    store.saved.unsave(me.id, params.id);
    return { ok: true };
  });

  route(endpoints.listSaved, async ({ user: me, query }) => {
    return store.saved.listSaved(me.id, query.limit, query.cursor);
  });

  return {
    snapshot: (user: User) => ({ savedMessageIds: store.saved.savedIds(user.id) }),
  };
}
