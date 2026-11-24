import {
  endpoints,
  hasSearchCriteria,
  isTimeZone,
  parseSearchQuery,
  type User,
} from "@ownbase/protocol";
import { requireChannelAccess, type ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";
import { parseReactionCursor, reactionCursor, readRankCursor } from "./store.js";

/** Search and the Activity lists: finding messages the caller can read, and reactions to theirs. */
export function registerSearch(ctx: ServerContext) {
  const { store, route } = ctx;

  route(endpoints.activity, async ({ user: me, query }) => {
    const matches = store.search.activity(me.id, { ...query, limit: query.limit + 1 });
    const messages = matches.slice(0, query.limit);
    return { messages, nextCursor: matches.length > query.limit ? messages.at(-1)!.id : null };
  });

  route(endpoints.reactionActivity, async ({ user: me, query }) => {
    const after = query.cursor ? parseReactionCursor(query.cursor) : null;
    if (query.cursor && !after)
      throw new HttpError(400, "invalid_request", "That page of reactions does not exist.");
    const found = store.search.reactions(me.id, { after, limit: query.limit + 1 });
    const reactions = found.slice(0, query.limit);
    return {
      reactions,
      nextCursor: found.length > query.limit ? reactionCursor(reactions.at(-1)!) : null,
      seenAt: store.search.reactionsSeenAt(me.id),
      unseen: store.search.unseenReactions(me.id),
    };
  });

  route(endpoints.seeReactions, async ({ user: me, body }) => {
    const seenAt = store.search.seeReactions(me.id, body.upTo);
    return { seenAt, unseen: store.search.unseenReactions(me.id) };
  });

  route(endpoints.search, async ({ user: me, query: q }) => {
    if (q.channelId) requireChannelAccess(store, q.channelId, me);
    if (!isTimeZone(q.tz))
      throw new HttpError(
        400,
        "invalid_time_zone",
        `${q.tz} is not a time zone this server knows.`,
      );
    const parsed = parseSearchQuery(q.q, { timeZone: q.tz });
    // A date that is not one would otherwise be dropped, and the search would
    // quietly cover more than was asked for.
    if (parsed.invalid.length > 0)
      throw new HttpError(
        400,
        "invalid_search_date",
        `Not a date: ${parsed.invalid.join(", ")}. Write dates as YYYY-MM-DD.`,
      );
    // A query of nothing but stray punctuation should return nothing, not everything.
    if (!hasSearchCriteria(parsed) && !q.channelId) return { messages: [], nextCursor: null };
    // With no words there is nothing to rank by, so newest first it is.
    if (q.sort === "relevant" && parsed.terms.length > 0) {
      const cursor = q.cursor === undefined ? undefined : readRankCursor(q.cursor);
      if (cursor === null)
        throw new HttpError(
          400,
          "invalid_search_cursor",
          "This page of results came from another search. Search again from the top.",
        );
      return store.search.relevant(me.id, parsed, q.limit, { cursor, channelId: q.channelId });
    }
    const matches = store.search.search(me.id, parsed, q.limit + 1, {
      cursor: q.cursor,
      channelId: q.channelId,
      order: q.sort === "oldest" ? "oldest" : "newest",
    });
    const messages = matches.slice(0, q.limit);
    return { messages, nextCursor: matches.length > q.limit ? messages.at(-1)!.id : null };
  });

  return {
    snapshot: (user: User) => ({
      reactionsSeenAt: store.search.reactionsSeenAt(user.id),
      unseenReactions: store.search.unseenReactions(user.id),
    }),
  };
}
