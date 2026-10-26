/**
 * How long database work holds up the event loop the desktop app's window
 * shares with its embedded server. The server runs in Electron's main
 * process, so while a synchronous SQLite call runs, the window cannot be moved
 * or resized smoothly and no IPC call is answered.
 *
 * Seeds a workspace with `--messages` messages (50,000 by default), half of
 * them older than the retention window and a tenth of them replies in a thread
 * of their own channel, then times the longest single stall during each piece
 * of work: reading, searching, many readers at once, the scheduled queue with
 * messages due and held, backing up, starting and retention. Every request has
 * to succeed, and the fixture is checked before anything is timed, so a number
 * here is never the cost of an error page. Run with the server package's tsx:
 *
 *   pnpm --filter @slackoss/server exec tsx ../../scripts/measure-stall.mts
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import {
  backupWorkspace,
  createWorkspaceServer,
  verifyBackup,
  type WorkspaceServer,
} from "../packages/server/src/index.js";

/** tsx's register API, from the server package that depends on it. */
const tsxApi = createRequire(new URL("../packages/server/package.json", import.meta.url)).resolve(
  "tsx/esm/api",
);

const count = Number(
  process.argv.find((a) => a.startsWith("--messages="))?.split("=")[1] ?? 50_000,
);
const WORDS =
  "the release plan design review ship friday numbers quarterly budget customer bug fix deploy staging meeting notes draft proposal roadmap sprint retro launch onboarding migration database search thread reply".split(
    " ",
  );
const sentence = (i: number) => {
  const length = 12 + (i % 30);
  const words: string[] = [];
  for (let w = 0; w < length; w++) words.push(WORDS[(i * 7 + w * 13) % WORDS.length]!);
  // One message in a thousand says something unusual, as a search usually looks for.
  if (i % 1000 === 0) words.push("zeppelin");
  return words.join(" ");
};

/** The body of a successful response; anything else stops the run. */
async function succeeded<T = unknown>(response: Promise<Response> | Response): Promise<T> {
  const res = await response;
  if (!res.ok) throw new Error(`${res.url} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** Runs `work`, returning how long it took and the longest the loop went unserved. */
async function measure(label: string, work: () => unknown): Promise<void> {
  let last = performance.now();
  let longest = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 1);
  const started = performance.now();
  await work();
  const took = performance.now() - started;
  // One more beat, so a stall at the very end is counted.
  await new Promise((resolve) => setTimeout(resolve, 5));
  clearInterval(beat);
  longest = Math.max(longest, performance.now() - last - 5);
  console.log(
    `${label.padEnd(44)} took ${took.toFixed(0).padStart(6)} ms, longest stall ${longest.toFixed(0).padStart(5)} ms`,
  );
}

const dir = mkdtempSync(join(tmpdir(), "ownbase-stall-"));
const dataDir = join(dir, "workspace");
const retentionDays = 30;
let server: WorkspaceServer | undefined;
try {
  const options = {
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
  } as const;
  server = await createWorkspaceServer(options);
  const base = () => `http://127.0.0.1:${server!.port}`;
  const owner = await succeeded<{ token: string; user: { id: string } }>(
    fetch(`${base()}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
    }),
  );

  // Five channels, a tenth of messages replies, half older than the window.
  const store = server.store;
  const channels = [store.getChannelByName("general")!.id];
  for (const name of ["design", "engineering", "support", "random"]) {
    const { channel } = await succeeded<{ channel: { id: string } }>(
      fetch(`${base()}/api/channels`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
        body: JSON.stringify({ type: "public", name }),
      }),
    );
    channels.push(channel.id);
  }
  const realNow = Date.now.bind(Date);
  const start = realNow() - 2 * retentionDays * 24 * 3600_000;
  const step = (2 * retentionDays * 24 * 3600_000) / count;
  const seeded = performance.now();
  // Recent roots per channel: a reply belongs to a thread in its own channel.
  const roots = new Map<string, string[]>(channels.map((id) => [id, []]));
  for (let batch = 0; batch < count; batch += 1000) {
    store.transaction(() => {
      for (let i = batch; i < Math.min(count, batch + 1000); i++) {
        Date.now = () => Math.floor(start + i * step);
        const channelId = channels[i % channels.length]!;
        const here = roots.get(channelId)!;
        const reply = i % 10 === 9 && here.length > 0;
        const message = store.createMessage({
          channelId,
          userId: owner.user.id,
          text: sentence(i),
          threadRootId: reply ? here[(i * 31) % here.length]! : null,
          nonce: null,
        });
        // Posting stamps each message with its place in the event log, and a
        // reply moves its channel's newest seq only when shown there.
        store.stampMessageSeq(message.id, channelId, 1_000_000 + i, !reply);
        if (!reply) {
          here.push(message.id);
          if (here.length > 50) here.shift();
        }
      }
    });
  }
  Date.now = realNow;

  // The fixture is what it says it is before anything is timed.
  const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  const fixture = db
    .prepare(
      `SELECT COUNT(*) AS messages,
         SUM(CASE WHEN thread_root_id IS NOT NULL THEN 1 ELSE 0 END) AS replies,
         (SELECT COUNT(*) FROM messages r JOIN messages root ON root.id = r.thread_root_id
          WHERE r.channel_id != root.channel_id OR root.thread_root_id IS NOT NULL) AS misplaced
       FROM messages`,
    )
    .get() as { messages: number; replies: number; misplaced: number };
  if (fixture.messages !== count || fixture.misplaced !== 0 || fixture.replies < count / 11)
    throw new Error(`The seeded workspace is not as described: ${JSON.stringify(fixture)}`);
  const bytes = statSync(join(dataDir, "workspace.db")).size;
  console.log(
    `${cpus()[0]?.model ?? "unknown CPU"}, ${cpus().length} threads, ${(totalmem() / 2 ** 30).toFixed(0)} GiB; ` +
      `Node ${process.version} on ${process.platform}`,
  );
  console.log(
    `Seeded ${count.toLocaleString()} messages (${fixture.replies.toLocaleString()} replies, each in a thread of its own channel) in ${((performance.now() - seeded) / 1000).toFixed(1)} s; database ${(bytes / 1024 / 1024).toFixed(1)} MB\n`,
  );

  // Someone else, in every channel, who has read all but the last few hundred.
  const reader = await succeeded<{ token: string }>(
    fetch(`${base()}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "reader", displayName: "Reader", password: "password123" }),
    }),
  );
  const asReader = (path: string, body?: unknown) =>
    succeeded(
      fetch(base() + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${reader.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  for (const channelId of channels) {
    if (channelId !== channels[0]) await asReader(`/api/channels/${channelId}/join`, {});
  }
  // Seeding bypassed the event log, whose sequence a read is held within, so
  // the cursor is placed directly: all but the last 300 messages read.
  const readThrough = 1_000_000 + count - 300;
  db.prepare(
    "UPDATE channel_members SET last_read_seq = ? WHERE user_id = (SELECT id FROM users WHERE handle = 'reader')",
  ).run(readThrough);
  const unread = await asReader("/api/activity?mode=unread&limit=100");
  if ((unread as { messages: unknown[] }).messages.length === 0)
    throw new Error("The reader should have unread messages to list.");
  const get = (path: string) => asReader(path);
  await measure("Searching for a word in every message", () => get("/api/search?q=release"));
  await measure("Searching for a word in one in a thousand", () => get("/api/search?q=zeppelin"));
  await measure("Searching for a phrase", () => get('/api/search?q="design%20review"'));
  await measure("Opening a channel's newest page", () =>
    get(`/api/channels/${channels[1]}/messages`),
  );
  await measure("Activity, unread", () => get("/api/activity?mode=unread"));
  await measure("Twenty readers at once", () =>
    Promise.all(
      Array.from({ length: 20 }, (_, k) =>
        k % 3 === 0
          ? get("/api/search?q=release")
          : k % 3 === 1
            ? get(`/api/channels/${channels[k % channels.length]}/messages`)
            : get("/api/activity?mode=unread"),
      ),
    ),
  );

  // The scheduled queue: messages due now, and messages held in a closed channel.
  const queued = 2_000;
  const { channel: closed } = await succeeded<{ channel: { id: string } }>(
    fetch(`${base()}/api/channels`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ type: "public", name: "closed" }),
    }),
  );
  store.updateChannel(closed.id, { archived: true });
  store.transaction(() => {
    for (let i = 0; i < queued; i++) {
      const later = realNow() + 3_600_000;
      store.scheduleMessage({
        channelId: channels[i % channels.length]!,
        userId: owner.user.id,
        text: `scheduled ${i}`,
        threadRootId: null,
        fileIds: [],
        sendAt: realNow() - 1000,
      });
      const held = store.scheduleMessage({
        channelId: closed.id,
        userId: owner.user.id,
        text: `held ${i}`,
        threadRootId: null,
        fileIds: [],
        sendAt: realNow() - 1000,
      });
      store.holdScheduled(held.id, "That channel is archived.", later);
    }
  });
  await measure(`Sending ${queued.toLocaleString()} due scheduled messages`, async () => {
    server!.flushScheduled();
    while (store.dueScheduled(realNow(), 1).length > 0)
      await new Promise((resolve) => setTimeout(resolve, 1));
  });
  await measure(`A tick with ${queued.toLocaleString()} held and waiting`, () =>
    server!.flushScheduled(),
  );
  db.prepare("UPDATE scheduled_messages SET next_attempt_at = 0 WHERE status = 'held'").run();
  await measure(`Checking ${queued.toLocaleString()} held again after their pause`, async () => {
    server!.flushScheduled();
    while (store.dueScheduled(realNow(), 1).length > 0)
      await new Promise((resolve) => setTimeout(resolve, 1));
  });
  await measure("Backing up while running", () =>
    backupWorkspace({ dataDir, out: join(dir, "backup") }),
  );
  await measure("Verifying that backup", () => verifyBackup(join(dir, "backup")));
  await measure(
    "Backing up on a worker thread",
    () =>
      new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL("./measure-stall-worker.mts", import.meta.url), {
          workerData: { dataDir, out: join(dir, "backup-worker"), tsxApi },
          // Only enough to load the worker file itself; it registers tsx for the rest.
          execArgv: process.execArgv,
        });
        worker.once("message", () => resolve());
        worker.once("error", reject);
      }),
  );
  await measure("Stopping", () => server!.stop());
  server = undefined;
  await measure("Starting on the seeded workspace", async () => {
    server = await createWorkspaceServer(options);
  });
  await server!.stop();
  server = undefined;
  await measure(`Starting with ${retentionDays}-day retention (first sweep)`, async () => {
    server = await createWorkspaceServer({ ...options, retentionDays });
  });
  await measure("One further retention sweep", () => server!.applyRetention());
} finally {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
}
