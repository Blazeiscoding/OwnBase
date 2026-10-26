/**
 * What the handshake snapshot costs as a workspace grows (OPT-13). Every
 * connect and reconnect builds one, so after a restart every member's client
 * asks for one at once.
 *
 * Seeds `--members` accounts (2,000 by default), `--channels` public channels
 * (300), each member in `--joined` of them (30) with one manager each, and for
 * the measured member `--dms` direct conversations (50), 200 followed threads
 * and 100 saved messages. Every channel gets 20 messages, a quarter of them
 * thread replies.
 *
 * It times each part of the snapshot for one member through the store, the
 * size of each part as sent, one handshake over a real socket, and
 * `--herd` handshakes at once (100), as after a restart. Run with the server
 * package's tsx:
 *
 *   pnpm --filter @slackoss/server exec tsx ../../scripts/measure-snapshot.mts [--members=2000] [--channels=300]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { PROTOCOL_VERSION } from "../packages/protocol/src/entities.js";
import { createWorkspaceServer } from "../packages/server/src/index.js";

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const members = arg("members", 2000);
const channels = arg("channels", 300);
const joined = Math.min(arg("joined", 30), channels);
const dms = Math.min(arg("dms", 50), members - 1);
const herd = arg("herd", 100);
const SAMPLES = 30;

const uid = (n: number) => `U${String(n).padStart(6, "0")}`;
const cid = (n: number) => `C${String(n).padStart(6, "0")}`;
const did = (n: number) => `D${String(n).padStart(6, "0")}`;

async function ok(response: Response) {
  if (!response.ok) throw new Error(`${response.url}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};
const summary = (values: number[]) =>
  `p50 ${percentile(values, 50).toFixed(2)} ms, p95 ${percentile(values, 95).toFixed(2)} ms`;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`;

const dir = mkdtempSync(join(tmpdir(), "ownbase-snapshot-"));
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
  const me = registered.user.id as string;

  // ---- seed, through a second connection; WAL lets the server see it ----
  const db = new DatabaseSync(join(dir, "workspace.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const seeding = performance.now();
  db.exec("BEGIN");
  const addUser = db.prepare(
    `INSERT INTO users (id, handle, display_name, password_hash, salt, created_at, status_text)
     VALUES (?, ?, ?, '', '', 0, ?)`,
  );
  const addChannel = db.prepare(
    `INSERT INTO channels (id, type, name, topic, creator_id, dm_key, last_msg_seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  const join_ = db.prepare(
    `INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at, last_read_seq, is_manager)
     VALUES (?, ?, 0, ?, ?)`,
  );
  const insert = db.prepare(
    `INSERT INTO messages (id, channel_id, user_id, text, thread_root_id, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const follow = db.prepare(
    `INSERT OR IGNORE INTO thread_follows (user_id, root_id, following, last_read_seq, revision)
     VALUES (?, ?, 1, ?, 1)`,
  );
  const save = db.prepare(
    "INSERT OR IGNORE INTO saved_items (user_id, message_id, created_at) VALUES (?, ?, ?)",
  );
  let seq = server.store.currentSeq() + 1;
  const people = Array.from({ length: members }, (_, i) => uid(i));
  for (const person of people)
    addUser.run(person, person.toLowerCase(), `Person ${person}`, "Working from home");
  const roots: string[] = [];
  let m = 0;
  const fill = (channelId: string, authors: string[]) => {
    let root: string | null = null;
    for (let i = 0; i < 20; i++) {
      const key = `M${String(m++).padStart(9, "0")}`;
      const reply = root !== null && i % 4 === 3;
      insert.run(
        key,
        channelId,
        authors[i % authors.length]!,
        `message ${i}`,
        reply ? root : null,
        seq,
        seq,
      );
      if (!reply) {
        root = key;
        roots.push(key);
      }
      seq++;
    }
    return seq - 1;
  };
  for (let c = 0; c < channels; c++) {
    const id = cid(c);
    addChannel.run(id, "public", `channel-${c}`, "What this channel is for", me, null, 0);
    const last = fill(id, [me, people[c % members]!]);
    db.prepare("UPDATE channels SET last_msg_seq = ? WHERE id = ?").run(last, id);
  }
  // Each member in `joined` channels, the first of whom manages it.
  for (let p = 0; p < members; p++) {
    for (let j = 0; j < joined; j++) {
      const c = (p * 7 + j) % channels;
      join_.run(cid(c), people[p]!, 0, p === c % members ? 1 : 0);
    }
  }
  for (let j = 0; j < joined; j++) join_.run(cid(j), me, 0, 0);
  for (let d = 0; d < dms; d++) {
    const other = people[d]!;
    const id = did(d);
    const [low, high] = [me, other].sort();
    addChannel.run(id, "dm", "", "", me, `${low}:${high}`, 0);
    join_.run(id, me, 0, 0);
    join_.run(id, other, 0, 0);
    const last = fill(id, [me, other]);
    db.prepare("UPDATE channels SET last_msg_seq = ? WHERE id = ?").run(last, id);
  }
  for (let t = 0; t < Math.min(200, roots.length); t++) {
    follow.run(me, roots[(t * 13) % roots.length]!, 0);
    if (t < 100) save.run(me, roots[(t * 17) % roots.length]!, t);
  }
  db.exec("COMMIT");
  db.prepare(
    "INSERT INTO events (seq, channel_id, type, payload, created_at) VALUES (?, NULL, 'seeded', '{}', 0)",
  ).run(seq);
  let head = "";
  try {
    head = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    head = "unknown";
  }
  console.log(
    `${members.toLocaleString()} members, ${channels} public channels (${joined} joined each), ` +
      `${dms} DMs, ${m.toLocaleString()} messages; seeded in ` +
      `${((performance.now() - seeding) / 1000).toFixed(1)} s. ${head}, ` +
      `${cpus()[0]?.model ?? "cpu"}, ${cpus().length} threads, ${Math.round(totalmem() / 2 ** 30)} GB, ` +
      `Node ${process.version}, ${process.platform}.`,
  );

  // ---- each part, as the gateway builds it ----
  const store = server.store;
  const parts: [string, () => unknown][] = [
    ["users", () => store.listUsers()],
    ["channels", () => store.listChannelsVisibleTo(me)],
    ["memberships", () => store.memberships(me)],
    ["channelLastSeq", () => store.channelLastSeqMap(me)],
    ["presence", () => server.gateway.presenceMap()],
    ["savedMessageIds", () => store.savedMessageIds(me)],
    ["threadFollows", () => store.threadFollows(me)],
    ["mentionCounts", () => store.unreadMentionCounts(me)],
    ["friends", () => store.listFriends(me)],
  ];
  console.log("\npart             time                              size");
  let partsTotal = 0;
  for (const [name, read] of parts) {
    const times: number[] = [];
    let value: unknown;
    for (let i = 0; i < SAMPLES; i++) {
      const t = performance.now();
      value = read();
      times.push(performance.now() - t);
    }
    const json = JSON.stringify(value);
    const encode: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      JSON.stringify(value);
      encode.push(performance.now() - t);
    }
    partsTotal += percentile(times, 50);
    console.log(
      `${name.padEnd(16)} ${summary(times).padEnd(33)} ${kb(json.length).padStart(9)}` +
        `  (encode ${percentile(encode, 50).toFixed(2)} ms)`,
    );
  }
  console.log(`sum of parts p50 ${partsTotal.toFixed(1)} ms`);

  // ---- one handshake, and a herd of them, over real sockets ----
  const handshake = () =>
    new Promise<{ ms: number; bytes: number }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      let t = 0;
      ws.onopen = () => {
        t = performance.now();
        ws.send(
          JSON.stringify({
            type: "hello",
            token,
            lastSeq: null,
            protocolVersion: PROTOCOL_VERSION,
            syncVersion: 1,
          }),
        );
      };
      ws.onmessage = (message) => {
        const text = String(message.data);
        if (text.startsWith('{"type":"ready"')) {
          const ms = performance.now() - t;
          ws.close();
          resolve({ ms, bytes: Buffer.byteLength(text) });
        }
      };
      ws.onerror = () => reject(new Error("socket failed"));
    });
  const single: number[] = [];
  let bytes = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const r = await handshake();
    single.push(r.ms);
    bytes = r.bytes;
  }
  console.log(`\nhandshake        ${summary(single).padEnd(33)} ${kb(bytes).padStart(9)}`);
  const started = performance.now();
  const all = await Promise.all(Array.from({ length: herd }, handshake));
  console.log(
    `${herd} at once     all ready in ${(performance.now() - started).toFixed(0)} ms; ` +
      `slowest ${Math.max(...all.map((r) => r.ms)).toFixed(0)} ms`,
  );
  db.close();
} finally {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
}
