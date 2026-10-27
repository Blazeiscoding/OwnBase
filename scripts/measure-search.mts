/**
 * What a search costs, by the shape of the query (OPT-11). Search filters a
 * walk of every message, newest first, until it has a page; how far it walks
 * depends on how many messages match and where they are.
 *
 * Seeds `--messages` messages (200,000 by default) over two years, from 50
 * authors and one who rarely writes: 70% in #general, 20% in #random, 1% in
 * each of five small channels, and 2.5% each in a private channel the reader
 * is in and one they are not. "the" is in 60% of messages, "deploy" in 5%,
 * "zebra" in 0.01%, and "classified" only in the channel the reader cannot
 * see; 2% carry a link and 1% a file, named for a budget, a photo, a
 * contract, notes or logs in turn, so free text and `type:` find them by
 * name and kind (IMP-02).
 *
 * "restricted" is said in about 300 messages, all in the channel the reader
 * cannot see, and every tenth message also carries a file named "scan.bin",
 * 20,000 in all: too many names for a search to start from (F13).
 *
 * It checks that nothing from the hidden channel is returned, then times one
 * page (21 rows, as the route asks for 20) of each query through the store,
 * after five untimed runs, and prints a short hash of the page's ids, so two
 * revisions' runs show whether they found the same. Run with the server
 * package's tsx:
 *
 *   pnpm --filter @ownbase/server exec tsx ../../scripts/measure-search.mts [--messages=200000]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseSearchQuery } from "../packages/protocol/src/search.js";
import { openDb } from "../packages/server/src/db.js";
import { Store } from "../packages/server/src/store.js";

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const count = arg("messages", 200_000);
const SAMPLES = 25;
const DAY = 86_400_000;
const END = Date.UTC(2026, 8, 30);
const START = END - 730 * DAY;

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

const dir = mkdtempSync(join(tmpdir(), "ownbase-search-"));
const db = openDb(join(dir, "workspace.db"));
const store = new Store(db);
try {
  const seeding = performance.now();
  db.exec("BEGIN");
  const addUser = db.prepare(
    `INSERT INTO users (id, handle, display_name, password_hash, salt, created_at)
     VALUES (?, ?, ?, '', '', 0)`,
  );
  const addChannel = db.prepare(
    "INSERT INTO channels (id, type, name, creator_id, created_at) VALUES (?, ?, ?, 'U00', 0)",
  );
  const join_ = db.prepare(
    "INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, 0)",
  );
  const insert = db.prepare(
    `INSERT INTO messages (id, channel_id, user_id, text, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const attach = db.prepare(
    `INSERT INTO files (id, channel_id, user_id, message_id, name, mime, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 10, ?)`,
  );
  const files: [name: string, mime: string][] = [
    ["Q3 budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["site photo.jpg", "image/jpeg"],
    ["contract.pdf", "application/pdf"],
    ["notes.txt", "text/plain"],
    ["logs.zip", "application/zip"],
  ];
  const people = Array.from({ length: 50 }, (_, i) => `U${String(i).padStart(2, "0")}`);
  for (const id of people) addUser.run(id, id.toLowerCase(), id);
  addUser.run("URARE", "rare", "Rare");
  const reader = people[1]!;
  const channels: [string, string, string][] = [
    ["CGEN", "public", "general"],
    ["CRND", "public", "random"],
    ...[0, 1, 2, 3, 4].map((i) => [`CSM${i}`, "public", `small-${i}`] as [string, string, string]),
    ["CTEAM", "private", "team"],
    ["CSECRET", "private", "secret"],
  ];
  for (const [id, type, name] of channels) addChannel.run(id, type, name);
  join_.run("CTEAM", reader);
  join_.run("CSECRET", people[2]!);
  let rng = 7;
  const random = () => (rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < count; i++) {
    const r = random();
    const channel =
      r < 0.7
        ? "CGEN"
        : r < 0.9
          ? "CRND"
          : r < 0.95
            ? `CSM${Math.floor((r - 0.9) / 0.01)}`
            : r < 0.975
              ? "CTEAM"
              : "CSECRET";
    const words = [`message ${i}`];
    if (random() < 0.6) words.push("the");
    if (random() < 0.05) words.push("deploy");
    if (i % 10_000 === 5_000) words.push("zebra");
    if (channel === "CSECRET" && random() < 0.5) words.push("classified");
    if (channel === "CSECRET" && i % 17 === 0) words.push("restricted");
    if (random() < 0.02) words.push("https://example.com/page");
    const at = START + Math.floor((i / count) * (END - START));
    const id = `M${String(at).padStart(14, "0")}${String(i).padStart(7, "0")}`;
    const author = i % 2000 === 0 ? "URARE" : people[i % 50]!;
    insert.run(id, channel, author, words.join(" "), i + 1, at);
    if (i % 100 === 50) {
      const [name, mime] = files[((i / 100) % files.length) | 0]!;
      attach.run(`F${i}`, channel, author, id, name, mime, at);
    }
    if (i % 10 === 3)
      attach.run(`S${i}`, channel, author, id, "scan.bin", "application/octet-stream", at);
  }
  db.exec("COMMIT");
  let head = "";
  try {
    head = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    head = "unknown";
  }
  console.log(
    `${count.toLocaleString()} messages seeded in ${((performance.now() - seeding) / 1000).toFixed(1)} s. ` +
      `${head}, ${cpus()[0]?.model ?? "cpu"}, ${cpus().length} threads, ` +
      `${Math.round(totalmem() / 2 ** 30)} GB, Node ${process.version}, ${process.platform}.\n`,
  );

  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const queries: [string, { channelId?: string; cursor?: boolean }?][] = [
    ["the"],
    ["the", { cursor: true }],
    ["deploy"],
    ["zebra"],
    ["classified"],
    ["from:@rare"],
    ["in:#small-3"],
    ["the in:#small-3"],
    ["has:file"],
    ["has:link"],
    [`after:${day(END - 30 * DAY)}`],
    [`before:${day(START + 30 * DAY)}`],
    [`zebra before:${day(START + 30 * DAY)}`],
    ["deploy", { channelId: "CSM2" }],
    ["budget"],
    ["contract pdf"],
    ["invoice"],
    ["type:pdf"],
    ["type:image the"],
    ["budget type:spreadsheet"],
    ["restricted"],
    ["scan"],
    ["scan zebra"],
    ["budget", { cursor: true }],
    ["budget from:@u02"],
    [`budget before:${day(START + 365 * DAY)}`],
  ];
  console.log("query                              rows   p50 ms   p95 ms   page");
  for (const [text, options] of queries) {
    const parsed = parseSearchQuery(text, { timeZone: "UTC" });
    let cursor: string | undefined;
    if (options?.cursor) cursor = store.searchMessages(reader, parsed, 21).at(-1)?.id;
    const opts = { cursor, channelId: options?.channelId };
    const found = store.searchMessages(reader, parsed, 21, opts);
    if (found.some((m) => m.channelId === "CSECRET"))
      throw new Error(`${text} returned a hidden channel's message`);
    const times: number[] = [];
    for (let i = 0; i < 5 + SAMPLES; i++) {
      const t = performance.now();
      store.searchMessages(reader, parsed, 21, opts);
      if (i >= 5) times.push(performance.now() - t);
    }
    // What the page held, short enough to compare between revisions.
    const page = createHash("sha256")
      .update(found.map((m) => m.id).join(","))
      .digest("hex")
      .slice(0, 8);
    const label = `${text}${options?.cursor ? " (page 2)" : ""}${options?.channelId ? " (in one channel)" : ""}`;
    console.log(
      `${label.padEnd(34)} ${String(found.length).padStart(4)} ${percentile(times, 50).toFixed(1).padStart(8)} ${percentile(times, 95).toFixed(1).padStart(8)}   ${page}`,
    );
  }
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
