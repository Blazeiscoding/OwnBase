/**
 * What counting unread mentions costs, and what a message that names a whole
 * channel costs because of it (OPT-12). Every `<!here>` and every deletion
 * recounts each member's mentions, and a count read every message in each of
 * that member's channels.
 *
 * Seeds one channel with `--messages` messages (200,000 by default) and
 * `--members` members (50): seven in ten messages top-level, the rest replies
 * in threads of ten; one in a hundred names a member and one in a thousand is
 * `<!here>`. Every member has read the channel up to its last 300 messages,
 * replies up to where the channel stood at 60% (as after the v30 upgrade), and
 * follows 20 threads read up to their last few replies.
 *
 * It checks the answers before timing them, then times one member's count, the
 * Activity page, an `<!here>` post and a deletion over HTTP (both recount every
 * member), 10,000 messages created through the store, and the size of the
 * database. Run with the server
 * package's tsx:
 *
 *   pnpm --filter @ownbase/server exec tsx ../../scripts/measure-unread-counts.mts [--messages=200000] [--members=50]
 *
 * On a server with the mentions index (schema v31), the seed fills it as the
 * server would; on an older one there is nothing to fill.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { createWorkspaceServer } from "../packages/server/src/index.js";

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const count = arg("messages", 200_000);
const members = arg("members", 50);
const SAMPLES = 30;
const POSTS = 10;

const id = (n: number) => `M${String(n).padStart(9, "0")}`;
const uid = (n: number) => `U${String(n).padStart(4, "0")}`;

async function ok(response: Response) {
  if (!response.ok) throw new Error(`${response.url}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};
const summary = (values: number[]) =>
  `p50 ${percentile(values, 50).toFixed(1)} ms, p95 ${percentile(values, 95).toFixed(1)} ms (n=${values.length})`;

const dir = mkdtempSync(join(tmpdir(), "ownbase-unread-counts-"));
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
  const ownerId = registered.user.id as string;
  const channelId = server.store.getChannelByName("general")!.id;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(ok);

  // ---- seed, through a second connection; WAL lets the server see it ----
  const db = new DatabaseSync(join(dir, "workspace.db"));
  db.exec("PRAGMA busy_timeout = 5000");

  const seeding = performance.now();
  db.exec("BEGIN");
  const addUser = db.prepare(
    `INSERT INTO users (id, handle, display_name, password_hash, salt, created_at)
     VALUES (?, ?, ?, '', '', 0)`,
  );
  const join_ = db.prepare(
    `INSERT INTO channel_members (channel_id, user_id, joined_at, last_read_seq, replies_read_seq)
     VALUES (?, ?, 0, ?, ?)`,
  );
  const insert = db.prepare(
    `INSERT INTO messages (id, channel_id, user_id, text, thread_root_id, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // Where the mentions index exists (v31), seed it as the server keeps it.
  const indexed = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_mentions'")
    .get();
  const named = indexed
    ? db.prepare(
        "INSERT OR IGNORE INTO message_mentions (message_id, channel_id, user_id) VALUES (?, ?, ?)",
      )
    : null;
  const follow = db.prepare(
    `INSERT OR IGNORE INTO thread_follows (user_id, root_id, following, last_read_seq, revision)
     VALUES (?, ?, 1, ?, 1)`,
  );
  // Seqs above anything the server has written, so the seeded history is its own.
  const start = server.store.currentSeq() + 1;
  let seq = start;
  const people = Array.from({ length: members }, (_, i) => uid(i));
  for (const person of people) addUser.run(person, person.toLowerCase(), person);
  let root: string | null = null;
  let repliesLeft = 0;
  const roots: { id: string; last: number }[] = [];
  let rng = 42;
  const random = () => (rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < count; i++) {
    const key = id(i);
    const author = people[i % members]!;
    let text = `message ${i}`;
    if (i % 100 === 0) text += ` <@${people[Math.floor(random() * members)]}>`;
    if (i % 1000 === 500) text += " <!here>";
    const mentioned: string[] = [];
    if (i % 100 === 0) mentioned.push(text.slice(text.lastIndexOf("<@") + 2, -1));
    const reply = repliesLeft > 0 && root !== null && random() < 0.43;
    if (reply) {
      insert.run(key, channelId, author, text, root, seq, seq);
      roots.at(-1)!.last = seq;
      repliesLeft--;
    } else {
      insert.run(key, channelId, author, text, null, seq, seq);
      root = key;
      repliesLeft = 10;
      roots.push({ id: key, last: seq });
    }
    if (named) {
      for (const person of mentioned) named.run(key, channelId, person);
      if (text.includes("<!here>")) named.run(key, channelId, "!");
    }
    seq++;
  }
  const end = seq - 1;
  const channelRead = end - 300;
  const repliesRead = start + Math.floor(count * 0.6);
  for (const person of people) {
    join_.run(channelId, person, channelRead, repliesRead);
    for (let t = 0; t < 20; t++) {
      const thread = roots[Math.floor(random() * roots.length)]!;
      follow.run(person, thread.id, Math.max(0, thread.last - 3));
    }
  }
  db.exec("COMMIT");
  // The server numbers everything from its event log; move it past the seed.
  db.prepare(
    "INSERT INTO events (seq, channel_id, type, payload, created_at) VALUES (?, NULL, 'seeded', '{}', 0)",
  ).run(end);
  const seeded = (db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
  let head = "";
  try {
    head = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    head = "unknown";
  }
  console.log(
    `${seeded.toLocaleString()} messages, ${members} members, seeded in ` +
      `${((performance.now() - seeding) / 1000).toFixed(1)} s. ${head}, ` +
      `${cpus()[0]?.model ?? "cpu"}, ${cpus().length} threads, ${Math.round(totalmem() / 2 ** 30)} GB, ` +
      `Node ${process.version}, ${process.platform}. Mentions index: ${indexed ? "yes" : "no"}`,
  );

  const member = people[1]!;
  // ---- correctness first: the count against a brute-force reading of the rule ----
  const expected = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
         JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
         WHERE m.user_id != ? AND m.deleted_at IS NULL
           AND (instr(m.text, ?) > 0 OR instr(m.text, '<!here>') > 0)
           AND CASE WHEN m.thread_root_id IS NULL THEN m.seq > cm.last_read_seq
             ELSE m.seq > COALESCE((SELECT tf.last_read_seq FROM thread_follows tf
               WHERE tf.user_id = cm.user_id AND tf.root_id = m.thread_root_id), cm.replies_read_seq)
             AND NOT (m.broadcast = 1 AND m.seq <= cm.last_read_seq
               AND cm.last_read_seq > COALESCE((SELECT tf.unread_hold FROM thread_follows tf
                 WHERE tf.user_id = cm.user_id AND tf.root_id = m.thread_root_id), -1)) END`,
      )
      .get(member, member, `<@${member}>`) as { n: number }
  ).n;
  const counted = server.store.unreadMentionCounts(member)[channelId] ?? 0;
  if (counted !== expected) throw new Error(`counted ${counted}, the rule says ${expected}`);
  console.log(`${member} has ${counted} unread mentions, as the rule says.`);

  const times = (fn: () => void, n = SAMPLES) => {
    fn();
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      fn();
      out.push(performance.now() - t);
    }
    return out;
  };
  console.log(
    `One member's mention counts: ${summary(times(() => server.store.unreadMentionCounts(member)))}`,
  );
  const expectedMentions = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
         WHERE m.user_id != ? AND m.deleted_at IS NULL
           AND (instr(m.text, ?) > 0 OR instr(m.text, '<!here>') > 0)`,
      )
      .get(member, `<@${member}>`) as { n: number }
  ).n;
  const listed = server.store.activityMessages(member, { mode: "mentions", limit: 100_000 }).length;
  if (listed !== expectedMentions)
    throw new Error(`Activity lists ${listed} mentions, the text has ${expectedMentions}`);
  console.log(
    `Activity, mentions, first page: ${summary(
      times(() => server.store.activityMessages(member, { mode: "mentions", limit: 50 })),
    )}`,
  );
  console.log(
    `Activity, unread, first page: ${summary(
      times(() => server.store.activityMessages(member, { mode: "unread", limit: 50 })),
    )}`,
  );

  // ---- a message naming the whole channel, and a deletion: each recounts every member ----
  const posts: number[] = [];
  const deletions: number[] = [];
  for (let i = 0; i < POSTS; i++) {
    let t = performance.now();
    const { message } = await call("POST", `/api/channels/${channelId}/messages`, {
      text: `<!here> round ${i}`,
      nonce: `here-${i}`,
    });
    posts.push(performance.now() - t);
    t = performance.now();
    await call("DELETE", `/api/messages/${message.id}`);
    deletions.push(performance.now() - t);
  }
  console.log(`<!here> post, ${members + 1} members recounted: ${summary(posts)}`);
  console.log(`Deletion, ${members + 1} members recounted: ${summary(deletions)}`);

  // ---- what keeping the index costs: writes through the store, and space ----
  /** 10,000 messages through the store, one in a hundred naming someone, rolled back. */
  const insertBatch = () => {
    const t = performance.now();
    try {
      server.store.transaction(() => {
        for (let i = 0; i < 10_000; i++) {
          server.store.createMessage({
            channelId,
            userId: ownerId,
            text: i % 100 === 0 ? `insert ${i} <@${member}>` : `insert ${i}`,
            threadRootId: i % 10 === 0 ? null : roots[0]!.id,
            nonce: null,
          });
        }
        throw new Error("roll back");
      });
    } catch {
      // Rolled back, as intended.
    }
    return performance.now() - t;
  };
  console.log(
    `10,000 messages created through the store, rolled back: ${summary(times(insertBatch, 5))}`,
  );
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  console.log(
    `Database after VACUUM: ${(statSync(join(dir, "workspace.db")).size / 2 ** 20).toFixed(1)} MiB`,
  );
  db.close();
} finally {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
}
