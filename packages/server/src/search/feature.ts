import { endpoints, hasSearchCriteria, isTimeZone, parseSearchQuery } from "@ownbase/protocol";
import { requireChannelAccess, type ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";

/** Search and the Activity list: finding messages the caller can read. */
export function registerSearch(ctx: ServerContext) {
  const { store, route } = ctx;

  route(endpoints.activity, async ({ user: me, query }) => {
    const matches = store.search.activity(me.id, { ...query, limit: query.limit + 1 });
    const messages = matches.slice(0, query.limit);
    return { messages, nextCursor: matches.length > query.limit ? messages.at(-1)!.id : null };
  });

  route(endpoints.search, async ({ user: me, query: q }) => {
    if (q.channelId) requireChannelAccess(store, q.channelId, me);
    if (q.tz !== undefined && !isTimeZone(q.tz))
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
    const matches = store.search.search(me.id, parsed, q.limit + 1, q);
    const messages = matches.slice(0, q.limit);
    return { messages, nextCursor: matches.length > q.limit ? messages.at(-1)!.id : null };
  });
}
