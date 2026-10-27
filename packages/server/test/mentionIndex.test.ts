import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb, openDbAtVersion } from "../src/db.js";
import { Store } from "../src/store.js";

/**
 * Unread mention counts and the Activity mentions list are read from
 * `message_mentions` (v31) rather than from every message's text. Whatever
 * happens to a message, they must say exactly what the text rule says: a
 * message names X when its text holds `<@X>`, and the whole room with
 * `<!here>`, `<!channel>` or `<!everyone>`, which counts in a channel but not
 * in a DM.
 */
const statics = Store as unknown as { UNREAD: string; MENTIONS_ME: string };

/** The count straight from the text, as it was computed before v31. */
function countsFromText(db: DatabaseSync, userId: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT m.channel_id, COUNT(*) AS n FROM messages m
       JOIN channels c ON c.id = m.channel_id
       JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?
       WHERE m.user_id != ? AND m.deleted_at IS NULL AND ${statics.MENTIONS_ME}
       AND ${statics.UNREAD}
       AND (m.thread_root_id IS NULL OR EXISTS (
         SELECT 1 FROM messages root WHERE root.id = m.thread_root_id AND root.deleted_at IS NULL))
       GROUP BY m.channel_id`,
    )
    .all(userId, userId, `<@${userId}>`) as { channel_id: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.channel_id, r.n]));
}

/** The Activity mentions list straight from the text. */
function mentionsFromText(db: DatabaseSync, userId: string): string[] {
  return (
    db
      .prepare(
        `SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id
         JOIN channel_members cm ON cm.channel_id = c.id
         WHERE cm.user_id = ? AND m.user_id != ? AND m.deleted_at IS NULL AND ${statics.MENTIONS_ME}
         AND (m.thread_root_id IS NULL OR EXISTS (
           SELECT 1 FROM messages root WHERE root.id = m.thread_root_id AND root.deleted_at IS NULL))
         ORDER BY m.id DESC`,
      )
      .all(userId, userId, `<@${userId}>`) as { id: string }[]
  ).map((r) => r.id);
}

let db: DatabaseSync;
let store: Store;

const leftovers = () =>
  db
    .prepare(
      `SELECT COUNT(*) AS n FROM message_mentions mm
       LEFT JOIN messages m ON m.id = mm.message_id
       WHERE m.id IS NULL OR m.deleted_at IS NOT NULL`,
    )
    .get();

beforeEach(() => {
  db = openDb(":memory:");
  store = new Store(db);
  db.exec(`
    INSERT INTO users (id, handle, display_name, password_hash, salt, created_at) VALUES
      ('U1', 'one', 'One', '', '', 0), ('U2', 'two', 'Two', '', '', 0), ('U3', 'three', 'Three', '', '', 0);
    INSERT INTO channels (id, type, name, creator_id, created_at) VALUES
      ('C1', 'public', 'general', 'U1', 0), ('C2', 'private', 'plans', 'U1', 0),
      ('D1', 'dm', '', 'U1', 0);
  `);
  for (const [channel, users] of [
    ["C1", ["U1", "U2", "U3"]],
    ["C2", ["U1", "U2"]],
    ["D1", ["U1", "U2"]],
  ] as const) {
    for (const user of users) store.addMember(channel, user);
  }
});

afterEach(() => db.close());

describe("mentions read from who each message names", () => {
  it("agree with the text through sends, replies, edits, deletions, reads and purges", () => {
    let rng = 7;
    // The high bits: an LCG's low bits repeat too soon to reach every choice.
    const random = (n: number) => {
      rng = (rng * 1103515245 + 12345) % 2 ** 31;
      return Math.floor((rng / 2 ** 31) * n);
    };
    const pickOne = <T>(values: readonly T[]) => values[random(values.length)]!;
    const texts = [
      "plain words",
      "<@U1> look",
      "<@U2> and <@U1>",
      "<!here> standup",
      "<!channel> and <@U1>",
      "<!everyone>",
      "`<@U1>` in code",
      "<@<@U1> doubled mark",
      "<@U1x> someone else",
      "<@U1><@U1> twice",
      "<@U3>",
    ];
    const live: { id: string; channel: string }[] = [];
    let seq = 0;
    let clock = 1_000;
    const done = { sent: 0, edited: 0, deleted: 0, read: 0, threadRead: 0, purged: 0 };
    for (let step = 0; step < 400; step++) {
      const action = random(10);
      if (action < 5 || live.length === 0) {
        const channel = pickOne(["C1", "C2", "D1"] as const);
        const roots = live.filter((m) => m.channel === channel);
        const threadRootId = roots.length && random(3) === 0 ? pickOne(roots).id : null;
        const author = pickOne(channel === "C1" ? ["U1", "U2", "U3"] : ["U1", "U2"]);
        const message = store.createMessage({
          channelId: channel,
          userId: author,
          text: pickOne(texts),
          threadRootId: threadRootId,
          nonce: null,
          broadcast: random(4) === 0,
        });
        store.stampMessageSeq(message.id, channel, ++seq);
        db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(clock++, message.id);
        if (!threadRootId) live.push({ id: message.id, channel });
        done.sent++;
      } else if (action < 7) {
        store.editMessage(pickOne(live).id, pickOne(texts));
        done.edited++;
      } else if (action < 8) {
        const doomed = live.splice(random(live.length), 1)[0]!;
        store.deleteMessage(doomed.id);
        done.deleted++;
      } else if (action < 9) {
        store.markRead(pickOne(["C1", "C2", "D1"]), pickOne(["U1", "U2"]), random(seq + 1));
        done.read++;
      } else {
        const root = pickOne(live);
        store.markThreadRead("U1", root.id, random(seq + 1));
        done.threadRead++;
      }
      if (step % 25 === 24) {
        // Retention takes the oldest away; their mentions go with them.
        const before = clock - 150;
        done.purged += store.purgeMessagesBefore(before).messages;
        for (let i = live.length - 1; i >= 0; i--) {
          if (!db.prepare("SELECT 1 FROM messages WHERE id = ?").get(live[i]!.id))
            live.splice(i, 1);
        }
      }
      for (const user of ["U1", "U2", "U3"]) {
        expect(store.unreadMentionCounts(user), `counts for ${user} at step ${step}`).toEqual(
          countsFromText(db, user),
        );
      }
      // Nothing is left over for a message deleted or purged.
      expect(leftovers(), `leftover mentions at step ${step}`).toEqual({ n: 0 });
    }
    // Every kind of change happened, several times over.
    for (const [kind, times] of Object.entries(done)) expect(times, kind).toBeGreaterThan(10);
    for (const user of ["U1", "U2", "U3"]) {
      const listed = store
        .activityMessages(user, { mode: "mentions", limit: 1000 })
        .map((m) => m.id);
      expect(listed).toEqual(mentionsFromText(db, user));
    }
  });

  it("pages the Activity mentions list by its cursor, each message once", () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const message = store.createMessage({
        channelId: "C1",
        userId: "U2",
        // Named directly and as the whole room: still one entry.
        text: `<@U1> <!here> number ${i}`,
        threadRootId: null,
        nonce: null,
      });
      store.stampMessageSeq(message.id, "C1", i + 1);
      ids.push(message.id);
    }
    const first = store.activityMessages("U1", { mode: "mentions", limit: 4 }).map((m) => m.id);
    const second = store
      .activityMessages("U1", { mode: "mentions", limit: 4, cursor: first.at(-1)! })
      .map((m) => m.id);
    // Newest id first, as Activity pages, whatever order they were created in.
    expect([...first, ...second]).toEqual([...ids].sort().reverse());
  });

  it("counts from the mentions index, not by reading every message", () => {
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT m.channel_id FROM message_mentions mm
           JOIN channel_members cm ON cm.channel_id = mm.channel_id AND cm.user_id = ?
           JOIN channels c ON c.id = mm.channel_id
           JOIN messages m ON m.id = mm.message_id
           WHERE (mm.user_id = ? OR (mm.user_id = '!' AND c.type IN ('public', 'private')))`,
        )
        .all("U1", "U1") as { detail: string }[]
    )
      .map((r) => r.detail)
      .join("; ");
    expect(plan).toContain("idx_message_mentions_user");
    expect(plan).not.toMatch(/SCAN m\b/);
  });
});

describe("upgrading to the mentions index", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ownbase-mention-index-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fills it from every message's text by the same rule", () => {
    const file = join(dir, "workspace.db");
    const older = openDbAtVersion(file, 30);
    older.exec(`
      INSERT INTO users (id, handle, display_name, password_hash, salt, created_at) VALUES
        ('U1', 'one', 'One', '', '', 0), ('U2', 'two', 'Two', '', '', 0);
      INSERT INTO channels (id, type, name, creator_id, created_at) VALUES
        ('C1', 'public', 'general', 'U1', 0), ('D1', 'dm', '', 'U1', 0);
      INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES
        ('C1', 'U1', 0), ('C1', 'U2', 0), ('D1', 'U1', 0), ('D1', 'U2', 0);
    `);
    const insert = older.prepare(
      `INSERT INTO messages (id, channel_id, user_id, text, seq, created_at, deleted_at)
       VALUES (?, ?, 'U2', ?, ?, 0, ?)`,
    );
    const cases: [string, string, string, number | null][] = [
      ["M01", "C1", "<@U1> hello", null],
      ["M02", "C1", "<@<@U1> doubled mark", null],
      ["M03", "C1", "`<@U1>` in code", null],
      ["M04", "C1", "<@U1><@U1> twice", null],
      ["M05", "C1", "<!here> and <@U1>", null],
      ["M06", "C1", "<@U1x> someone else", null],
      ["M07", "C1", "<@> nobody, <@U1 unfinished", null],
      ["M08", "D1", "<!here> in a DM", null],
      ["M09", "C1", "<@U1> but deleted", 1],
      ["M10", "C1", "a<@U2>b<@U1>c<!everyone>", null],
    ];
    cases.forEach(([id, channel, text, deleted], i) =>
      insert.run(id, channel, text, i + 1, deleted),
    );
    older.close();

    const db = openDb(file, undefined, { backupBeforeUpgrade: false });
    try {
      expect(
        db
          .prepare("SELECT message_id, user_id FROM message_mentions ORDER BY message_id, user_id")
          .all()
          .map((r: any) => `${r.message_id}:${r.user_id}`),
      ).toEqual([
        "M01:U1",
        "M02:U1",
        "M03:U1",
        "M04:U1",
        "M05:!",
        "M05:U1",
        "M06:U1x",
        "M08:!",
        "M10:!",
        "M10:U1",
        "M10:U2",
      ]);
      const upgraded = new Store(db);
      expect(upgraded.unreadMentionCounts("U1")).toEqual(countsFromText(db, "U1"));
      expect(upgraded.unreadMentionCounts("U1")).toEqual({ C1: 6 });
    } finally {
      db.close();
    }
  });
});
