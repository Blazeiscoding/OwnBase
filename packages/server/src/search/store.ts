import type { ID, Message, ParsedSearch } from "@ownbase/protocol";
import { FILE_TYPE_MATCH } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { MENTIONS_ME, NAMES_ME, NOT_BLOCKED, UNREAD } from "../core/sqlRules.js";
import type { MessageRow, Store } from "../store.js";

/** Finding messages: search by words and filters, and the Activity list of mentions. */
export class SearchStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

  /**
   * Full-text search restricted to what the user can see, with modifier
   * filters (from:/in:/has:/before:/after:) applied as plain SQL. Free-text
   * terms go to FTS5; a query with only modifiers skips FTS entirely.
   */
  activity(
    userId: ID,
    opts: { mode: "unread" | "mentions" | "threads"; cursor?: ID; limit: number },
  ): Message[] {
    const conditions = ["cm.user_id = ?", "m.user_id != ?", "m.deleted_at IS NULL", NOT_BLOCKED];
    const params: (string | number)[] = [userId, userId];
    if (opts.mode === "unread") {
      // What the channel shows, replies in threads followed, and anything
      // naming this account; the rest of a thread is its own to open.
      conditions.push(
        UNREAD,
        `(m.thread_root_id IS NULL OR m.broadcast = 1 OR ${MENTIONS_ME} OR EXISTS (
          SELECT 1 FROM thread_follows tf
          WHERE tf.user_id = cm.user_id AND tf.root_id = m.thread_root_id AND tf.following = 1))`,
      );
      params.push(`<@${userId}>`);
    } else if (opts.mode === "threads") {
      // Unread replies in the threads this account follows.
      conditions.push(
        UNREAD,
        `m.thread_root_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM thread_follows tf
          WHERE tf.user_id = cm.user_id AND tf.root_id = m.thread_root_id AND tf.following = 1)`,
      );
    } else {
      // Read from who each message names, not by walking every message.
      conditions.push(NAMES_ME);
      params.push(userId);
    }
    if (opts.cursor) {
      conditions.push("m.id < ?");
      params.push(opts.cursor);
    }
    conditions.push(
      "(m.thread_root_id IS NULL OR EXISTS (SELECT 1 FROM messages root WHERE root.id = m.thread_root_id AND root.deleted_at IS NULL))",
    );
    // Unread and threads walk messages newest first and stop at the page's
    // end. Mentions start from who each message names, where one message can
    // appear twice (named, and the whole room), so they are grouped by message.
    const query =
      opts.mode !== "mentions"
        ? `SELECT m.* FROM messages m JOIN channels c ON c.id = m.channel_id
           JOIN channel_members cm ON cm.channel_id = c.id
           WHERE ${conditions.join(" AND ")} ORDER BY m.id DESC LIMIT ?`
        : `SELECT m.* FROM message_mentions mm
           JOIN channel_members cm ON cm.channel_id = mm.channel_id
           JOIN channels c ON c.id = mm.channel_id JOIN messages m ON m.id = mm.message_id
           WHERE ${conditions.join(" AND ")} GROUP BY m.id ORDER BY m.id DESC LIMIT ?`;
    const rows = this.db.prepare(query).all(...params, opts.limit) as unknown as MessageRow[];
    return this.store.hydrateMessages(rows);
  }

  /**
   * Above this many matches, a search walks the newest messages first rather
   * than starting from its matches (OPT-11). Starting from them costs about a
   * microsecond each, and the walk a few milliseconds whatever it finds, so
   * this is about where the walk starts to pay.
   */
  static SEARCH_FEW_MATCHES = 5000;

  /** How many of the newest messages that walk covers before it gives up. */
  static SEARCH_WINDOW = 20_000;

  search(
    userId: ID,
    query: ParsedSearch,
    limit: number,
    opts: { cursor?: ID; channelId?: ID } = {},
  ): Message[] {
    type Filter = [sql: string, ...values: (string | number)[]];
    // Where the newest messages are counted from: the same page and channel.
    const scope: Filter[] = [];
    if (opts.cursor) scope.push(["m.id < ?", opts.cursor]);
    if (opts.channelId) scope.push(["m.channel_id = ?", opts.channelId]);
    const filters: Filter[] = [["m.deleted_at IS NULL"], ...scope];

    if (query.from.length > 0) {
      filters.push([`u.handle IN (${query.from.map(() => "?").join(",")})`, ...query.from]);
    }
    if (query.in.length > 0) {
      filters.push([`c.name IN (${query.in.map(() => "?").join(",")})`, ...query.in]);
    }
    if (query.has.includes("link")) {
      // Parenthesised: this sits inside an AND-joined list.
      filters.push(["(m.text LIKE '%http://%' OR m.text LIKE '%https://%')"]);
    }
    if (query.has.includes("file")) {
      filters.push(["EXISTS (SELECT 1 FROM files f WHERE f.message_id = m.id)"]);
    }
    if (query.types.length > 0) {
      // By media type, or by the name's ending for a file sent as anything.
      const kinds = query.types.flatMap((type): Filter[] => [
        ...FILE_TYPE_MATCH[type].mime.map((mime): Filter => ["lower(f.mime) LIKE ?", mime]),
        ...FILE_TYPE_MATCH[type].ext.map((ext): Filter => ["lower(f.name) LIKE ?", `%.${ext}`]),
      ]);
      filters.push([
        `EXISTS (SELECT 1 FROM files f WHERE f.message_id = m.id
           AND (${kinds.map(([sql]) => sql).join(" OR ")}))`,
        ...kinds.flatMap(([, ...values]) => values),
      ]);
    }
    if (query.before !== null) filters.push(["m.created_at < ?", query.before]);
    if (query.after !== null) filters.push(["m.created_at >= ?", query.after]);

    // Visibility is never optional, whatever the modifiers say.
    filters.push([
      `(c.type = 'public' OR EXISTS (
         SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?
       ))`,
      userId,
    ]);

    const page = (more: Filter[], count: number) => {
      const all = [...filters, ...more];
      return this.db
        .prepare(
          `SELECT m.* FROM messages m
           JOIN channels c ON c.id = m.channel_id
           JOIN users u ON u.id = m.user_id
           WHERE ${all.map(([sql]) => sql).join(" AND ")}
           ORDER BY m.id DESC LIMIT ?`,
        )
        .all(...all.flatMap(([, ...values]) => values), count) as unknown as MessageRow[];
    };
    if (query.terms.length === 0) return this.store.hydrateMessages(page([], limit));

    // Quote every term so user input can never break FTS5 syntax. The last
    // one matches as the start of a word, so a search run as it is typed
    // finds "mockups" from "mock"; one with no letter or digit has no word
    // to start.
    const fts = query.terms
      .map((t, i) => {
        const phrase = `"${t.replaceAll('"', '""')}"`;
        return i === query.terms.length - 1 && /[\p{L}\p{N}]/u.test(t) ? `${phrase}*` : phrase;
      })
      .join(" ");
    // A message is found by the name of a file attached to it too, when every
    // term is in that one name (IMP-02). Only terms with a letter or digit in
    // them: "." alone would otherwise find every file there is.
    const nameTerms = query.terms.filter((t) => /[\p{L}\p{N}]/u.test(t));
    const named: Filter =
      nameTerms.length > 0
        ? [
            `OR m.id IN (SELECT f.message_id FROM files f WHERE f.message_id IS NOT NULL
               AND ${nameTerms.map(() => "f.name LIKE ? ESCAPE '\\'").join(" AND ")})`,
            ...nameTerms.map((t) => `%${t.replaceAll(/[\\%_]/g, "\\$&")}%`),
          ]
        : [""];
    const [namedSql, ...namedValues] = named;
    const matching: Filter = [
      `(m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) ${namedSql})`,
      fts,
      ...namedValues,
    ];
    const many =
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages_fts WHERE messages_fts MATCH ? LIMIT ?)",
          )
          .get(fts, SearchStore.SEARCH_FEW_MATCHES + 1) as { n: number }
      ).n > SearchStore.SEARCH_FEW_MATCHES;
    // The same matches as one list of rows, for a search that starts from
    // them (F13). Asked as "said, or named", SQLite reads the file names once
    // to pick the rows and again to check each one; read once into the list,
    // a word in a few hundred file names is found in half the time, and no
    // search measured is slower.
    const fromMatches: Filter = [
      `m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?
         ${
           nameTerms.length > 0
             ? `UNION ALL SELECT named.rowid FROM files f CROSS JOIN messages named
                  ON named.id = f.message_id
                WHERE f.message_id IS NOT NULL
                  AND ${nameTerms.map(() => "f.name LIKE ? ESCAPE '\\'").join(" AND ")}`
             : ""
         })`,
      fts,
      ...namedValues,
    ];
    // A word in few messages is found from its matches. A common one would
    // have every match read, joined and sorted for one page: 120,000 of them
    // for "the" in 200,000 messages. So the newest messages are walked first,
    // checked against only their own matches, and the older ones are read
    // from the matches only if the newest hold less than a page.
    if (!many) return this.store.hydrateMessages(page([fromMatches], limit));
    const window = this.db
      .prepare(
        `SELECT MIN(id) AS edge, MIN(position) AS low, COUNT(*) AS n FROM (
           SELECT m.id, m.rowid AS position FROM messages m
           ${scope.length > 0 ? `WHERE ${scope.map(([sql]) => sql).join(" AND ")}` : ""}
           ORDER BY m.id DESC LIMIT ?
         )`,
      )
      .get(...scope.flatMap(([, ...values]) => values), SearchStore.SEARCH_WINDOW) as {
      edge: ID | null;
      low: number | null;
      n: number;
    };
    if (window.edge === null || window.low === null) return [];
    // Every message from the edge on has a rowid of at least `low`, whatever
    // order rowids were given in, so no match in the window is missed. The
    // unary plus keeps SQLite from starting at the matches instead.
    const newest = page(
      [
        [
          `(+m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid >= ?)
            ${namedSql})`,
          fts,
          window.low,
          ...namedValues,
        ],
        ["m.id >= ?", window.edge],
      ],
      limit,
    );
    if (newest.length === limit || window.n < SearchStore.SEARCH_WINDOW) {
      return this.store.hydrateMessages(newest);
    }
    const older = page([matching, ["m.id < ?", window.edge]], limit - newest.length);
    return this.store.hydrateMessages([...newest, ...older]);
  }
}
