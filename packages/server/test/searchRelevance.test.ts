import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseSearchQuery, type Message } from "@ownbase/protocol";
import { openDb } from "../src/db.js";
import { Store } from "../src/store.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import {
  SearchStore,
  readRankCursor,
  writeRankCursor,
  type RankCursor,
} from "../src/search/store.js";

/**
 * Search by relevance (K15): messages with every word come before those with
 * some, then a better match, a newer one, and one in a conversation the reader
 * is in. Pages follow (score, id), so none shows twice or is skipped, also
 * where there are too many matches to score and only the newest are.
 */
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 25, 12);
const defaults = { few: SearchStore.SEARCH_FEW_MATCHES, window: SearchStore.SEARCH_WINDOW };

let directory: string;
let db: DatabaseSync;
let store: Store;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-search-relevance-"));
  db = openDb(join(directory, "workspace.db"));
  store = new Store(db);
});

afterEach(() => {
  SearchStore.SEARCH_FEW_MATCHES = defaults.few;
  SearchStore.SEARCH_WINDOW = defaults.window;
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function people() {
  const [ana, ben] = ["ana", "ben"].map((handle) =>
    store.people.create({
      handle,
      displayName: handle,
      passwordHash: "",
      salt: "",
      role: "member",
    }),
  );
  const room = (type: "public" | "private" | "dm", name: string, members: string[]) =>
    store.channels.create({ type, name, creatorId: members[0]!, memberIds: members }).id;
  return {
    ana: ana!.id,
    ben: ben!.id,
    room,
  };
}

let next = 0;
/** A message `ago` before NOW; ids follow time, as real ones do. */
function say(channelId: string, userId: string, text: string, ago: number, deleted = false) {
  const at = NOW - ago;
  const id = `M${String(at).padStart(14, "0")}${String(next++).padStart(5, "0")}`;
  db.prepare(
    `INSERT INTO messages (id, channel_id, user_id, text, seq, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, channelId, userId, text, next, at, deleted ? at : null);
  return id;
}

function attach(messageId: string, channelId: string, userId: string, name: string) {
  db.prepare(
    `INSERT INTO files (id, channel_id, user_id, message_id, name, mime, size, created_at)
     VALUES (?, ?, ?, ?, ?, 'application/pdf', 1, 0)`,
  ).run(`F${next++}`, channelId, userId, messageId, name);
}

/** One page by relevance, as of NOW. */
function ranked(reader: string, text: string, limit = 50, cursor?: string, channelId?: string) {
  return store.search.relevant(reader, parseSearchQuery(text, { timeZone: "UTC" }), limit, {
    cursor: cursor === undefined ? undefined : readRankCursor(cursor)!,
    channelId,
  });
}

function idsOf(reader: string, text: string, limit = 50, channelId?: string) {
  return ranked(reader, text, limit, undefined, channelId).messages.map((m) => m.id);
}

/** Every page, `size` at a time, following each page's cursor. */
function everyPage(reader: string, text: string, size: number, channelId?: string) {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 1000; pages++) {
    const page = ranked(reader, text, size, cursor, channelId);
    ids.push(...page.messages.map((m) => m.id));
    if (page.nextCursor === null) return ids;
    expect(page.messages).toHaveLength(size);
    cursor = page.nextCursor;
  }
  throw new Error("never ended");
}

describe("search by relevance", () => {
  beforeEach(() => {
    // Every first page measures age from NOW, not from when the test runs.
    const realNow = Date.now;
    Date.now = () => NOW;
    return () => {
      Date.now = realNow;
    };
  });

  it("puts a message with every word above a newer one with only some", () => {
    const { ana, room } = people();
    const engineering = room("public", "engineering", [ana]);
    for (let i = 0; i < 20; i++) say(engineering, ana, `filler ${i}`, (100 + i) * DAY);
    const checklist = say(
      engineering,
      ana,
      "Release checklist for 0.2: tag the release, build the installer",
      60 * DAY,
    );
    // Scored on its own, this one would win: short, the word three times, and new.
    const newer = say(engineering, ana, "Release, release, release!", 60_000);
    const other = say(engineering, ana, "Is the checklist pinned?", 2 * DAY);
    say(engineering, ana, "Lunch on Friday?", 0);

    const ids = idsOf(ana, "release checklist");
    expect(ids).toEqual([checklist, newer, other]);
    // Newest first finds only what has every word, as it always has.
    const parsed = parseSearchQuery("release checklist", { timeZone: "UTC" });
    expect(store.search.search(ana, parsed, 50).map((m) => m.id)).toEqual([checklist]);
  });

  it("breaks a tie by recency, then by the reader's own conversations", () => {
    const { ana, ben, room } = people();
    const mine = room("public", "mine", [ana]);
    const theirs = room("public", "theirs", [ben]);
    const old = say(mine, ana, "standup notes", 40 * DAY);
    const recent = say(mine, ana, "standup notes", 2 * DAY);
    const elsewhere = say(theirs, ben, "standup notes", 2 * DAY);
    // The same words, so the same bm25: the newer first, and of two as new,
    // the one in a conversation the reader is in.
    expect(idsOf(ana, "standup notes")).toEqual([recent, elsewhere, old]);
    expect(idsOf(ben, "standup notes")).toEqual([elsewhere, recent, old]);
  });

  it("puts a better match above a newer, weaker one", () => {
    const { ana, room } = people();
    const general = room("public", "general", [ana]);
    for (let i = 0; i < 30; i++) say(general, ana, `filler message ${i}`, (50 + i) * DAY);
    const strong = say(general, ana, "migration migration plan", 10 * DAY);
    const weak = say(
      general,
      ana,
      "a long message that mentions the migration once among many other words here",
      9 * DAY,
    );
    expect(idsOf(ana, "migration")).toEqual([strong, weak]);
  });

  it("finds a message by a file's name among those with every word", () => {
    const { ana, room } = people();
    const general = room("public", "general", [ana]);
    const said = say(general, ana, "the budget for q3", 5 * DAY);
    const named = say(general, ana, "see attached", 4 * DAY);
    attach(named, general, ana, "Q3 budget.pdf");
    const some = say(general, ana, "budget meeting moved", DAY);
    const ids = idsOf(ana, "budget q3");
    expect(ids.slice(0, 2).sort()).toEqual([said, named].sort());
    expect(ids[2]).toBe(some);
    expect(ids).toHaveLength(3);
  });

  it("never returns a deleted message or one from a conversation the reader cannot see", () => {
    const { ana, ben, room } = people();
    const general = room("public", "general", [ana, ben]);
    const hidden = room("private", "hidden", [ben]);
    const dm = room("dm", "", [ben, ana]);
    const shown = say(general, ben, "roadmap draft", DAY);
    say(general, ben, "roadmap draft final", DAY, true);
    say(hidden, ben, "roadmap draft secret", DAY);
    const direct = say(dm, ben, "roadmap", DAY);
    expect(idsOf(ana, "roadmap draft").sort()).toEqual([shown, direct].sort());
    expect(idsOf(ana, "roadmap draft", 50, general)).toEqual([shown]);
  });

  it("finds words inside Chinese and Japanese text, as newest first does", () => {
    const { ana, room } = people();
    const general = room("public", "general", [ana]);
    const chinese = say(general, ana, "我们明天部署新版本", 2 * DAY);
    const japanese = say(general, ana, "明日新しいバージョンをデプロイします", DAY);
    say(general, ana, "部门会议", 0);
    expect(idsOf(ana, "部署")).toEqual([chinese]);
    expect(idsOf(ana, "デプロイ")).toEqual([japanese]);
    // Two runs: the one with both first, then one with either.
    const ids = idsOf(ana, "部署 版本");
    expect(ids).toEqual([chinese]);
    expect(idsOf(ana, "部署 明日")).toEqual(expect.arrayContaining([chinese, japanese]));
  });

  describe("pages", () => {
    /** Messages enough for every run, written in an order their ids do not follow. */
    function seed() {
      const { ana, ben, room } = people();
      const general = room("public", "general", [ana, ben]);
      const small = room("public", "small", [ben]);
      const hidden = room("private", "hidden", [ben]);
      const where = [general, general, small, hidden];
      const order = Array.from({ length: 400 }, (_, i) => i);
      let rng = 9;
      const random = () => (rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      for (const n of order) {
        const words = [`message ${n}`];
        if (n % 3 !== 0) words.push("common");
        if (n % 4 === 0) words.push("deploy");
        if (n % 11 === 0) words.push("deploy deploy");
        const channel = where[n % where.length]!;
        const id = say(channel, n % 2 ? ana : ben, words.join(" "), (400 - n) * 3_600_000);
        if (n % 13 === 0) attach(id, channel, ana, `common deploy ${n}.pdf`);
      }
      return { ana, ben, small };
    }

    /** Every match one query over all of them finds, by the rules, in no order. */
    function expected(reader: string, text: string) {
      const page = idsOf(reader, text, 10_000);
      expect(new Set(page).size).toBe(page.length);
      return page;
    }

    it("never repeat or skip a result, whatever their size", () => {
      const { ana, ben, small } = seed();
      for (const reader of [ana, ben])
        for (const text of ["common", "deploy", "common deploy", "deploy common", "nothing"]) {
          const all = expected(reader, text);
          for (const size of [1, 7, 50])
            expect(everyPage(reader, text, size), `${text}, ${size} a page`).toEqual(all);
          expect(everyPage(reader, text, 5, small), `${text} in one channel`).toEqual(
            idsOf(reader, text, 10_000, small),
          );
        }
    });

    it("score only the newest when there are too many matches, and still never repeat or skip", () => {
      const { ana, ben } = seed();
      const unbounded = new Set(expected(ana, "common deploy"));
      SearchStore.SEARCH_FEW_MATCHES = 10;
      SearchStore.SEARCH_WINDOW = 60;
      for (const reader of [ana, ben])
        for (const text of ["common", "deploy", "common deploy"]) {
          const all = expected(reader, text);
          for (const size of [1, 7, 50])
            expect(everyPage(reader, text, size), `${text}, ${size} a page`).toEqual(all);
        }
      // Every message with both words is still found, the older ones after
      // the newest; only older ones with one word are left out.
      const bounded = expected(ana, "common deploy");
      const both = store.search
        .search(ana, parseSearchQuery("common deploy", { timeZone: "UTC" }), 10_000)
        .map((m) => m.id);
      expect(bounded.slice(0, both.length).sort()).toEqual([...both].sort());
      expect(bounded.length).toBeLessThan(unbounded.size);
      for (const id of bounded) expect(unbounded.has(id)).toBe(true);
    });

    it("hold still between pages, measured from when the first was asked", () => {
      const { ana } = seed();
      const all = idsOf(ana, "common deploy", 20);
      const first = ranked(ana, "common deploy", 10);
      Date.now = () => NOW + 365 * DAY;
      const second = ranked(ana, "common deploy", 10, first.nextCursor!);
      expect([...first.messages, ...second.messages].map((m) => m.id)).toEqual(all);
    });
  });
});

describe("a cursor by relevance", () => {
  const at: RankCursor = {
    now: NOW,
    edge: "M0001",
    low: 12,
    allBounded: true,
    someBounded: false,
    phase: 3,
    score: 1.2345678901234567e-7,
    id: "M0002",
  };

  it("reads back exactly what was written", () => {
    expect(readRankCursor(writeRankCursor(at))).toEqual(at);
    const start = { ...at, edge: null, low: null, allBounded: false, phase: 1 as const };
    expect(readRankCursor(writeRankCursor({ ...start, score: null, id: null }))).toEqual({
      ...start,
      score: null,
      id: null,
    });
  });

  it("is refused when it is not one", () => {
    for (const text of [
      "M0002",
      "r~x~~~00~1~~",
      "r~1~~~00~4~~",
      "r~1~~~00~2~~M1",
      "r~1~~~10~1~~",
      "r~1~~~00~1~1~",
      "r~1~~~00~1~NaN~M1",
      "r~1~a b~3~10~1~~",
    ])
      expect(readRankCursor(text), text).toBeNull();
    expect(readRankCursor("r~1~~~00~1~~")).not.toBeNull();
  });
});

describe("the search route's order", () => {
  let server: WorkspaceServer;
  let base: string;
  let token: string;

  beforeEach(async () => {
    server = await createWorkspaceServer({
      dataDir: ":memory:",
      host: "127.0.0.1",
      port: 0,
      mdns: false,
    });
    base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
    });
    token = ((await res.json()) as { token: string }).token;
  });

  afterEach(async () => {
    await server.stop();
  });

  async function post(text: string) {
    const channelId = server.store.channels.byName("general")!.id;
    const res = await fetch(`${base}/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return ((await res.json()) as { message: Message }).message.id;
  }

  async function search(params: Record<string, string>) {
    const res = await fetch(`${base}/api/search?${new URLSearchParams({ tz: "UTC", ...params })}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return {
      status: res.status,
      body: (await res.json()) as {
        messages: Message[];
        nextCursor: string | null;
        error?: string;
      },
    };
  }

  it("is newest first unless asked otherwise, and best match first when asked", async () => {
    const checklist = await post("Release checklist for 0.2: tag the release");
    const notes = await post("The release notes are up");
    const pinned = await post("Is the checklist pinned?");
    const ids = async (params: Record<string, string>) =>
      (await search(params)).body.messages.map((m) => m.id);

    expect(await ids({ q: "release" })).toEqual([notes, checklist]);
    expect(await ids({ q: "release", sort: "oldest" })).toEqual([checklist, notes]);
    expect(await ids({ q: "release checklist", sort: "newest" })).toEqual([checklist]);
    const best = await ids({ q: "release checklist", sort: "relevant" });
    expect(best[0]).toBe(checklist);
    expect(best.slice(1).sort()).toEqual([notes, pinned].sort());
    // Filters alone have nothing to rank by: newest first.
    expect(await ids({ q: "from:@owner", sort: "relevant" })).toEqual(
      expect.arrayContaining([pinned, notes, checklist]),
    );
    expect((await ids({ q: "from:@owner", sort: "relevant" })).slice(0, 3)).toEqual([
      pinned,
      notes,
      checklist,
    ]);
    expect((await search({ q: "release", sort: "sideways" })).status).toBe(400);
  });

  it("pages by the cursor it gives, and refuses one it did not", async () => {
    for (let i = 0; i < 5; i++) await post(`release ${i}`);
    await post("release checklist");
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await search({
        q: "release checklist",
        sort: "relevant",
        limit: "2",
        ...(cursor ? { cursor } : {}),
      });
      expect(page.status).toBe(200);
      seen.push(...page.body.messages.map((m) => m.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);

    const refused = await search({ q: "release checklist", sort: "relevant", cursor: seen[0]! });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("invalid_search_cursor");
  });
});
