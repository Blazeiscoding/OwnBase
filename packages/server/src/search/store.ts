import type { ID, Message, ParsedSearch, ReactionActivity } from "@ownbase/protocol";
import {
  FILE_TYPE_MATCH,
  keywordKey,
  REACTION_ACTIVITY_NAMES,
  UNSEEN_REACTIONS_MAX,
} from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { NAMES_ME, NOT_BLOCKED, UNREAD } from "../core/sqlRules.js";
import { countOf, shape } from "../core/rows.js";
import { messageRow } from "../messages/store.js";
import type { Store } from "../store.js";
import { searchText } from "./words.js";

const windowRow = shape({ edge: "text?", bound: "number?", n: "number" });
const rankedRow = messageRow.with({ score: "number" });
const reactionGroupRow = shape({ message_id: "text", emoji: "text", at: "number" });
const reactorRow = shape({ message_id: "text", emoji: "text", user_id: "text" });
const seenRow = shape({ seen: "number" });
type MessageRow = ReturnType<typeof messageRow.read>;

type Filter = [sql: string, ...values: (string | number)[]];

/** Which end of time a page of results starts from. */
export type SearchOrder = "newest" | "oldest";

const DAY = 86_400_000;

/**
 * Where a page of results by relevance ended, so the next one starts after it
 * (K15). Results come in three runs: messages with every word, best first;
 * then, when there were too many of those to score, the rest of them that are
 * older than the newest messages, newest first; then messages with only some
 * of the words, best first.
 */
export interface RankCursor {
  /** When the first page was asked for. Every page measures age from it, so scores hold still. */
  now: number;
  /** The oldest of the newest SEARCH_WINDOW messages, and the lowest rowid among them. */
  edge: ID | null;
  low: number | null;
  /** Messages with every word are scored only within the window. */
  allBounded: boolean;
  /** Messages with some of the words are scored only within the window. */
  someBounded: boolean;
  phase: 1 | 2 | 3;
  /** The last result shown: its score in runs 1 and 3, and its id. */
  score: number | null;
  id: ID | null;
}

const CURSOR_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function writeRankCursor(at: RankCursor): string {
  return [
    "r",
    at.now,
    at.edge ?? "",
    at.low ?? "",
    `${at.allBounded ? 1 : 0}${at.someBounded ? 1 : 0}`,
    at.phase,
    at.score ?? "",
    at.id ?? "",
  ].join("~");
}

/** A cursor `writeRankCursor` wrote, or null for any other text. */
export function readRankCursor(text: string): RankCursor | null {
  const parts = text.split("~");
  if (parts.length !== 8 || parts[0] !== "r") return null;
  const [, now, edge, low, flags, phase, score, id] = parts as [string, ...string[]];
  const number = (value: string) => (value === "" ? null : Number(value));
  const at: RankCursor = {
    now: Number(now),
    edge: edge || null,
    low: number(low!),
    allBounded: flags![0] === "1",
    someBounded: flags![1] === "1",
    phase: Number(phase) as RankCursor["phase"],
    score: number(score!),
    id: id || null,
  };
  const bounded = at.allBounded || at.someBounded;
  if (
    !Number.isSafeInteger(at.now) ||
    !/^[01]{2}$/.test(flags!) ||
    ![1, 2, 3].includes(at.phase) ||
    (at.edge !== null && !CURSOR_ID.test(at.edge)) ||
    (at.id !== null && !CURSOR_ID.test(at.id)) ||
    (at.low !== null && !Number.isSafeInteger(at.low)) ||
    (at.score !== null && !Number.isFinite(at.score)) ||
    bounded !== (at.edge !== null && at.low !== null) ||
    (at.phase === 2 && !at.allBounded) ||
    (at.phase !== 2 && (at.score === null) !== (at.id === null))
  )
    return null;
  return at;
}

/**
 * The words as an FTS5 query, every word or any of them. Each is quoted so
 * user input can never break FTS5 syntax. The last one matches as the start
 * of a word, so a search run as it is typed finds "mockups" from "mock"; one
 * with no letter or digit has no word to start. Each term is split as the
 * index split the text it holds, so a run of Chinese or Japanese is a phrase
 * of its characters.
 */
function matchText(terms: readonly string[], join: " " | " OR "): string {
  return terms
    .map((t, i) => {
      const phrase = `"${searchText(t).trim().replaceAll('"', '""')}"`;
      return i === terms.length - 1 && /[\p{L}\p{N}]/u.test(t) ? `${phrase}*` : phrase;
    })
    .join(join);
}

/**
 * A message is found by the name of a file attached to it too, when every
 * term is in that one name (IMP-02). Only terms with a letter or digit in
 * them: "." alone would otherwise find every file there is. Null when no
 * term has one.
 */
function namesOf(terms: readonly string[]): Filter | null {
  const words = terms.filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (words.length === 0) return null;
  return [
    words.map(() => "f.name LIKE ? ESCAPE '\\'").join(" AND "),
    ...words.map((t) => `%${t.replaceAll(/[\\%_]/g, "\\$&")}%`),
  ];
}

/**
 * Other people's reactions to the messages of the account `?` names, as the
 * Reactions tab shows them: only in conversations it is still in, not on
 * removed messages or in removed threads, and none from someone it blocked.
 */
export const REACTIONS_SHOWN = `reactions r
  JOIN messages m ON m.id = r.message_id AND m.user_id = r.author_id
  JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = r.author_id
  WHERE r.author_id = ? AND r.user_id != r.author_id AND m.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.user_id = r.author_id AND ub.blocked_id = r.user_id)
    AND (m.thread_root_id IS NULL OR EXISTS (
      SELECT 1 FROM messages root WHERE root.id = m.thread_root_id AND root.deleted_at IS NULL))`;

/** Beside `reactions r`: not from someone the account `?` names blocked. */
const REACTOR_NOT_BLOCKED =
  "NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.user_id = ? AND ub.blocked_id = r.user_id)";

/** Where the next page of Reactions starts: after this entry. */
export function reactionCursor(entry: Pick<ReactionActivity, "at" | "message" | "emoji">): string {
  return `${entry.at}.${entry.message.id}.${entry.emoji}`;
}

export interface ReactionCursor {
  at: number;
  messageId: ID;
  emoji: string;
}

/** A cursor `reactionCursor` made, or null for anything else. */
export function parseReactionCursor(cursor: string): ReactionCursor | null {
  const [at, messageId, ...emoji] = cursor.split(".");
  if (!at || !/^\d+$/.test(at) || !messageId || emoji.length === 0) return null;
  return { at: Number(at), messageId, emoji: emoji.join(".") };
}

/**
 * Finding messages: search by words and filters, and the Activity lists of
 * mentions and of reactions to one's messages.
 */
export class SearchStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

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
        `(m.thread_root_id IS NULL OR m.broadcast = 1 OR EXISTS (
          SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND ${NAMES_ME}
        ) OR EXISTS (
          SELECT 1 FROM thread_follows tf
          WHERE tf.user_id = cm.user_id AND tf.root_id = m.thread_root_id AND tf.following = 1))`,
      );
      params.push(userId);
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
    const rows = messageRow.all(this.db.prepare(query), ...params, opts.limit);
    if (opts.mode !== "mentions") return this.store.messages.hydrate(rows);
    const hits = this.keywordHits(userId, opts);
    if (hits.length === 0) return this.store.messages.hydrate(rows);
    // Both lists are the newest `limit` after the cursor, so their newest
    // `limit` together are the page.
    const page = [...new Map([...rows, ...hits].map((row) => [row.id, row])).values()]
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, opts.limit);
    return this.store.messages.hydrate(page);
  }

  /**
   * Messages holding one of this account's keywords (K11), newest first, for
   * Activity's Mentions. Each keyword is looked for through the search index,
   * so the work is in its hits rather than in the history, and only in
   * messages sent since it was added. None in a conversation or a thread
   * this account muted, which a keyword does not reach into.
   */
  private keywordHits(userId: ID, opts: { cursor?: ID; limit: number }): MessageRow[] {
    const keywords = this.store.people
      .keywordsAdded(userId)
      .filter((k) => keywordKey(k.keyword) !== "");
    if (keywords.length === 0) return [];
    const each = keywords.map(
      () =>
        "SELECT rowid FROM messages WHERE created_at >= ? AND rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)",
    );
    const values = keywords.flatMap((k) => [
      k.addedAt,
      `"${searchText(k.keyword).trim().replaceAll('"', '""')}"`,
    ]);
    return messageRow.all(
      this.db.prepare(
        `WITH hits(id) AS (${each.join(" UNION ")})
         SELECT m.* FROM hits h JOIN messages m ON m.rowid = h.id
         JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
         WHERE m.user_id != ? AND m.deleted_at IS NULL AND cm.muted = 0 AND ${NOT_BLOCKED}
           ${opts.cursor ? "AND m.id < ?" : ""}
           AND (m.thread_root_id IS NULL OR (
             EXISTS (SELECT 1 FROM messages root WHERE root.id = m.thread_root_id AND root.deleted_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM thread_follows tf
               WHERE tf.user_id = cm.user_id AND tf.root_id = m.thread_root_id AND tf.muted = 1)))
         ORDER BY m.id DESC LIMIT ?`,
      ),
      ...values,
      userId,
      userId,
      ...(opts.cursor ? [opts.cursor] : []),
      opts.limit,
    );
  }

  /**
   * How many of the newest reactions to one account's messages the Reactions
   * tab reads at most, so a busy channel costs and shows a bounded amount.
   */
  static REACTIONS_WINDOW = 2000;

  /**
   * Other people's reactions to one account's messages, newest first, one
   * entry per message and emoji, `limit` entries after `cursor`.
   */
  reactions(userId: ID, opts: { after: ReactionCursor | null; limit: number }): ReactionActivity[] {
    const { after } = opts;
    const groups = reactionGroupRow.all(
      this.db.prepare(
        `WITH recent AS (
           SELECT r.message_id, r.emoji, r.created_at FROM ${REACTIONS_SHOWN}
           ORDER BY r.created_at DESC LIMIT ?
         )
         SELECT message_id, emoji, MAX(created_at) AS at FROM recent
         GROUP BY message_id, emoji
         ${after ? "HAVING (at, message_id, emoji) < (?, ?, ?)" : ""}
         ORDER BY at DESC, message_id DESC, emoji DESC LIMIT ?`,
      ),
      userId,
      SearchStore.REACTIONS_WINDOW,
      ...(after ? [after.at, after.messageId, after.emoji] : []),
      opts.limit,
    );
    if (groups.length === 0) return [];
    const ids = [...new Set(groups.map((g) => g.message_id))];
    const marks = ids.map(() => "?").join(",");
    const messages = new Map(
      this.store.messages
        .hydrate(
          messageRow.all(this.db.prepare(`SELECT * FROM messages WHERE id IN (${marks})`), ...ids),
        )
        .map((message) => [message.id, message]),
    );
    const reactors = new Map<string, ID[]>();
    for (const row of reactorRow.all(
      this.db.prepare(
        `SELECT r.message_id, r.emoji, r.user_id FROM reactions r
         WHERE r.message_id IN (${marks}) AND r.user_id != ? AND ${REACTOR_NOT_BLOCKED}
         ORDER BY r.created_at DESC`,
      ),
      ...ids,
      userId,
      userId,
    )) {
      const key = `${row.message_id}\n${row.emoji}`;
      const who = reactors.get(key);
      if (who) who.push(row.user_id);
      else reactors.set(key, [row.user_id]);
    }
    return groups.flatMap((group) => {
      const message = messages.get(group.message_id);
      const who = reactors.get(`${group.message_id}\n${group.emoji}`) ?? [];
      if (!message || who.length === 0) return [];
      return [
        {
          message,
          emoji: group.emoji,
          userIds: who.slice(0, REACTION_ACTIVITY_NAMES),
          count: who.length,
          at: group.at,
        },
      ];
    });
  }

  /** How many Reactions entries are newer than one account's mark, up to `UNSEEN_REACTIONS_MAX`. */
  unseenReactions(userId: ID): number {
    return countOf(
      this.db.prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM ${REACTIONS_SHOWN} AND r.created_at > ?
           GROUP BY r.message_id, r.emoji LIMIT ?
         )`,
      ),
      userId,
      this.reactionsSeenAt(userId),
      UNSEEN_REACTIONS_MAX,
    );
  }

  /**
   * How far one account has seen the reactions to its messages. An account
   * has seen everything from before it was made, such as reactions a Slack
   * import brought in with their old times.
   */
  reactionsSeenAt(userId: ID): number {
    return (
      seenRow.get(
        this.db.prepare(
          "SELECT MAX(reactions_seen_at, created_at) AS seen FROM users WHERE id = ?",
        ),
        userId,
      )?.seen ?? 0
    );
  }

  /**
   * Moves one account's mark to `upTo`, never back and never past now, and
   * tells its devices. Gives back where the mark is.
   */
  seeReactions(userId: ID, upTo?: number): number {
    const at = Math.min(upTo ?? Date.now(), Date.now());
    this.db
      .prepare("UPDATE users SET reactions_seen_at = MAX(reactions_seen_at, ?) WHERE id = ?")
      .run(at, userId);
    this.store.outbox.person(
      userId,
      () => ({
        type: "reactions.seen",
        seenAt: this.reactionsSeenAt(userId),
        unseen: this.unseenReactions(userId),
      }),
      { key: "reactions.seen" },
    );
    return this.reactionsSeenAt(userId);
  }

  /** Someone reacted to one of this account's messages, or took a reaction back. */
  reactionsChanged(authorId: ID): void {
    this.store.outbox.person(
      authorId,
      () => ({ type: "reactions.changed", unseen: this.unseenReactions(authorId) }),
      { key: "reactions.changed" },
    );
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

  /**
   * How fast age stops counting for a result by relevance: a message this
   * old gets half the boost of one sent now, and an old one almost none, so a
   * message sent now scores up to twice what an old one saying the same does.
   */
  static RANK_RECENT_MS = 30 * DAY;

  /** What being in the conversation adds to a result's score: a little, to break near ties. */
  static RANK_MINE = 1.2;

  /**
   * What a message found only by a file's name scores for its words, about
   * what a fairly common word said once in a message scores. The index holds
   * no file names, so there is nothing to weigh them by.
   */
  static RANK_NAME_ONLY = 1;

  /**
   * What every search keeps to, whatever its words: the modifiers
   * (from:/in:/has:/type:/before:/after:) as plain SQL, and what the reader
   * can see, which is never optional.
   */
  private filtersOf(userId: ID, query: ParsedSearch): Filter[] {
    const filters: Filter[] = [];
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
    filters.push([
      `(c.type = 'public' OR EXISTS (
         SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?
       ))`,
      userId,
    ]);
    return filters;
  }

  /**
   * Full-text search restricted to what the user can see, with modifier
   * filters applied as plain SQL, newest or oldest first. A message has every
   * free-text term, said or in a file's name; a query with only modifiers
   * skips FTS entirely.
   */
  search(
    userId: ID,
    query: ParsedSearch,
    limit: number,
    opts: { cursor?: ID; channelId?: ID; order?: SearchOrder } = {},
  ): Message[] {
    return this.store.messages.hydrate(this.searchRows(userId, query, limit, opts));
  }

  private searchRows(
    userId: ID,
    query: ParsedSearch,
    limit: number,
    opts: { cursor?: ID; channelId?: ID; order?: SearchOrder },
  ): MessageRow[] {
    // Oldest first is newest first turned round: every "before" is "after".
    const newestFirst = opts.order !== "oldest";
    const past = newestFirst ? "<" : ">";
    const from = newestFirst ? ">=" : "<=";
    const direction = newestFirst ? "DESC" : "ASC";
    const end = newestFirst ? "MIN" : "MAX";
    // Where the newest messages are counted from: the same page and channel.
    const scope: Filter[] = [];
    if (opts.cursor) scope.push([`m.id ${past} ?`, opts.cursor]);
    if (opts.channelId) scope.push(["m.channel_id = ?", opts.channelId]);
    const filters: Filter[] = [
      ["m.deleted_at IS NULL"],
      ...scope,
      ...this.filtersOf(userId, query),
    ];

    const page = (more: Filter[], count: number) => {
      const all = [...filters, ...more];
      return messageRow.all(
        this.db.prepare(
          `SELECT m.* FROM messages m
           JOIN channels c ON c.id = m.channel_id
           JOIN users u ON u.id = m.user_id
           WHERE ${all.map(([sql]) => sql).join(" AND ")}
           ORDER BY m.id ${direction} LIMIT ?`,
        ),
        ...all.flatMap(([, ...values]) => values),
        count,
      );
    };
    if (query.terms.length === 0) return page([], limit);

    const fts = matchText(query.terms, " ");
    const names = namesOf(query.terms);
    const namedSql = names
      ? `OR m.id IN (SELECT f.message_id FROM files f WHERE f.message_id IS NOT NULL
           AND ${names[0]})`
      : "";
    const namedValues = names ? names.slice(1) : [];
    const matching: Filter = [
      `(m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) ${namedSql})`,
      fts,
      ...namedValues,
    ];
    const many = this.matchesMany(fts);
    // The same matches as one list of rows, for a search that starts from
    // them (F13). Asked as "said, or named", SQLite reads the file names once
    // to pick the rows and again to check each one; read once into the list,
    // a word in a few hundred file names is found in half the time, and no
    // search measured is slower.
    const fromMatches: Filter = [
      `m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?
         ${
           names
             ? `UNION ALL SELECT named.rowid FROM files f CROSS JOIN messages named
                  ON named.id = f.message_id
                WHERE f.message_id IS NOT NULL AND ${names[0]}`
             : ""
         })`,
      fts,
      ...namedValues,
    ];
    // A word in few messages is found from its matches. A common one would
    // have every match read, joined and sorted for one page: 120,000 of them
    // for "the" in 200,000 messages. So the newest messages are walked first,
    // checked against only their own matches, and the older ones are read
    // from the matches only if the newest hold less than a page. Oldest
    // first walks the oldest the same way.
    if (!many) return page([fromMatches], limit);
    const window = windowRow.get(
      this.db.prepare(
        `SELECT ${end}(id) AS edge, ${end}(position) AS bound, COUNT(*) AS n FROM (
           SELECT m.id, m.rowid AS position FROM messages m
           ${scope.length > 0 ? `WHERE ${scope.map(([sql]) => sql).join(" AND ")}` : ""}
           ORDER BY m.id ${direction} LIMIT ?
         )`,
      ),
      ...scope.flatMap(([, ...values]) => values),
      SearchStore.SEARCH_WINDOW,
    )!;
    if (window.edge === null || window.bound === null) return [];
    // Every message from the edge on has a rowid on the same side of `bound`,
    // whatever order rowids were given in, so no match in the window is
    // missed. The unary plus keeps SQLite from starting at the matches instead.
    const near = page(
      [
        [
          `(+m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid ${from} ?)
            ${namedSql})`,
          fts,
          window.bound,
          ...namedValues,
        ],
        [`m.id ${from} ?`, window.edge],
      ],
      limit,
    );
    if (near.length === limit || window.n < SearchStore.SEARCH_WINDOW) return near;
    const far = page([matching, [`m.id ${past} ?`, window.edge]], limit - near.length);
    return [...near, ...far];
  }

  /** Whether more than SEARCH_FEW_MATCHES messages say what an FTS5 query asks for. */
  private matchesMany(fts: string): boolean {
    return (
      countOf(
        this.db.prepare(
          "SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages_fts WHERE messages_fts MATCH ? LIMIT ?)",
        ),
        fts,
        SearchStore.SEARCH_FEW_MATCHES + 1,
      ) > SearchStore.SEARCH_FEW_MATCHES
    );
  }

  /**
   * Search by relevance (K15): messages with every word first, then those
   * with only some. Within each, a message scores by FTS5's bm25() for its
   * words, raised for being recent (RANK_RECENT_MS) and a little for being in
   * a conversation the reader is in (RANK_MINE). Pages follow (score, id), so
   * no result shows twice or is skipped while the messages stay as they are.
   *
   * Scoring reads every match, so when there are more than
   * SEARCH_FEW_MATCHES, only the newest SEARCH_WINDOW messages are scored.
   * Older messages with every word follow those, newest first; older ones
   * with only some of the words are left out.
   */
  relevant(
    userId: ID,
    query: ParsedSearch,
    limit: number,
    opts: { cursor?: RankCursor; channelId?: ID } = {},
  ): { messages: Message[]; nextCursor: string | null } {
    const someToo = query.terms.length > 1;
    const start = opts.cursor ?? this.rankStart(query, someToo, opts.channelId);
    const found: { row: MessageRow; at: RankCursor }[] = [];
    for (const phase of [1, 2, 3] as const) {
      const want = limit + 1 - found.length;
      if (want <= 0) break;
      if (phase < start.phase || (phase === 2 && !start.allBounded) || (phase === 3 && !someToo))
        continue;
      const after: RankCursor =
        phase === start.phase ? start : { ...start, phase, score: null, id: null };
      if (phase === 2) {
        const rows = this.searchRows(userId, query, want, {
          cursor: after.id ?? after.edge!,
          channelId: opts.channelId,
        });
        found.push(...rows.map((row) => ({ row, at: { ...after, score: null, id: row.id } })));
      } else {
        const rows = this.rankRows(userId, query, after, want, opts.channelId);
        found.push(...rows.map((row) => ({ row, at: { ...after, score: row.score, id: row.id } })));
      }
    }
    const shown = found.slice(0, limit);
    return {
      messages: this.store.messages.hydrate(shown.map(({ row }) => row)),
      nextCursor: found.length > limit ? writeRankCursor(shown.at(-1)!.at) : null,
    };
  }

  /** Where a search by relevance starts: now, and whether there are too many matches to score. */
  private rankStart(query: ParsedSearch, someToo: boolean, channelId?: ID): RankCursor {
    const allMany = this.matchesMany(matchText(query.terms, " "));
    const someMany = someToo && (allMany || this.matchesMany(matchText(query.terms, " OR ")));
    const start: RankCursor = {
      now: Date.now(),
      edge: null,
      low: null,
      allBounded: false,
      someBounded: false,
      phase: 1,
      score: null,
      id: null,
    };
    if (!allMany && !someMany) return start;
    const window = windowRow.get(
      this.db.prepare(
        `SELECT MIN(id) AS edge, MIN(position) AS bound, COUNT(*) AS n FROM (
           SELECT m.id, m.rowid AS position FROM messages m
           ${channelId ? "WHERE m.channel_id = ?" : ""}
           ORDER BY m.id DESC LIMIT ?
         )`,
      ),
      ...(channelId ? [channelId] : []),
      SearchStore.SEARCH_WINDOW,
    )!;
    // Fewer messages than the window holds: every one is in it.
    if (window.n < SearchStore.SEARCH_WINDOW || window.edge === null || window.bound === null)
      return start;
    return {
      ...start,
      edge: window.edge,
      low: window.bound,
      allBounded: allMany,
      someBounded: someMany,
    };
  }

  /**
   * One run of results by relevance after `at`: every word (phase 1), or
   * some of them but not all (phase 3). A message found by a file's name has
   * every word.
   */
  private rankRows(userId: ID, query: ParsedSearch, at: RankCursor, count: number, channelId?: ID) {
    const all = matchText(query.terms, " ");
    const names = namesOf(query.terms);
    const bounded = at.phase === 1 ? at.allBounded : at.someBounded;
    // Every message in the window has a rowid of at least `low` (see searchRows).
    const near = bounded ? " AND rowid >= ?" : "";
    const nearValues = bounded ? [at.low!] : [];
    const sources: Filter[] =
      at.phase === 1
        ? [
            [
              `SELECT rowid AS position, bm25(messages_fts) AS weight FROM messages_fts
               WHERE messages_fts MATCH ?${near}`,
              all,
              ...nearValues,
            ],
            ...(names
              ? [
                  [
                    `SELECT named.rowid, NULL FROM files f CROSS JOIN messages named
                       ON named.id = f.message_id
                     WHERE f.message_id IS NOT NULL AND ${names[0]}${bounded ? " AND named.id >= ?" : ""}`,
                    ...names.slice(1),
                    ...(bounded ? [at.edge!] : []),
                  ] satisfies Filter,
                ]
              : []),
          ]
        : [
            [
              `SELECT rowid AS position, bm25(messages_fts) AS weight FROM messages_fts
               WHERE messages_fts MATCH ?${near} AND rowid NOT IN (
                 SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?${near})`,
              matchText(query.terms, " OR "),
              ...nearValues,
              all,
              ...nearValues,
            ],
          ];
    const filters: Filter[] = [["m.deleted_at IS NULL"], ...this.filtersOf(userId, query)];
    if (channelId) filters.push(["m.channel_id = ?", channelId]);
    if (bounded) filters.push(["m.id >= ?", at.edge!]);
    if (at.phase === 3 && names)
      filters.push([
        `m.id NOT IN (SELECT f.message_id FROM files f WHERE f.message_id IS NOT NULL AND ${names[0]})`,
        ...names.slice(1),
      ]);
    const after: Filter[] =
      at.id === null
        ? []
        : [["(score < ? OR (score = ? AND id < ?))", at.score!, at.score!, at.id]];
    const recent = SearchStore.RANK_RECENT_MS.toFixed(1);
    // Materialized: bm25() works only where SQLite reads the index itself,
    // and folded into the grouping below it would not be.
    return rankedRow.all(
      this.db.prepare(
        `WITH matched(position, weight) AS MATERIALIZED (
           ${sources.map(([sql]) => sql).join(" UNION ALL ")}
         ),
         found AS (SELECT position, MIN(weight) AS weight FROM matched GROUP BY position)
         SELECT * FROM (
           SELECT m.*,
             COALESCE(-found.weight, ${SearchStore.RANK_NAME_ONLY})
             * (1.0 + ${recent} / (${recent} + max(0, ? - m.created_at)))
             * CASE WHEN EXISTS (
                 SELECT 1 FROM channel_members mine
                 WHERE mine.channel_id = m.channel_id AND mine.user_id = ?
               ) THEN ${SearchStore.RANK_MINE} ELSE 1.0 END AS score
           FROM found
           JOIN messages m ON m.rowid = found.position
           JOIN channels c ON c.id = m.channel_id
           JOIN users u ON u.id = m.user_id
           WHERE ${filters.map(([sql]) => sql).join(" AND ")}
         ) ${after.length > 0 ? `WHERE ${after[0]![0]}` : ""}
         ORDER BY score DESC, id DESC LIMIT ?`,
      ),
      ...sources.flatMap(([, ...values]) => values),
      at.now,
      userId,
      ...filters.flatMap(([, ...values]) => values),
      ...after.flatMap(([, ...values]) => values),
      count,
    );
  }
}
