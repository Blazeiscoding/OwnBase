/**
 * What publishing costs in time, where F10 and F11 cut the work. Runs a real workspace server on a disk database and times:
 *
 * - F10: deleting a thread root with 20 replies, 21 deletion events, in a
 *   private channel of 50, 500 and 2,000 members, with nobody connected and
 *   with two members connected: how long the DELETE takes to answer, and
 *   how long until both connected members have all 21 frames.
 * - F11: posting a message in a channel whose one app has 1, 10 and 100
 *   subscriptions, on an isolated server so nothing is sent out: how long
 *   the POST takes to answer.
 *
 * Each figure is the median and 95th percentile of `--rounds` rounds (25 by
 * default) after three warm-up rounds. Run from the repository root with
 * the server package's tsx; the same script runs against an earlier commit
 * checked out elsewhere, to compare:
 *
 *   pnpm --filter @slackoss/server exec tsx ../../scripts/measure-publication.mts [--rounds=25] [--only=deletion|posting]
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createWorkspaceServer, type WorkspaceServer } from "../packages/server/src/server.js";
import { hashToken } from "../packages/server/src/auth.js";
import { PROTOCOL_VERSION } from "../packages/protocol/src/index.js";

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const ROUNDS = arg("rounds", 25);
const WARMUP = 3;

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};
const summary = (values: number[]) => ({
  median: Number(percentile(values, 50).toFixed(2)),
  p95: Number(percentile(values, 95).toFixed(2)),
});

async function start(isolated: boolean) {
  const dataDir = mkdtempSync(join(tmpdir(), "ownbase-publication-"));
  const server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
    isolated,
  } as Parameters<typeof createWorkspaceServer>[0]);
  return {
    server,
    async stop() {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function people(server: WorkspaceServer, count: number) {
  return Array.from({ length: count }, (_, i) =>
    server.store.createUser({
      handle: `person-${i}`,
      displayName: `Person ${i}`,
      passwordHash: "",
      salt: "",
      role: i === 0 ? "owner" : "member",
    }),
  );
}

function signIn(server: WorkspaceServer, userId: string) {
  const token = randomUUID();
  server.store.createSession(hashToken(token), userId);
  return token;
}

async function request(
  server: WorkspaceServer,
  token: string,
  path: string,
  method: string,
  body?: unknown,
) {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

/** A connected member, counting the deletion frames it is sent. */
async function connect(server: WorkspaceServer, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  let deleted = 0;
  let waiting: { count: number; resolve: () => void } | null = null;
  let synced!: () => void;
  const ready = new Promise<void>((resolve) => (synced = resolve));
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "synced") synced();
    if (frame.type === "event" && frame.envelope.event.type === "message.deleted") {
      deleted++;
      if (waiting && deleted >= waiting.count) waiting.resolve();
    }
  });
  ws.addEventListener("open", () =>
    ws.send(
      JSON.stringify({
        type: "hello",
        token,
        lastSeq: null,
        syncVersion: 1,
        protocolVersion: PROTOCOL_VERSION,
      }),
    ),
  );
  await ready;
  return {
    /** Resolves once `count` more deletion frames have arrived than now. */
    expect(count: number) {
      const target = deleted + count;
      return new Promise<void>((resolve) => {
        if (deleted >= target) return resolve();
        waiting = { count: target, resolve };
      });
    },
    close: () => ws.close(),
  };
}

async function privateDeletion(members: number, online: number) {
  const { server, stop } = await start(false);
  try {
    const everyone = people(server, members);
    const author = signIn(server, everyone[0]!.id);
    const channel = server.store.createChannel({
      type: "private",
      name: "measured",
      creatorId: everyone[0]!.id,
      memberIds: everyone.map((p) => p.id),
    });
    const watchers = [];
    for (const person of everyone.slice(1, 1 + online))
      watchers.push(await connect(server, signIn(server, person.id)));
    const answered: number[] = [];
    const delivered: number[] = [];
    for (let round = 0; round < WARMUP + ROUNDS; round++) {
      const root = (
        await request(server, author, `/api/channels/${channel.id}/messages`, "POST", {
          text: "root",
        })
      ).body.message;
      for (let i = 0; i < 20; i++)
        await request(server, author, `/api/channels/${channel.id}/messages`, "POST", {
          text: `reply ${i}`,
          threadRootId: root.id,
        });
      const arrivals = watchers.map((w) => w.expect(21));
      const began = performance.now();
      const deleted = await request(server, author, `/api/messages/${root.id}`, "DELETE");
      const answeredAt = performance.now();
      if (deleted.status !== 200) throw new Error(`Deletion answered ${deleted.status}`);
      await Promise.all(arrivals);
      const deliveredAt = performance.now();
      if (round < WARMUP) continue;
      answered.push(answeredAt - began);
      if (watchers.length) delivered.push(deliveredAt - began);
    }
    for (const w of watchers) w.close();
    return {
      members,
      online,
      deleteAnsweredMs: summary(answered),
      ...(watchers.length ? { allFramesReceivedMs: summary(delivered) } : {}),
    };
  } finally {
    await stop();
  }
}

async function appPosting(subscriptions: number) {
  const { server, stop } = await start(true);
  try {
    const [owner] = people(server, 1);
    const token = signIn(server, owner!.id);
    const general = server.store.createChannel({
      type: "public",
      name: "measured",
      creatorId: owner!.id,
      memberIds: [owner!.id],
    });
    const bot = server.store.createBotUser("bot-measured", "measured", "", "");
    server.store.addMember(general.id, bot.id);
    const app = server.store.createApp({
      name: "measured",
      botUserId: bot.id,
      createdBy: owner!.id,
      signingSecret: "measurement-signing-secret-not-a-credential",
    });
    for (let i = 0; i < subscriptions; i++)
      server.store.createSubscription({
        appId: app.id,
        url: `https://example.invalid/${i}`,
        eventTypes: [],
      });
    const answered: number[] = [];
    for (let round = 0; round < WARMUP + ROUNDS; round++) {
      const began = performance.now();
      const posted = await request(server, token, `/api/channels/${general.id}/messages`, "POST", {
        text: `measured ${round}`,
      });
      const took = performance.now() - began;
      if (posted.status !== 201) throw new Error(`Posting answered ${posted.status}`);
      if (round >= WARMUP) answered.push(took);
    }
    return { subscriptions, postAnsweredMs: summary(answered) };
  } finally {
    await stop();
  }
}

const revision = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();
const results = {
  revision,
  node: process.version,
  cpu: cpus()[0]?.model,
  cores: cpus().length,
  memoryGiB: Math.round(totalmem() / 2 ** 30),
  rounds: ROUNDS,
  privateDeletion: [] as unknown[],
  appPosting: [] as unknown[],
};
// `--only=deletion` or `--only=posting` runs one half, say for more rounds.
const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
if (only !== "posting")
  for (const members of [50, 500, 2000])
    for (const online of [0, 2])
      results.privateDeletion.push(await privateDeletion(members, online));
if (only !== "deletion")
  for (const subscriptions of [1, 10, 100])
    results.appPosting.push(await appPosting(subscriptions));
console.log(JSON.stringify(results, null, 2));
