/**
 * What indexing messages by (thread_root_id, id) does for thread pages, and
 * what it costs to build, write and store, compared with the single-column
 * thread_root_id index a workspace had before it.
 *
 * Seeds one channel with `--messages` messages (50,000 by default): an old
 * thread of 50 replies at the start, then top-level messages, then a busy
 * thread of 500 replies at the end. That is where the single-column index went
 * wrong: SQLite read the old thread's page through (channel_id, id) and
 * walked past every newer message in the channel to find it.
 *
 * For each set of indexes it checks that every request returns what it
 * should, then times real HTTP requests for thread pages (newest, older,
 * around) and the channel's newest page, a batch of inserts, and the size of
 * the database. Run with the server package's tsx:
 *
 *   pnpm --filter @slackoss/server exec tsx ../../scripts/measure-thread-index.mts [--messages=200000]
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorkspaceServer } from "../packages/server/src/index.js";

const count = Number(
  process.argv.find((a) => a.startsWith("--messages="))?.split("=")[1] ?? 50_000,
);
const SAMPLES = 30;
const OLD_REPLIES = 50;
const BUSY_REPLIES = 500;

const LEGACY = "CREATE INDEX idx_messages_thread ON messages(thread_root_id)";
const COMPOSITE = "CREATE INDEX idx_messages_thread_page ON messages(thread_root_id, id)";

const id = (n: number) => `M${String(n).padStart(9, "0")}`;

async function ok(response: Response) {
  if (!response.ok) throw new Error(`${response.url}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

const dir = mkdtempSync(join(tmpdir(), "ownbase-thread-index-"));
const server = await createWorkspaceServer({
  dataDir: dir,
  host: "127.0.0.1",
  port: 0,
  mdns: false,
  logger: false,
  rateLimits: false,
});
try {
  const base = `http://127.0.0.1:${server.port}`;
  const registered = await ok(
    await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
    }),
  );
  const token = registered.token as string;
  const userId = registered.user.id as string;
  const channelId = server.store.getChannelByName("general")!.id;
  const get = (path: string) =>
    fetch(base + path, { headers: { authorization: `Bearer ${token}` } }).then(ok);

  // ---- seed, through a second connection; WAL lets the server see it ----
  const db = new DatabaseSync(join(dir, "workspace.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const insert = db.prepare(
    `INSERT INTO messages (id, channel_id, user_id, text, thread_root_id, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 1;
  const add = (root: string | null) => {
    const key = id(n);
    insert.run(key, channelId, userId, `message ${n}`, root, n, n);
    n++;
    return key;
  };
  const seeding = performance.now();
  db.exec("BEGIN");
  const oldRoot = add(null);
  const oldReplies: string[] = [];
  for (let i = 0; i < OLD_REPLIES; i++) oldReplies.push(add(oldRoot));
  while (n <= count - BUSY_REPLIES - 1) add(null);
  const busyRoot = add(null);
  for (let i = 0; i < BUSY_REPLIES; i++) add(busyRoot);
  db.exec("COMMIT");
  const seeded = (db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
  if (seeded !== count) throw new Error(`seeded ${seeded}, wanted ${count}`);
  console.log(
    `${count.toLocaleString()} messages seeded in ${((performance.now() - seeding) / 1000).toFixed(1)} s. ` +
      `${cpus()[0]?.model ?? "cpu"}, ${cpus().length} threads, ${Math.round(totalmem() / 2 ** 30)} GB, ` +
      `Node ${process.version}, ${process.platform}`,
  );

  const cases: { name: string; path: string; check: (body: any) => void }[] = [
    {
      name: "old thread, newest page",
      path: `/api/channels/${channelId}/threads/${oldRoot}?limit=30`,
      check: (b) => {
        if (b.messages.length !== 30 || b.messages.at(-1).id !== oldReplies.at(-1))
          throw new Error("old thread newest page is wrong");
      },
    },
    {
      name: "old thread, older page",
      path: `/api/channels/${channelId}/threads/${oldRoot}?limit=30&before=${oldReplies[25]}`,
      check: (b) => {
        if (b.messages.length !== 25 || b.hasMoreOlder) throw new Error("older page is wrong");
      },
    },
    {
      name: "old thread, around a reply",
      path: `/api/channels/${channelId}/threads/${oldRoot}?limit=21&around=${oldReplies[25]}`,
      check: (b) => {
        if (b.messages.length !== 21) throw new Error("around page is wrong");
      },
    },
    {
      name: "busy thread, newest page",
      path: `/api/channels/${channelId}/threads/${busyRoot}?limit=30`,
      check: (b) => {
        if (b.messages.length !== 30 || !b.hasMoreOlder) throw new Error("busy page is wrong");
      },
    },
    {
      name: "channel, newest page",
      path: `/api/channels/${channelId}/messages?limit=50`,
      check: (b) => {
        if (b.messages.length !== 50) throw new Error("channel page is wrong");
      },
    },
  ];

  const indexes = () =>
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND sql IS NOT NULL",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

  /** Leaves exactly the thread indexes asked for, and how long building them took. */
  const use = (wanted: string[]) => {
    for (const name of ["idx_messages_thread", "idx_messages_thread_page"]) {
      db.exec(`DROP INDEX IF EXISTS ${name}`);
    }
    const building = performance.now();
    for (const sql of wanted) db.exec(sql);
    // No ANALYZE: the server never runs it, so its planner has no statistics
    // to go on, and neither should this.
    return performance.now() - building;
  };

  const plan = () =>
    (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM messages WHERE channel_id = ? AND thread_root_id = ?
           AND deleted_at IS NULL ORDER BY id DESC LIMIT 30`,
        )
        .all(channelId, oldRoot) as { detail: string }[]
    )
      .map((r) => r.detail)
      .join("; ");

  const size = () => {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    return statSync(join(dir, "workspace.db")).size;
  };

  /** 10,000 inserts, nine in ten of them replies, in one transaction rolled back after. */
  const insertBatch = () => {
    const start = n;
    const t = performance.now();
    db.exec("BEGIN");
    for (let i = 0; i < 10_000; i++) add(i % 10 === 0 ? null : busyRoot);
    db.exec("ROLLBACK");
    n = start;
    return performance.now() - t;
  };

  const requests = async () => {
    const out = new Map<string, string>();
    for (const c of cases) {
      c.check(await get(c.path));
      const times: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const t = performance.now();
        c.check(await get(c.path));
        times.push(performance.now() - t);
      }
      out.set(c.name, `${percentile(times, 50).toFixed(2)} / ${percentile(times, 95).toFixed(2)}`);
    }
    return out;
  };

  console.log(`Indexes at the schema this server made: ${indexes().join(", ")}\n`);
  const configurations: [string, string[]][] = [
    ["thread_root_id", [LEGACY]],
    ["(thread_root_id, id)", [COMPOSITE]],
    ["both", [LEGACY, COMPOSITE]],
  ];
  const results: Record<string, string>[] = [];
  for (const [label, sql] of configurations) {
    const built = use(sql);
    const row: Record<string, string> = { indexes: label };
    row["built in"] = `${built.toFixed(0)} ms`;
    row["plan"] = plan().replace(/USING (COVERING )?INDEX /, "");
    row["size"] = `${(size() / 2 ** 20).toFixed(1)} MB`;
    row["10k inserts"] = `${insertBatch().toFixed(0)} ms`;
    for (const [name, value] of await requests()) row[name] = value;
    results.push(row);
  }
  console.log(`HTTP rows are p50 / p95 ms over ${SAMPLES} warm requests.\n`);
  for (const key of Object.keys(results[0]!)) {
    console.log(`${key.padEnd(28)} ${results.map((r) => r[key]!.padEnd(44)).join(" ")}`);
  }
  db.close();
} finally {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
}
