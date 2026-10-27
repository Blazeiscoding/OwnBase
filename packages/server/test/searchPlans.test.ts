import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { FILE_TYPE_MATCH, parseSearchQuery } from "@ownbase/protocol";
import { openDb } from "../src/db.js";
import { Store } from "../src/store.js";

/**
 * A search for a word in many messages walks the newest first, and one for a
 * rare word starts from its matches (OPT-11). Whichever way a search goes, a
 * page must hold exactly what one query over every match says, in the same
 * order, page after page.
 *
 * Messages are written in an order their ids do not follow, so the rowids the
 * walk bounds its matches by disagree with the ids it pages by, and the walk
 * and the point past which it gives up are made small enough to be crossed.
 */
const statics = Store as unknown as { SEARCH_FEW_MATCHES: number; SEARCH_WINDOW: number };
const defaults = { few: statics.SEARCH_FEW_MATCHES, window: statics.SEARCH_WINDOW };

let directory: string;
let db: DatabaseSync;
let store: Store;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-search-plans-"));
  db = openDb(join(directory, "workspace.db"));
  store = new Store(db);
  statics.SEARCH_FEW_MATCHES = 8;
  statics.SEARCH_WINDOW = 40;
});

afterEach(() => {
  statics.SEARCH_FEW_MATCHES = defaults.few;
  statics.SEARCH_WINDOW = defaults.window;
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

/** Every match, newest first, as one query over all of them reads it. */
function everyMatch(reader: string, text: string, opts: { channelId?: string } = {}): string[] {
  const q = parseSearchQuery(text, { timeZone: "UTC" });
  const where = ["m.deleted_at IS NULL"];
  const params: (string | number)[] = [];
  if (opts.channelId) where.push("m.channel_id = ?") && params.push(opts.channelId);
  if (q.terms.length) {
    // Said in the message, or every word with a letter or digit in it in the
    // name of one file attached to it.
    const named = q.terms.filter((t) => /[\p{L}\p{N}]/u.test(t));
    where.push(
      `(m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)
        ${named.length ? `OR m.id IN (SELECT message_id FROM files WHERE ${named.map(() => "instr(lower(name), ?) > 0").join(" AND ")})` : ""})`,
    );
    params.push(q.terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" "));
    params.push(...named.map((t) => t.toLowerCase()));
  }
  if (q.types.length) {
    const kinds = q.types.flatMap((type) => [
      ...FILE_TYPE_MATCH[type].mime.map((mime) => ["lower(f.mime) LIKE ?", mime] as const),
      ...FILE_TYPE_MATCH[type].ext.map((ext) => ["lower(f.name) LIKE ?", `%.${ext}`] as const),
    ]);
    where.push(
      `EXISTS (SELECT 1 FROM files f WHERE f.message_id = m.id AND (${kinds.map(([sql]) => sql).join(" OR ")}))`,
    );
    params.push(...kinds.map(([, value]) => value));
  }
  if (q.from.length) where.push("u.handle = ?") && params.push(q.from[0]!);
  if (q.in.length) where.push("c.name = ?") && params.push(q.in[0]!);
  if (q.has.includes("link")) where.push("m.text LIKE '%https://%'");
  if (q.before !== null) where.push("m.created_at < ?") && params.push(q.before);
  if (q.after !== null) where.push("m.created_at >= ?") && params.push(q.after);
  where.push(
    "(c.type = 'public' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?))",
  );
  params.push(reader);
  return (
    db
      .prepare(
        `SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id
         JOIN users u ON u.id = m.user_id WHERE ${where.join(" AND ")} ORDER BY m.id DESC`,
      )
      .all(...params) as { id: string }[]
  ).map((r) => r.id);
}

/** Every page the store gives, `size` at a time, as the route asks for them. */
function everyPage(reader: string, text: string, size: number, opts: { channelId?: string } = {}) {
  const parsed = parseSearchQuery(text, { timeZone: "UTC" });
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 1000; pages++) {
    const page = store.searchMessages(reader, parsed, size, { ...opts, cursor });
    ids.push(...page.map((m) => m.id));
    if (page.length < size) return ids;
    cursor = page.at(-1)!.id;
  }
  throw new Error("never ended");
}

function seed() {
  const people = ["ana", "ben", "cai"].map((handle) =>
    store.createUser({ handle, displayName: handle, passwordHash: "", salt: "", role: "member" }),
  );
  const ana = people[0]!;
  const ben = people[1]!;
  const general = store.createChannel({
    type: "public",
    name: "general",
    creatorId: ana.id,
    memberIds: [ana.id],
  });
  const small = store.createChannel({
    type: "public",
    name: "small",
    creatorId: ana.id,
    memberIds: [ana.id],
  });
  const team = store.createChannel({
    type: "private",
    name: "team",
    creatorId: ana.id,
    memberIds: [ana.id, ben.id],
  });
  const hidden = store.createChannel({
    type: "private",
    name: "hidden",
    creatorId: ben.id,
    memberIds: [ben.id],
  });
  const channels = [general.id, general.id, general.id, small.id, team.id, hidden.id];
  // Ids in time order, written in an order they do not follow.
  const order = Array.from({ length: 600 }, (_, i) => i);
  let rng = 3;
  const random = () => (rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const insert = db.prepare(
    `INSERT INTO messages (id, channel_id, user_id, text, seq, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const attach = db.prepare(
    `INSERT INTO files (id, channel_id, user_id, message_id, name, mime, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
  );
  for (const n of order) {
    const words = [`message ${n}`];
    if (n % 5 !== 0) words.push("common");
    if (n % 9 === 0) words.push("sometimes");
    if (n % 97 === 0) words.push("rare");
    if (n % 7 === 0) words.push("https://example.com");
    insert.run(
      `M${String(n).padStart(6, "0")}`,
      channels[n % channels.length]!,
      people[n % 3]!.id,
      words.join(" "),
      n + 1,
      Date.UTC(2026, 0, 1) + n * 3_600_000,
      n % 23 === 0 ? 1 : null,
    );
    // Files whose names say what their messages do not (IMP-02): one sent as
    // anything, known for a spreadsheet only by its name; one with a common
    // word in it, for the walk through the newest; and one that "100%" and
    // "photo_" find only if % and _ are taken as wildcards.
    const id = `M${String(n).padStart(6, "0")}`;
    const channel = channels[n % channels.length]!;
    const user = people[n % 3]!.id;
    if (n % 11 === 0) attach.run(`F${n}a`, channel, user, id, `Budget ${n}.PDF`, "application/pdf");
    if (n % 13 === 0) attach.run(`F${n}b`, channel, user, id, `photo_${n}.png`, "image/png");
    if (n % 17 === 0)
      attach.run(
        `F${n}c`,
        channel,
        user,
        id,
        "100% common budget.xlsx",
        "application/octet-stream",
      );
    if (n % 19 === 0) attach.run(`F${n}d`, channel, user, id, `photos-1000-${n}.csv`, "text/csv");
  }
  return { ana, ben, small };
}

// Exhaustive by design: every query, both readers, pages of 1, 7 and 50, so
// thousands of searches. 1.7 s alone; on CI, sharing two workers with the
// other packages' tests, it took 6.4 s, past Vitest's 5 s default.
const EXHAUSTIVE_MS = 30_000;

describe("a search, whichever way it goes", () => {
  it(
    "pages through exactly what one query over every match says",
    () => {
      const { ana, ben, small } = seed();
      const queries = [
        "common",
        "sometimes",
        "rare",
        "nothing-has-this",
        "common sometimes",
        "common in:#small",
        "common from:@ben",
        "common has:link",
        "common before:2026-01-10",
        "common after:2026-01-20",
        "sometimes after:2026-01-05 before:2026-01-25",
        "from:@cai",
        "budget",
        "BUDGET pdf",
        "budget common",
        "100%",
        "photo_",
        "type:image",
        "type:spreadsheet budget",
        "type:pdf type:image from:@ana",
        "common type:pdf",
      ];
      for (const reader of [ana.id, ben.id]) {
        for (const text of queries) {
          const expected = everyMatch(reader, text);
          for (const size of [1, 7, 50]) {
            expect(everyPage(reader, text, size), `${text}, ${size} a page`).toEqual(expected);
          }
          expect(
            everyPage(reader, text, 7, { channelId: small.id }),
            `${text} in one channel`,
          ).toEqual(everyMatch(reader, text, { channelId: small.id }));
        }
      }
      // A file's name found messages that do not say it.
      expect(everyMatch(ana.id, "budget").length).toBeGreaterThan(0);
      expect(everyMatch(ana.id, "common")).toContain("M000085");
      // Both ways were taken: a common word walked the newest, and the walk
      // ran out of window and read older ones from the matches.
      expect(everyMatch(ana.id, "common").length).toBeGreaterThan(statics.SEARCH_WINDOW);
      expect(everyMatch(ana.id, "rare").length).toBeLessThanOrEqual(statics.SEARCH_FEW_MATCHES);
    },
    EXHAUSTIVE_MS,
  );

  it("never returns a message from a conversation the reader cannot see", () => {
    const { ana } = seed();
    const hidden = db.prepare("SELECT id FROM channels WHERE name = 'hidden'").get() as {
      id: string;
    };
    const parsed = parseSearchQuery("common", { timeZone: "UTC" });
    const found = store.searchMessages(ana.id, parsed, 1000);
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((m) => m.channelId === hidden.id)).toBe(false);
  });

  it("still finds what is there with the defaults", () => {
    statics.SEARCH_FEW_MATCHES = defaults.few;
    statics.SEARCH_WINDOW = defaults.window;
    const { ana } = seed();
    expect(everyPage(ana.id, "common", 20)).toEqual(everyMatch(ana.id, "common"));
  });
});

/**
 * The rest of what a search must agree on, with no more than a few matches
 * (F13): direct messages and a public channel the reader is not in, a
 * message whose words are split between two files, a file on no message or
 * on a deleted one, and words that are not plain ASCII: accents, other
 * scripts, emoji, %, _, \, quotes and punctuation alone.
 */
function seedMatrix() {
  const [ana, ben, cai] = ["ana", "ben", "cai"].map((handle) =>
    store.createUser({ handle, displayName: handle, passwordHash: "", salt: "", role: "member" }),
  );
  const room = (type: "public" | "private" | "dm", name: string, members: string[]) =>
    store.createChannel({ type, name, creatorId: members[0]!, memberIds: members }).id;
  const where = {
    general: room("public", "general", [ana!.id, ben!.id, cai!.id]),
    lobby: room("public", "lobby", [cai!.id]),
    team: room("private", "team", [ana!.id, ben!.id]),
    hidden: room("private", "hidden", [ben!.id]),
    anaBen: room("dm", "", [ana!.id, ben!.id]),
    benCai: room("dm", "", [ben!.id, cai!.id]),
  };
  const by = { ana: ana!.id, ben: ben!.id, cai: cai!.id };
  type Entry = [keyof typeof where, keyof typeof by, string, string[], boolean?];
  const entries: Entry[] = [
    ["general", "ana", "café au lait", ["Résumé Café.pdf"]],
    ["general", "ben", "CAFÉ CLOSED", []],
    ["lobby", "cai", "budget meeting", ["Q3 budget.xlsx"]],
    ["lobby", "cai", "nothing here", ["budget.xlsx", "contract.pdf"]],
    ["general", "ana", "plain words", ["budget contract.pdf"]],
    ["team", "ben", "日本語のテキスト", ["日本語.txt"]],
    ["hidden", "ben", "secret budget", ["budget secret.pdf"]],
    ["anaBen", "ben", "dm budget plan", ["dm budget.pdf"]],
    ["benCai", "cai", "other dm budget", ["other budget.pdf"]],
    ["general", "ana", "50% off sale", ["50% off.pdf"]],
    ["general", "ben", "under_score name", ["under_score.txt"]],
    ["general", "cai", "back\\slash path", ["C:\\back\\slash.txt"]],
    ["general", "ana", 'say "quoted" words', ['"quoted".txt']],
    ["general", "ben", "emoji party 🎉", ["party 🎉.png"]],
    ["general", "ana", "deleted budget", ["deleted budget.pdf"], true],
    ["general", "ben", "dots... and more", ["v1.2.3.zip"]],
    ["team", "ana", "https://example.com/budget", ["budget link.txt"]],
  ];
  // Enough of one word that a search for it walks the newest instead.
  for (let i = 0; i < 30; i++)
    entries.push(["general", i % 2 ? "ana" : "ben", `filler common ${i}`, []]);
  // Ids in time order, written in an order they do not follow.
  const order = entries.map((_, i) => i);
  let rng = 5;
  const random = () => (rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const insert = db.prepare(
    `INSERT INTO messages (id, channel_id, user_id, text, seq, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const attach = db.prepare(
    `INSERT INTO files (id, channel_id, user_id, message_id, name, mime, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
  );
  const mime = (name: string) =>
    name.endsWith(".pdf") ? "application/pdf" : name.endsWith(".png") ? "image/png" : "text/plain";
  for (const n of order) {
    const [channel, author, text, files, deleted] = entries[n]!;
    const id = `M${String(n).padStart(6, "0")}`;
    insert.run(
      id,
      where[channel],
      by[author],
      text,
      n + 1,
      Date.UTC(2026, 0, 1) + n * 3_600_000,
      deleted ? 1 : null,
    );
    files.forEach((name, i) =>
      attach.run(`F${n}-${i}`, where[channel], by[author], id, name, mime(name)),
    );
  }
  // Uploaded and never sent: on no message, so no search finds it.
  attach.run("F-unsent", where.general, by.ana, null, "budget unsent.pdf", "application/pdf");
  return { ...by, where };
}

describe("a search with few matches, against every case (F13)", () => {
  it(
    "pages through exactly what one query over every match says",
    () => {
      const { ana, ben, cai, where } = seedMatrix();
      const queries = [
        "budget",
        "BUDGET",
        "budget contract",
        "contract budget",
        "café",
        "CAFÉ",
        "cafe",
        "résumé",
        "日本語",
        "🎉",
        "party",
        "50%",
        "%",
        "under_score",
        "_",
        "back\\slash",
        "\\",
        '"quoted"',
        "quoted",
        "...",
        "v1.2.3",
        "budget has:link",
        "budget has:file",
        "budget type:pdf",
        "budget from:@cai",
        "budget in:#lobby",
        "budget before:2026-01-01T05:00",
        "budget after:2026-01-01",
        "deleted",
        "unsent",
        "secret",
        "dm",
        "common",
        "common budget",
        "nothing-has-this",
      ];
      for (const reader of [ana, ben, cai]) {
        for (const text of queries) {
          const expected = everyMatch(reader, text);
          for (const size of [1, 3, 50])
            expect(everyPage(reader, text, size), `${text} for ${reader}, ${size} a page`).toEqual(
              expected,
            );
          for (const channelId of [where.general, where.anaBen])
            expect(everyPage(reader, text, 2, { channelId }), `${text} in one channel`).toEqual(
              everyMatch(reader, text, { channelId }),
            );
        }
      }
      // What the cases are for, said outright.
      const found = (reader: string, text: string) => everyMatch(reader, text);
      expect(found(ana, "budget contract")).toEqual(["M000004"]);
      expect(found(ana, "budget")).toContain("M000007");
      expect(found(cai, "budget")).not.toContain("M000007");
      expect(found(cai, "budget")).toContain("M000008");
      expect(found(ana, "budget")).not.toContain("M000008");
      expect(found(ana, "budget")).toContain("M000002");
      for (const reader of [ana, ben, cai]) {
        expect(found(reader, "budget")).not.toContain("M000014");
        expect(found(reader, "unsent")).toEqual([]);
      }
      expect(found(ana, "secret")).toEqual([]);
      expect(found(ben, "secret")).toEqual(["M000006"]);
      expect(found(ana, "50%")).toEqual(["M000009"]);
      expect(found(ana, "_")).toEqual([]);
      expect(found(ana, "common").length).toBeGreaterThan(statics.SEARCH_FEW_MATCHES);
    },
    EXHAUSTIVE_MS,
  );
});
