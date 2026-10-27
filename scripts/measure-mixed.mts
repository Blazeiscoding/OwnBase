/**
 * A mixed workload on one server, repeatable enough to compare two builds
 * (IMP-07). People post in several channels while others search, devices
 * drop and reconnect, and maintenance runs, all at once, on a workspace
 * seeded from `--seed`. Every post must reach every connected device, every
 * search must answer, every reconnect must catch up; the fixture is checked
 * before anything is timed, and a run with errors says so rather than
 * reporting the speed of failing.
 *
 * Uses Node's own WebSocket, so it needs nothing the root does not have.
 *
 * What a pass proves, not only how fast it went (F12): each round seeds
 * conversation past the retention window, with attachments, and maintenance
 * must remove exactly that through the production sweep; a device that drops
 * stays offline while posts arrive and must receive exactly the events it
 * missed, in order, or say it was sent a snapshot instead; seeded history
 * has the event log behind it, so no watermark runs past the checkpoint.
 * The harness drops what it has checked, so its own memory does not grow
 * with the run, and it records how much work was offered and completed.
 *
 * Writes one JSON artifact: the source revision, seed and parameters, the
 * machine and runtime, then per measure the samples, p50/p95/p99, spread
 * across rounds and errors; plus how long the event loop went unserved and
 * memory before and after. Run with the server package's tsx:
 *
 *   pnpm --filter @ownbase/server exec tsx ../../scripts/measure-mixed.mts \
 *     [--seed=1] [--people=12] [--devices=2] [--history=20000] [--rounds=3] \
 *     [--seconds=8] [--expired=200] [--out=mixed.json]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, sep } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { PROTOCOL_VERSION, type ServerToClient } from "../packages/protocol/src/index.js";
import { createWorkspaceServer, type WorkspaceServer } from "../packages/server/src/index.js";

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const params = {
  seed: arg("seed", 1),
  people: arg("people", 12),
  devices: arg("devices", 2),
  history: arg("history", 20_000),
  rounds: arg("rounds", 3),
  seconds: arg("seconds", 8),
  /** Messages past the retention window seeded before each round's maintenance. */
  expired: arg("expired", 200),
};
const out = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1];
// Actors 0–7 post, search and roam; fewer people would leave some unplayed.
if (!(params.people >= 8 && params.devices >= 1 && params.rounds >= 1 && params.seconds > 0))
  throw new Error("needs --people of at least 8, and at least one device, round and second");
const RETENTION_DAYS = 365;
const DAY = 24 * 3600_000;

/** A small seeded generator, so a seed always makes the same workspace and workload. */
function generator(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = generator(params.seed);
const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;

const WORDS =
  "the release plan design review ship friday numbers quarterly budget customer bug fix deploy staging meeting notes draft proposal roadmap sprint retro launch onboarding migration database search thread reply".split(
    " ",
  );
const SEARCHED = ["release", "budget", "deploy", "roadmap", "migration", "zeppelin"];
const sentence = (length: number) =>
  Array.from({ length }, () => pick(WORDS)).join(" ") + (random() < 0.001 ? " zeppelin" : "");

/** The body of a successful response; anything else is an error for the run. */
async function succeeded<T = unknown>(response: Response): Promise<T> {
  if (!response.ok)
    throw new Error(`${response.url} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** Samples of one measure, and what failed while taking them. */
class Measure {
  readonly rounds: number[][] = [];
  errors = 0;
  readonly firstErrors: string[] = [];
  round() {
    this.rounds.push([]);
  }
  add(ms: number) {
    this.rounds.at(-1)!.push(ms);
  }
  fail(error: unknown) {
    this.errors++;
    if (this.firstErrors.length < 3)
      this.firstErrors.push(error instanceof Error ? error.message : String(error));
  }
  summary() {
    const all = this.rounds.flat().sort((a, b) => a - b);
    const at = (q: number, xs = all) =>
      xs.length ? +xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!.toFixed(2) : null;
    const p95s = this.rounds.map(
      (r) =>
        at(
          0.95,
          [...r].sort((a, b) => a - b),
        ) ?? 0,
    );
    const mean = p95s.reduce((s, x) => s + x, 0) / Math.max(1, p95s.length);
    return {
      samples: all.length,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: all.length ? +all.at(-1)!.toFixed(2) : null,
      p95ByRound: p95s,
      // Spread of the rounds' p95 around their mean: how far one run can be trusted.
      p95SpreadPct:
        p95s.length > 1 ? +(((Math.max(...p95s) - Math.min(...p95s)) / mean) * 100).toFixed(1) : 0,
      errors: this.errors,
      ...(this.firstErrors.length ? { firstErrors: this.firstErrors } : {}),
    };
  }
}

function revision() {
  try {
    const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
    const head = git(["rev-parse", "HEAD"]);
    // The whole tree, research notes included; and, apart, whether the
    // application's own source differs from the commit.
    const dirty = git(["status", "--porcelain"]) !== "";
    const sourceChanged = git(["status", "--porcelain", "--", "packages", "apps"]) !== "";
    return { revision: head, dirty, sourceChanged };
  } catch {
    return { revision: process.env.GITHUB_SHA ?? "unknown", dirty: null, sourceChanged: null };
  }
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ownbase-mixed-")));
let server: WorkspaceServer | undefined;
/** Open sockets only: a closed one is let go, so the harness does not keep it. */
const sockets = new Set<WebSocket>();
const measures = {
  post: new Measure(),
  fanout: new Measure(),
  search: new Measure(),
  reconnect: new Measure(),
  maintenance: new Measure(),
};
const loop: { p50: number; p99: number; max: number }[] = [];
try {
  server = await createWorkspaceServer({
    dataDir: join(dir, "workspace"),
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
    retentionDays: RETENTION_DAYS,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, token: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  // People, channels everyone is in, and seeded history.
  const people: { token: string; id: string }[] = [];
  for (let i = 0; i < params.people; i++) {
    const { token, user } = await succeeded<{ token: string; user: { id: string } }>(
      await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handle: `person${i}`,
          displayName: `Person ${i}`,
          password: "password123",
        }),
      }),
    );
    people.push({ token, id: user.id });
  }
  const store = server.store;
  const channels = [store.getChannelByName("general")!.id];
  for (const name of ["design", "engineering", "support"]) {
    const { channel } = await succeeded<{ channel: { id: string } }>(
      await post("/api/channels", people[0]!.token, { type: "public", name }),
    );
    channels.push(channel.id);
  }
  for (const channelId of channels)
    for (const person of people) store.addMember(channelId, person.id);
  const realNow = Date.now.bind(Date);
  /**
   * Writes a message as the server would have when `at` was now: the row,
   * its event in the log, and its sequence number from that event, so no
   * channel's watermark runs past the checkpoint a snapshot reports.
   */
  const seedMessage = (at: number, channelId: string, text: string) => {
    Date.now = () => Math.floor(at);
    try {
      const message = store.createMessage({
        channelId,
        userId: pick(people).id,
        text,
        threadRootId: null,
        nonce: null,
      });
      const envelope = store.appendEvent({ type: "message.created", message }, channelId);
      store.stampMessageSeq(message.id, channelId, envelope.seq);
      return message;
    } finally {
      Date.now = realNow;
    }
  };
  const start = realNow() - 180 * DAY;
  const step = (180 * DAY) / params.history;
  for (let batch = 0; batch < params.history; batch += 1000) {
    store.transaction(() => {
      for (let i = batch; i < Math.min(params.history, batch + 1000); i++)
        seedMessage(start + i * step, pick(channels), sentence(8 + Math.floor(random() * 30)));
    });
  }
  // The seeded history is coherent before anything is timed.
  const checkpoint = store.currentSeq();
  const watermarks = Object.values(store.channelLastSeqMap(people[0]!.id));
  if (watermarks.some((seq) => seq > checkpoint))
    throw new Error("fixture check: a channel's watermark runs past the event checkpoint");
  const page = await succeeded<{ messages: { seq?: number; createdAt: number }[] }>(
    await fetch(`${base}/api/channels/${channels[0]}/messages?limit=50`, {
      headers: { authorization: `Bearer ${people[0]!.token}` },
    }),
  );
  if (
    page.messages.length !== 50 ||
    page.messages.some((m, i) => i > 0 && m.createdAt > page.messages[i - 1]!.createdAt) ||
    page.messages.some((m) => (m.seq ?? 0) > checkpoint)
  )
    throw new Error(
      "fixture check: seeded history does not page newest first within the checkpoint",
    );

  /**
   * Conversation past the retention window, with attachments, that this
   * round's maintenance must remove: what it seeded, to check against.
   */
  const filesDir = join(dir, "workspace", "files");
  const seedExpired = () => {
    const at = realNow() - (RETENTION_DAYS + 30) * DAY;
    const messages: string[] = [];
    const files: string[] = [];
    store.transaction(() => {
      for (let i = 0; i < params.expired; i++) {
        const channelId = pick(channels);
        const message = seedMessage(at + i, channelId, `expired ${sentence(6)}`);
        messages.push(message.id);
        if (i % 10 === 0) {
          Date.now = () => at + i;
          try {
            const file = store.createFile({
              channelId,
              userId: message.userId,
              name: `old-${i}.txt`,
              mime: "text/plain",
              size: 5,
              width: null,
              height: null,
            });
            writeFileSync(join(filesDir, file.id), "bytes");
            if (!store.attachFiles([file.id], message.id, channelId, message.userId))
              throw new Error("fixture: could not attach a seeded file");
            files.push(file.id);
          } finally {
            Date.now = realNow;
          }
        }
      }
    });
    return { messages, files };
  };

  // Every device of every person, connected and caught up.
  type Device = {
    ws: WebSocket;
    person: number;
    /** Texts of posts not yet checked, as they arrived; only for devices that check fanout. */
    seen: Map<string, number> | null;
    seq: number;
    /** On a reconnect: whether replay was offered, and the events replayed. */
    replayFrom: number | null | undefined;
    replayed: number[];
  };
  /** Exact replays, snapshots sent instead, and how many events were replayed. */
  const replay = { exact: 0, snapshots: 0, events: 0, missedWhileOffline: 0 };
  const connect = (person: number, lastSeq: number | null, tracks = true) =>
    new Promise<Device>((resolve, reject) => {
      const ws = new WebSocket(base.replace("http", "ws") + "/ws");
      sockets.add(ws);
      ws.addEventListener("close", () => sockets.delete(ws));
      const device: Device = {
        ws,
        person,
        seen: tracks ? new Map() : null,
        seq: lastSeq ?? 0,
        replayFrom: undefined,
        replayed: [],
      };
      let synced = false;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("not caught up within 10 s"));
      }, 10_000);
      ws.addEventListener("message", (message) => {
        const frame = JSON.parse(String(message.data)) as ServerToClient;
        if (frame.type === "ready") device.replayFrom = frame.replayFrom;
        else if (frame.type === "event") {
          device.seq = Math.max(device.seq, frame.envelope.seq);
          if (!synced) device.replayed.push(frame.envelope.seq);
          if (device.seen && frame.envelope.event.type === "message.created")
            device.seen.set(frame.envelope.event.message.text, performance.now());
        } else if (frame.type === "synced") {
          // Caught up: the snapshot, then everything since `lastSeq`.
          synced = true;
          device.seq = Math.max(device.seq, frame.seq);
          clearTimeout(timer);
          if (lastSeq !== null) {
            // Exactly the events this account may see since `lastSeq`, in
            // order, up to the checkpoint it was told; or a snapshot instead,
            // said so.
            const expected = (store.eventsSince(lastSeq, people[person]!.id) ?? [])
              .map((e) => e.seq)
              .filter((seq) => seq <= frame.seq);
            if (device.replayFrom === null) replay.snapshots++;
            else if (JSON.stringify(expected) !== JSON.stringify(device.replayed)) {
              ws.close();
              reject(
                new Error(
                  `replay after ${lastSeq} sent ${device.replayed.length} events, not the ${expected.length} expected in order`,
                ),
              );
              return;
            } else {
              replay.exact++;
              replay.events += expected.length;
            }
          }
          resolve(device);
        }
      });
      ws.addEventListener("error", () => reject(new Error("socket error")));
      ws.addEventListener("open", () =>
        ws.send(
          JSON.stringify({
            type: "hello",
            token: people[person]!.token,
            lastSeq,
            syncVersion: 1,
            protocolVersion: PROTOCOL_VERSION,
          }),
        ),
      );
    });
  const devices: Device[] = [];
  for (let p = 0; p < params.people; p++)
    for (let d = 0; d < params.devices; d++) devices.push(await connect(p, null));
  const arrived = (text: string) => devices.every((d) => d.seen!.has(text));
  /** Once checked, a post's receipts are let go, so tracking does not grow with the run. */
  const forget = (text: string) => {
    for (const d of devices) d.seen!.delete(text);
  };

  // Checked before anything is timed: a post reaches every device, a search answers.
  const check = `fixture check ${realNow()}`;
  await succeeded(
    await post(`/api/channels/${channels[0]}/messages`, people[0]!.token, { text: check }),
  );
  const deadline = realNow() + 5_000;
  while (!arrived(check) && realNow() < deadline) await new Promise((r) => setTimeout(r, 20));
  if (!arrived(check)) throw new Error("fixture check: a post did not reach every device");
  forget(check);
  const found = await succeeded<{ messages: unknown[] }>(
    await fetch(`${base}/api/search?q=release`, {
      headers: { authorization: `Bearer ${people[0]!.token}` },
    }),
  );
  if (found.messages.length === 0) throw new Error("fixture check: search found nothing seeded");

  const memoryBefore = process.memoryUsage();
  let posted = 0;
  /** Per round: how long it took, and how much work was offered and completed. */
  const work: Record<string, number>[] = [];
  for (let round = 0; round < params.rounds; round++) {
    for (const m of Object.values(measures)) m.round();
    const due = seedExpired();
    const load = {
      postsOffered: 0,
      postsCompleted: 0,
      searchesOffered: 0,
      searchesCompleted: 0,
      reconnectsOffered: 0,
      reconnectsCompleted: 0,
      receiptsInFlightMax: 0,
      expiredSeeded: due.messages.length,
      expiredFilesSeeded: due.files.length,
      expiredRemoved: 0,
    };
    let receiptsInFlight = 0;
    const began = performance.now();
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    const until = realNow() + params.seconds * 1000;
    const waiting: Promise<void>[] = [];

    const chatter = async (person: number) => {
      while (realNow() < until) {
        const text = `round ${round} post ${posted++} ${sentence(10)}`;
        const sent = performance.now();
        load.postsOffered++;
        try {
          await succeeded(
            await post(`/api/channels/${pick(channels)}/messages`, people[person]!.token, { text }),
          );
          measures.post.add(performance.now() - sent);
          load.postsCompleted++;
          load.receiptsInFlightMax = Math.max(load.receiptsInFlightMax, ++receiptsInFlight);
          waiting.push(
            (async () => {
              const giveUp = realNow() + 10_000;
              while (!arrived(text) && realNow() < giveUp)
                await new Promise((r) => setTimeout(r, 5));
              if (!arrived(text))
                measures.fanout.fail(new Error("a post did not reach every device in 10 s"));
              else measures.fanout.add(Math.max(...devices.map((d) => d.seen!.get(text)!)) - sent);
              forget(text);
              receiptsInFlight--;
            })(),
          );
        } catch (error) {
          measures.post.fail(error);
        }
        await new Promise((r) => setTimeout(r, 40 + random() * 80));
      }
    };
    const searcher = async (person: number) => {
      while (realNow() < until) {
        const sent = performance.now();
        load.searchesOffered++;
        try {
          await succeeded(
            await fetch(`${base}/api/search?q=${encodeURIComponent(pick(SEARCHED))}`, {
              headers: { authorization: `Bearer ${people[person]!.token}` },
            }),
          );
          measures.search.add(performance.now() - sent);
          load.searchesCompleted++;
        } catch (error) {
          measures.search.fail(error);
        }
        await new Promise((r) => setTimeout(r, 100 + random() * 200));
      }
    };
    // A device of its own drops, stays away while posts arrive, and comes
    // back with exactly what it missed.
    const roamer = async (person: number) => {
      let device = await connect(person, null, false);
      while (realNow() < until) {
        await new Promise((r) => setTimeout(r, 300 + random() * 700));
        const lastSeq = device.seq;
        device.ws.close();
        await new Promise((r) => setTimeout(r, 200 + random() * 400));
        replay.missedWhileOffline += store.currentSeq() - lastSeq;
        const sent = performance.now();
        load.reconnectsOffered++;
        try {
          device = await connect(person, lastSeq, false);
          measures.reconnect.add(performance.now() - sent);
          load.reconnectsCompleted++;
        } catch (error) {
          measures.reconnect.fail(error);
          device = await connect(person, null, false);
        }
      }
      device.ws.close();
    };
    // The production sweep must remove exactly what was seeded past the window.
    const maintenance = async () => {
      await new Promise((r) => setTimeout(r, (params.seconds * 1000) / 2));
      const sent = performance.now();
      try {
        const removed = await server!.sweepRetention();
        await server!.flushFileDeletions();
        measures.maintenance.add(performance.now() - sent);
        load.expiredRemoved = removed;
        const left = due.messages.filter((id) => store.getMessage(id));
        const blobs = due.files.filter((id) => existsSync(join(filesDir, id)) || store.getFile(id));
        if (removed !== due.messages.length || left.length || blobs.length)
          throw new Error(
            `retention removed ${removed} of ${due.messages.length} expired messages; ${left.length} remain, ${blobs.length} files remain`,
          );
      } catch (error) {
        measures.maintenance.fail(error);
      }
    };
    await Promise.all([
      ...[0, 1, 2, 3].map(chatter),
      ...[4, 5].map(searcher),
      ...[6, 7].map(roamer),
      maintenance(),
    ]);
    await Promise.all(waiting);
    delay.disable();
    loop.push({
      p50: +(delay.percentile(50) / 1e6).toFixed(2),
      p99: +(delay.percentile(99) / 1e6).toFixed(2),
      max: +(delay.max / 1e6).toFixed(2),
    });
    work.push({ elapsedMs: +(performance.now() - began).toFixed(0), ...load });
  }
  const memoryAfter = process.memoryUsage();

  const result = {
    measure: "mixed chat/search/reconnect/maintenance (IMP-07)",
    ...revision(),
    params,
    machine: {
      cpu: cpus()[0]?.model ?? "unknown",
      cores: cpus().length,
      memoryGiB: +(totalmem() / 2 ** 30).toFixed(1),
      os: `${platform()} ${release()} ${arch()}`,
    },
    runtime: { node: process.version },
    cache: "warm: one process, fixture seeded before timing",
    devices: devices.length,
    workByRound: work,
    replay,
    // What the harness itself still holds: receipts and sockets it let go are not here.
    harness: {
      receiptsHeld: devices.reduce((n, d) => n + d.seen!.size, 0),
      socketsOpen: sockets.size,
    },
    note: "One Node process runs the server and every client: memory and event-loop delay are theirs together, not the server's alone, nor a desktop main process's.",
    results: Object.fromEntries(Object.entries(measures).map(([k, m]) => [k, m.summary()])),
    // Sampled every millisecond, so an idle loop reads about 1 ms.
    eventLoopDelayMsByRound: loop,
    memoryMiB: {
      rssBefore: +(memoryBefore.rss / 2 ** 20).toFixed(1),
      rssAfter: +(memoryAfter.rss / 2 ** 20).toFixed(1),
      heapUsedAfter: +(memoryAfter.heapUsed / 2 ** 20).toFixed(1),
    },
    errors: Object.values(measures).reduce((n, m) => n + m.errors, 0),
  };
  const json = JSON.stringify(result, null, 2);
  if (out) writeFileSync(out, json + "\n");
  console.log(json);
  if (result.errors > 0) process.exitCode = 1;
} finally {
  for (const ws of sockets) ws.close();
  await server?.stop().catch(() => {});
  // Only the folder this run made, under the system's temporary folder.
  if (dir.startsWith(realpathSync(tmpdir()) + sep) && dir.includes("ownbase-mixed-"))
    rmSync(dir, { recursive: true, force: true });
}
