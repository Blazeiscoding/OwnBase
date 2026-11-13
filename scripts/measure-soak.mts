/**
 * An hour of steady chat against one server, to see whether anything it holds
 * keeps growing (G15). The server runs on a real disk database in a process
 * of its own (measure-soak-server.mts), seeded with history; scripted people
 * talk to it over the real socket and REST, in this process: they post, edit,
 * delete, react, reply in threads, upload files, leave and join a channel,
 * drop and reconnect, sign in and out, read history and search, and hold
 * huddles that exchange the calls' setup messages without any media.
 *
 * Every `--sample-seconds` (a minute by default) it prints one line: the
 * server's resident memory, heap after a full collection, handles it holds
 * open, how long its event loop went unserved, the database and its WAL, the
 * files stored, and the 50th and 99th percentile of the time from sending a
 * message to two watching devices both having it. At the end it says, for
 * each line, whether it climbed for the whole run, and prints the samples as
 * JSON. A run with failed requests or lost messages exits with 1.
 *
 * A script, run by hand or by the Soak workflow on a GitHub runner, never in
 * the unit suites. With the server package's tsx:
 *
 *   pnpm --filter @ownbase/server exec tsx ../../scripts/measure-soak.mts \
 *     [--minutes=60] [--people=20] [--history=20000] [--sample-seconds=60] [--rate=1]
 */
import { execFileSync, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, type ServerToClient } from "../packages/protocol/src/index.js";

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const params = {
  minutes: arg("minutes", 60),
  people: arg("people", 20),
  history: arg("history", 20_000),
  sampleSeconds: arg("sample-seconds", 60),
  /** Multiplies how often everyone acts; 2 is twice the traffic. */
  rate: arg("rate", 1),
};
// The cast below gives people 0–17 a part each; more only add watchers' load.
if (!(params.people >= 18 && params.minutes > 0 && params.sampleSeconds > 0 && params.rate > 0))
  throw new Error("needs --people of at least 18, and positive minutes, sample seconds and rate");

/** A small seeded generator, so two runs offer the same traffic. */
let state = 1;
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
const WORDS =
  "the release plan design review ship friday numbers budget customer bug fix deploy staging notes draft roadmap sprint launch migration search thread".split(
    " ",
  );
const sentence = (length: number) => Array.from({ length }, () => pick(WORDS)).join(" ");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** About `ms` between one action and the next, varied so actors do not march in step. */
const pause = (ms: number) => sleep((ms * (0.5 + random())) / params.rate);
const MiB = (bytes: number) => +(bytes / 2 ** 20).toFixed(1);
const quantile = (sorted: number[], q: number) =>
  sorted.length
    ? +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(1)
    : null;

function revision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return process.env.GITHUB_SHA ?? "unknown";
  }
}

/** Counts of work done and failed, by kind, since the last sample and in all. */
const done = new Map<string, number>();
const failed = new Map<string, { count: number; first: string[] }>();
let doneInWindow = 0;
let failedInWindow = 0;
const count = (kind: string) => {
  done.set(kind, (done.get(kind) ?? 0) + 1);
  doneInWindow++;
};
const fail = (kind: string, error: unknown) => {
  const entry = failed.get(kind) ?? { count: 0, first: [] };
  entry.count++;
  if (entry.first.length < 3)
    entry.first.push(error instanceof Error ? error.message : String(error));
  failed.set(kind, entry);
  failedInWindow++;
};
/** Runs one action, counting it as done or failed, so one failure does not stop the actor. */
async function act(kind: string, work: () => Promise<unknown>) {
  try {
    await work();
    count(kind);
  } catch (error) {
    fail(kind, error);
  }
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ownbase-soak-")));
const dataDir = join(dir, "workspace");
const child = fork(
  fileURLToPath(new URL("./measure-soak-server.mts", import.meta.url)),
  [dataDir],
  {
    // tsx's loader is in this process's execArgv, so the server reads TypeScript too.
    execArgv: [...process.execArgv, "--expose-gc"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  },
);
type Reply = { type: string; [key: string]: unknown };
const replies: ((reply: Reply) => void)[] = [];
child.on("message", (reply: Reply) => replies.shift()?.(reply));
const next = () => new Promise<Reply>((resolve) => replies.push(resolve));
const ask = (request: object) => {
  const reply = next();
  child.send(request);
  return reply;
};
const sockets = new Set<WebSocket>();

try {
  const ready = (await next()) as unknown as { port: number; gc: boolean };
  if (!ready.gc) throw new Error("the server process was started without --expose-gc");
  const base = `http://127.0.0.1:${ready.port}`;

  async function call<T = unknown>(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ) {
    const form = body instanceof FormData;
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined || form ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `${method} ${path.replace(/[0-9A-Z]{20,}/g, ":id")} answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
      );
    return (await response.json()) as T;
  }

  // People, and the channels they talk in. A public channel takes in everyone.
  const people: { handle: string; token: string; id: string }[] = [];
  for (let i = 0; i < params.people; i++) {
    const handle = `person${i}`;
    const { token, user } = await call<{ token: string; user: { id: string } }>(
      "POST",
      "/api/auth/register",
      null,
      { handle, displayName: `Person ${i}`, password: "password123" },
    );
    people.push({ handle, token, id: user.id });
  }
  const owner = people[0]!.token;
  const channel = async (name: string) =>
    (
      await call<{ channel: { id: string } }>("POST", "/api/channels", owner, {
        type: "public",
        name,
      })
    ).channel.id;
  const { channels: listed } = await call<{ channels: { id: string; name: string }[] }>(
    "GET",
    "/api/channels",
    owner,
  );
  const talk = [
    listed.find((c) => c.name === "general")!.id,
    await channel("design"),
    await channel("engineering"),
  ];
  const dropIn = await channel("drop-in");
  const standup = await channel("standup");
  const seeded = Date.now();
  await ask({
    type: "seed",
    messages: params.history,
    channelIds: talk,
    userIds: people.map((p) => p.id),
  });
  console.log(
    `seeded ${params.history} messages in ${((Date.now() - seeded) / 1000).toFixed(1)} s`,
  );

  /** Sent top-level messages not yet seen by both watchers: text -> when sent, watchers seen. */
  const pending = new Map<string, { sent: number; seen: number }>();
  const WATCHERS = 2;
  /** Who holds the huddles; only their devices keep huddle events, for its checks. */
  const HUDDLE_CAST = [14, 15, 16];
  let latencies: number[] = [];

  type Device = {
    ws: WebSocket;
    person: number;
    seq: number;
    /** Ephemeral events this device was sent, for the huddle's checks; drained by them. */
    ephemeral: { type: string; [key: string]: unknown }[];
    /** Set before this side closes the socket or signs out, so that is not a failure. */
    leaving: boolean;
  };
  /** Opens a device for `person` and resolves once it is caught up. */
  const connect = (person: number, lastSeq: number | null, token = people[person]!.token) =>
    new Promise<Device>((resolve, reject) => {
      const ws = new WebSocket(base.replace("http", "ws") + "/ws");
      sockets.add(ws);
      const device: Device = { ws, person, seq: lastSeq ?? 0, ephemeral: [], leaving: false };
      ws.addEventListener("close", (event) => {
        sockets.delete(ws);
        if (!device.leaving)
          fail("socket", new Error(`closed by the server: ${event.code} ${event.reason}`));
      });
      const watcher = person < WATCHERS;
      let replayedFrom = lastSeq ?? 0;
      const timer = setTimeout(() => {
        device.leaving = true;
        ws.close();
        reject(new Error("not caught up within 10 s"));
      }, 10_000);
      ws.addEventListener("message", (message) => {
        const frame = JSON.parse(String(message.data)) as ServerToClient;
        if (frame.type === "event") {
          // Replayed and live events alike come in order.
          if (frame.envelope.seq <= replayedFrom)
            fail("replay", new Error(`event ${frame.envelope.seq} after ${replayedFrom}`));
          replayedFrom = frame.envelope.seq;
          device.seq = Math.max(device.seq, frame.envelope.seq);
          const event = frame.envelope.event;
          if (watcher && event.type === "message.created") {
            const entry = pending.get(event.message.text);
            if (entry && ++entry.seen === WATCHERS) {
              latencies.push(performance.now() - entry.sent);
              pending.delete(event.message.text);
            }
          }
        } else if (frame.type === "ephemeral") {
          if (HUDDLE_CAST.includes(person) && frame.event.type.startsWith("huddle."))
            device.ephemeral.push(frame.event);
        } else if (frame.type === "synced") {
          device.seq = Math.max(device.seq, frame.seq);
          clearTimeout(timer);
          resolve(device);
        } else if (frame.type === "error" && !device.leaving) {
          fail("socket", new Error(`${frame.code}: ${frame.message}`));
        }
      });
      ws.addEventListener("error", () => reject(new Error("socket error")));
      ws.addEventListener("open", () =>
        ws.send(
          JSON.stringify({ type: "hello", token, lastSeq, protocolVersion: PROTOCOL_VERSION }),
        ),
      );
    });
  const closed = (device: Device) =>
    new Promise<void>((resolve) => {
      const ws = device.ws;
      device.leaving = true;
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.addEventListener("close", () => resolve());
      ws.close();
    });

  // One device a person; people 0 and 1 watch every channel and never drop.
  const devices: Device[] = [];
  for (let p = 0; p < params.people; p++) devices.push(await connect(p, null));

  const until = Date.now() + params.minutes * 60_000;
  const running = () => Date.now() < until;

  /** Messages posted lately, for edits, deletes, reactions and replies: bounded. */
  type Posted = { id: string; channelId: string; author: number; text: string; files: number };
  const recent: Posted[] = [];
  const remember = (posted: Posted) => {
    recent.push(posted);
    if (recent.length > 300) recent.splice(0, recent.length - 300);
  };
  const forget = (id: string) => {
    const at = recent.findIndex((m) => m.id === id);
    if (at >= 0) recent.splice(at, 1);
  };
  let serial = 0;
  const post = async (person: number, channelId: string, fileIds?: string[]) => {
    const text = `${sentence(6 + Math.floor(random() * 20))} #${serial++}`;
    devices[person]!.ws.send(JSON.stringify({ type: "typing", channelId }));
    if (talk.includes(channelId)) pending.set(text, { sent: performance.now(), seen: 0 });
    const { message } = await call<{ message: { id: string } }>(
      "POST",
      `/api/channels/${channelId}/messages`,
      people[person]!.token,
      { text, ...(fileIds ? { fileIds } : {}) },
    );
    remember({ id: message.id, channelId, author: person, text, files: fileIds?.length ?? 0 });
  };

  // People 2–7 talk: mostly new messages, and edits, deletes and thread replies.
  const talker = async (person: number) => {
    while (running()) {
      const roll = random();
      const own = recent.filter((m) => m.author === person);
      if (roll < 0.7 || own.length === 0) await act("post", () => post(person, pick(talk)));
      else if (roll < 0.82) {
        const message = pick(own);
        const text = `${message.text} (edited)`;
        await act("edit", async () => {
          await call("PATCH", `/api/messages/${message.id}`, people[person]!.token, {
            text,
            expectedText: message.text,
          });
          message.text = text;
        });
      } else if (roll < 0.88) {
        const message = pick(own);
        forget(message.id);
        await act("delete", () =>
          call("DELETE", `/api/messages/${message.id}`, people[person]!.token),
        );
      } else {
        const roots = recent.filter((m) => talk.includes(m.channelId));
        const root = roots.length > 0 ? pick(roots) : own[0]!;
        await act("reply", () =>
          call("POST", `/api/channels/${root.channelId}/messages`, people[person]!.token, {
            text: `${sentence(8)} in reply`,
            threadRootId: root.id,
          }),
        );
      }
      await pause(1500);
    }
  };
  // People 8 and 9 react, and take their reactions off again.
  const reactor = async (person: number) => {
    const mine: { id: string; emoji: string }[] = [];
    while (running()) {
      if (mine.length > 10 || (mine.length > 0 && random() < 0.4)) {
        const { id, emoji } = mine.shift()!;
        await act("unreact", () =>
          call(
            "DELETE",
            `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`,
            people[person]!.token,
          ).catch((error: Error) => {
            // Its message was deleted meanwhile, which is not the server's fault.
            if (!/answered 404/.test(error.message)) throw error;
          }),
        );
      } else if (recent.some((m) => talk.includes(m.channelId))) {
        const message = pick(recent.filter((m) => talk.includes(m.channelId)));
        const emoji = pick(["👍", "🎉", "👀", "❤️"]);
        await act("react", async () => {
          await call(
            "PUT",
            `/api/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`,
            people[person]!.token,
          );
          mine.push({ id: message.id, emoji });
        });
      }
      await pause(2000);
    }
  };
  // Person 10 shares files, from 1 to 64 kB, and deletes the older ones.
  const uploader = async (person: number) => {
    while (running()) {
      const mine = recent.filter((m) => m.author === person && m.files > 0);
      if (mine.length > 5) {
        const message = mine[0]!;
        forget(message.id);
        await act("delete file", () =>
          call("DELETE", `/api/messages/${message.id}`, people[person]!.token),
        );
      } else {
        const channelId = pick(talk);
        await act("upload", async () => {
          const form = new FormData();
          form.append(
            "file",
            new Blob([randomBytes(1024 + Math.floor(random() * 63 * 1024))]),
            `notes-${serial}.bin`,
          );
          const { file } = await call<{ file: { id: string } }>(
            "POST",
            `/api/channels/${channelId}/files`,
            people[person]!.token,
            form,
          );
          await post(person, channelId, [file.id]);
        });
      }
      await pause(10_000);
    }
  };
  // People 11 and 12 leave #drop-in and come back, saying something while in.
  const roamer = async (person: number) => {
    while (running()) {
      await act("post", () => post(person, dropIn));
      await pause(3000);
      await act("leave", () =>
        call("POST", `/api/channels/${dropIn}/leave`, people[person]!.token),
      );
      await pause(3000);
      await act("join", () => call("POST", `/api/channels/${dropIn}/join`, people[person]!.token));
      await pause(2000);
    }
  };
  // Devices of people 2–12 drop and come back with what they missed.
  const reconnector = async () => {
    while (running()) {
      await pause(6000);
      const person = 2 + Math.floor(random() * 11);
      const device = devices[person]!;
      await act("reconnect", async () => {
        await closed(device);
        await pause(1000);
        devices[person] = await connect(person, device.seq);
      });
    }
  };
  // Person 13 signs in on another device, looks around and signs out.
  const visitor = async (person: number) => {
    while (running()) {
      await act("sign in and out", async () => {
        const { token } = await call<{ token: string }>("POST", "/api/auth/login", null, {
          handle: people[person]!.handle,
          password: "password123",
        });
        const device = await connect(person, null, token);
        await call("GET", "/api/me", token);
        device.leaving = true;
        await call("POST", "/api/auth/logout", token);
        await closed(device);
      });
      await pause(20_000);
    }
  };
  // People 14–16 hold a huddle in #standup: join, set up the calls between
  // each pair, say what they send, and leave. No media flows.
  const waitFor = async (
    device: Device,
    type: string,
    match: (e: Record<string, unknown>) => boolean,
  ) => {
    const giveUp = Date.now() + 10_000;
    while (Date.now() < giveUp) {
      const at = device.ephemeral.findIndex((e) => e.type === type && match(e));
      if (at >= 0) return device.ephemeral.splice(at, 1)[0]!;
      await sleep(20);
    }
    throw new Error(
      `no ${type} within 10 s; had ${JSON.stringify(device.ephemeral)} state ${device.ws.readyState}`,
    );
  };
  const huddle = async () => {
    const cast = HUDDLE_CAST;
    let round = 0;
    while (running()) {
      await act("huddle", async () => {
        for (const person of cast) {
          const device = devices[person]!;
          device.ephemeral.length = 0;
          const requestId = `join-${person}-${round}`;
          device.ws.send(JSON.stringify({ type: "huddle.join", channelId: standup, requestId }));
          const result = await waitFor(
            device,
            "huddle.join.result",
            (e) => e.requestId === requestId,
          );
          if (!result.accepted) throw new Error(`huddle join refused: ${JSON.stringify(result)}`);
        }
        const signal = (from: number, to: number, body: object) =>
          devices[from]!.ws.send(
            JSON.stringify({
              type: "huddle.signal",
              channelId: standup,
              to: people[to]!.id,
              signal: body,
            }),
          );
        for (const [a, b] of [
          [14, 15],
          [14, 16],
          [15, 16],
        ] as const) {
          signal(a, b, { kind: "offer", sdp: `v=0 offer ${"x".repeat(2000)}` });
          await waitFor(devices[b]!, "huddle.signal", (e) => e.from === people[a]!.id);
          signal(b, a, { kind: "answer", sdp: `v=0 answer ${"x".repeat(2000)}` });
          await waitFor(devices[a]!, "huddle.signal", (e) => e.from === people[b]!.id);
          for (let i = 0; i < 4; i++) {
            const candidate = {
              candidate: `candidate:${i} 1 udp 2122260223 192.0.2.${i} 5000${i} typ host`,
              sdpMid: "0",
              sdpMLineIndex: 0,
            };
            signal(a, b, { kind: "ice", candidate });
            signal(b, a, { kind: "ice", candidate });
          }
        }
        for (const person of cast)
          for (const other of cast)
            if (other !== person)
              signal(person, other, {
                kind: "media",
                camera: false,
                screen: false,
                muted: random() < 0.5,
                screenSound: false,
                view: { camera: 360, screen: 0 },
              });
        await pause(8000);
        for (const person of cast) {
          devices[person]!.ws.send(JSON.stringify({ type: "huddle.leave", channelId: standup }));
          devices[person]!.ephemeral.length = 0;
        }
      });
      round++;
      await pause(7000);
    }
  };
  // Person 17 reads: a page of history, a thread, and a search.
  const reader = async (person: number) => {
    const token = people[person]!.token;
    while (running()) {
      await act("read", async () => {
        const channelId = pick(talk);
        await call("GET", `/api/channels/${channelId}/messages?limit=50`, token);
        const root = recent.find((m) => m.channelId === channelId);
        if (root)
          await call("GET", `/api/channels/${channelId}/threads/${root.id}`, token).catch(
            (error: Error) => {
              if (!/answered 404/.test(error.message)) throw error;
            },
          );
        await call("GET", `/api/search?q=${pick(["release", "budget", "roadmap"])}&tz=UTC`, token);
      });
      await pause(3000);
    }
  };

  // Every sample: what the server holds, the database on disk, and delivery.
  type Sample = {
    minute: number;
    rssMiB: number;
    heapMiB: number;
    externalMiB: number;
    handles: number;
    handleKinds: Record<string, number>;
    connected: number;
    loopP99Ms: number;
    loopMaxMs: number;
    dbMiB: number;
    walMiB: number;
    files: number;
    filesMiB: number;
    sendToReceiveP50Ms: number | null;
    sendToReceiveP99Ms: number | null;
    actions: number;
    failures: number;
  };
  const samples: Sample[] = [];
  const size = (file: string) => {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  };
  const started = Date.now();
  const sample = async () => {
    // A message sent 15 s ago that both watchers have not seen is lost.
    const now = performance.now();
    for (const [text, entry] of pending)
      if (now - entry.sent > 15_000) {
        pending.delete(text);
        fail(
          "delivery",
          new Error(`a message reached ${entry.seen} of ${WATCHERS} watchers in 15 s`),
        );
      }
    const server = (await ask({ type: "sample" })) as unknown as {
      rss: number;
      heapUsed: number;
      external: number;
      handles: Record<string, number>;
      connectedPeople: number;
      loop: { p99: number; max: number };
    };
    let files: string[] = [];
    try {
      files = readdirSync(join(dataDir, "files"));
    } catch {
      // Made with the first upload.
    }
    const sorted = latencies.sort((a, b) => a - b);
    latencies = [];
    const row: Sample = {
      minute: +((Date.now() - started) / 60_000).toFixed(1),
      rssMiB: MiB(server.rss),
      heapMiB: MiB(server.heapUsed),
      externalMiB: MiB(server.external),
      handles: Object.values(server.handles).reduce((n, c) => n + c, 0),
      handleKinds: server.handles,
      connected: server.connectedPeople,
      loopP99Ms: +server.loop.p99.toFixed(1),
      loopMaxMs: +server.loop.max.toFixed(1),
      dbMiB: MiB(size(join(dataDir, "workspace.db"))),
      walMiB: MiB(size(join(dataDir, "workspace.db-wal"))),
      files: files.length,
      filesMiB: MiB(files.reduce((n, f) => n + size(join(dataDir, "files", f)), 0)),
      sendToReceiveP50Ms: quantile(sorted, 0.5),
      sendToReceiveP99Ms: quantile(sorted, 0.99),
      actions: doneInWindow,
      failures: failedInWindow,
    };
    doneInWindow = 0;
    failedInWindow = 0;
    samples.push(row);
    console.log(
      [
        `${String(row.minute).padStart(5)} min`,
        `rss ${row.rssMiB} MiB`,
        `heap ${row.heapMiB} MiB`,
        `handles ${row.handles}`,
        `loop p99 ${row.loopP99Ms} ms`,
        `db ${row.dbMiB} MiB`,
        `wal ${row.walMiB} MiB`,
        `files ${row.files} (${row.filesMiB} MiB)`,
        `send to receive p50 ${row.sendToReceiveP50Ms} p99 ${row.sendToReceiveP99Ms} ms`,
        `${row.actions} actions`,
        `${row.failures} failed`,
      ].join(", "),
    );
  };
  const machine = {
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryGiB: +(totalmem() / 2 ** 30).toFixed(1),
    os: `${platform()} ${release()} ${arch()}`,
    node: process.version,
  };
  console.log(JSON.stringify({ revision: revision(), params, machine }));
  await sample();
  const sampler = (async () => {
    for (;;) {
      await sleep(Math.min(params.sampleSeconds * 1000, Math.max(0, until - Date.now())));
      if (!running()) return;
      await sample();
    }
  })();
  await Promise.all([
    ...[2, 3, 4, 5, 6, 7].map(talker),
    reactor(8),
    reactor(9),
    uploader(10),
    roamer(11),
    roamer(12),
    reconnector(),
    visitor(13),
    huddle(),
    reader(17),
    sampler,
  ]);
  // The last messages have had their time to arrive.
  await sleep(2000);
  await sample();

  /**
   * Whether a line climbed for the whole run: after a warm-up, the lowest
   * reading of the last third above the highest of the first third. Usage that
   * settles, or saws up and down, does not.
   */
  const trend = (values: number[]) => {
    const settled = values.slice(Math.min(5, Math.floor(values.length / 4)));
    const third = Math.max(1, Math.floor(settled.length / 3));
    const first = settled.slice(0, third);
    const last = settled.slice(-third);
    const n = settled.length;
    const meanX = (n - 1) / 2;
    const meanY = settled.reduce((s, y) => s + y, 0) / n;
    const slope =
      settled.reduce((s, y, x) => s + (x - meanX) * (y - meanY), 0) /
      Math.max(
        1e-9,
        settled.reduce((s, _, x) => s + (x - meanX) ** 2, 0),
      );
    return {
      from: settled[0],
      to: settled.at(-1),
      perHour: +((slope * 3600) / params.sampleSeconds).toFixed(2),
      climbs: settled.length >= 6 && Math.min(...last) > Math.max(...first),
    };
  };
  const series = {
    rssMiB: trend(samples.map((s) => s.rssMiB)),
    heapMiB: trend(samples.map((s) => s.heapMiB)),
    externalMiB: trend(samples.map((s) => s.externalMiB)),
    handles: trend(samples.map((s) => s.handles)),
    loopP99Ms: trend(samples.map((s) => s.loopP99Ms)),
    sendToReceiveP99Ms: trend(samples.flatMap((s) => s.sendToReceiveP99Ms ?? [])),
  };
  console.log("\nOver the run (from the first settled sample; per hour is the fitted slope):");
  for (const [name, t] of Object.entries(series))
    console.log(
      `  ${name.padEnd(20)} ${t.from} -> ${t.to}, ${t.perHour} per hour, ${t.climbs ? "CLIMBS" : "flat"}`,
    );
  console.log(
    `  database ${samples[0]!.dbMiB} -> ${samples.at(-1)!.dbMiB} MiB (it holds what was said, so it grows)`,
  );
  const failures = [...failed].map(([kind, f]) => ({ kind, ...f }));
  console.log(`  actions: ${JSON.stringify(Object.fromEntries(done))}`);
  console.log(`  failed: ${failures.length ? JSON.stringify(failures) : "none"}`);
  console.log(
    JSON.stringify({
      revision: revision(),
      params,
      machine,
      series,
      done: Object.fromEntries(done),
      failures,
      samples,
    }),
  );
  if (failures.length > 0) process.exitCode = 1;
} finally {
  for (const ws of sockets) ws.close();
  if (child.connected) await ask({ type: "stop" }).catch(() => {});
  child.kill();
  // Only the folder this run made, under the system's temporary folder.
  if (dir.startsWith(realpathSync(tmpdir()) + sep) && dir.includes("ownbase-soak-"))
    rmSync(dir, { recursive: true, force: true });
}
