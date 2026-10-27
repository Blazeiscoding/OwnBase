import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * App events go out through a pump (REV-15, slice B). An endpoint slow to
 * answer holds back only its own events: before, every round waited for its
 * slowest answer, so a healthy app got one event per held response. At most
 * ten are out at once, one per subscription, each subscription in order.
 */
type Arrival = { path: string; event: number };
let server: WorkspaceServer | undefined;
let endpoint: Server;
let endpointUrl: string;
let arrivals: Arrival[];
/** Answers being kept back, oldest first. */
let held: { path: string; res: ServerResponse }[];
let holding: Set<string>;
let ownerId: string;
let dataDir: string;

const start = (options: { isolated?: boolean } = {}) =>
  createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
    allowPrivateHooks: true,
    ...options,
  });

beforeEach(async () => {
  arrivals = [];
  held = [];
  holding = new Set();
  endpoint = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      const path = req.url!;
      arrivals.push({ path, event: (JSON.parse(text) as { event: number }).event });
      if (holding.has(path)) held.push({ path, res });
      else res.end("ok");
    });
  });
  await new Promise<void>((done) => endpoint.listen(0, "127.0.0.1", done));
  endpointUrl = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`;
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-delivery-pump-"));
  server = await start();
  ownerId = server.store.createUser({
    handle: "owner",
    displayName: "Owner",
    passwordHash: "",
    salt: "",
    role: "owner",
  }).id;
});

afterEach(async () => {
  for (const { res } of held.splice(0)) res.end("ok");
  await server?.stop();
  server = undefined;
  endpoint.closeAllConnections();
  await new Promise<void>((done) => endpoint.close(() => done()));
  rmSync(dataDir, { recursive: true, force: true });
});

/** An app subscribed at `/<name>` on the test endpoint. */
function subscribe(name: string): string {
  const store = server!.store;
  const bot = store.createBotUser(`bot-${name}`, name, "", "");
  const app = store.createApp({
    name,
    botUserId: bot.id,
    createdBy: ownerId,
    signingSecret: "test-signing-secret-not-a-credential",
  });
  return store.createSubscription({ appId: app.id, url: `${endpointUrl}/${name}`, eventTypes: [] })
    .id;
}

let seq = 0;
function queue(subscriptionId: string, event = ++seq): number {
  expect(
    server!.store.enqueueEventDelivery(subscriptionId, null, event, JSON.stringify({ event }), 0),
  ).toBe(true);
  return event;
}

const at = (path: string) => arrivals.filter((a) => a.path === path).map((a) => a.event);
const heldCount = () => held.length;
function release(path: string) {
  for (const { res } of held.filter((h) => h.path === path)) res.end("ok");
  held = held.filter((h) => h.path !== path);
}
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 5 });

describe("app events with an endpoint slow to answer (REV-15)", { timeout: 20_000 }, () => {
  it("holds back only that endpoint's own events", async () => {
    holding.add("/slow");
    const slow = subscribe("slow");
    const fast = subscribe("fast");
    const first = queue(slow);
    const fastEvents = [queue(fast), queue(fast), queue(fast)];
    const draining = server!.flushEventDeliveries();
    await eventually(() => expect(at("/fast")).toEqual(fastEvents));
    expect(at("/slow")).toEqual([first]);

    // New events while the slow answer is still out: asking again starts
    // them now, in the same flush, rather than when that answer comes.
    const later = [queue(fast), queue(fast)];
    const behind = queue(slow);
    expect(server!.flushEventDeliveries()).toBe(draining);
    await eventually(() => expect(at("/fast")).toEqual([...fastEvents, ...later]));
    expect(at("/slow")).toEqual([first]);
    expect(heldCount()).toBe(1);

    // The slow endpoint's next event follows its first, in order.
    holding.delete("/slow");
    release("/slow");
    await draining;
    expect(at("/slow")).toEqual([first, behind]);
  });

  it("keeps at most ten out at once, one per subscription, each in order", async () => {
    const names = Array.from({ length: 15 }, (_, i) => `held-${i}`);
    for (const name of names) holding.add(`/${name}`);
    const subscriptions = names.map(subscribe);
    // Everyone's first event, then everyone's second.
    const firsts = subscriptions.map((id) => queue(id));
    const seconds = subscriptions.map((id) => queue(id));
    let most = 0;
    const draining = server!.flushEventDeliveries();
    const watch = setInterval(() => (most = Math.max(most, heldCount())), 5);
    try {
      await eventually(() => expect(heldCount()).toBe(10));
      await new Promise((done) => setTimeout(done, 100));
      expect(heldCount()).toBe(10);
      expect(new Set(arrivals.map((a) => a.path)).size).toBe(10);

      // Each answer, oldest first, frees a slot for whoever is due next.
      while (arrivals.length < 30) {
        const before = arrivals.length;
        held.shift()!.res.end("ok");
        await eventually(() => expect(arrivals.length).toBe(before + 1));
        expect(heldCount()).toBe(10);
      }
      holding.clear();
      for (const { res } of held.splice(0)) res.end("ok");
      await draining;
    } finally {
      clearInterval(watch);
    }
    expect(most).toBeLessThanOrEqual(10);
    expect(arrivals).toHaveLength(30);
    names.forEach((name, i) => expect(at(`/${name}`)).toEqual([firsts[i], seconds[i]]));
  });

  it("stops promptly with answers still out, and keeps their events for the restart", async () => {
    holding.add("/slow");
    const slow = subscribe("slow");
    const first = queue(slow);
    const second = queue(slow);
    const draining = server!.flushEventDeliveries();
    await eventually(() => expect(heldCount()).toBe(1));
    const began = Date.now();
    await server!.stop();
    await draining;
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(at("/slow")).toEqual([first]);

    // Neither event was spent: the first was cut short, the second never left.
    server = await start({ isolated: true });
    const due = server.store.dueEventDeliveries();
    expect(due.map((d) => [d.eventSeq, d.attempts])).toEqual([[first, 0]]);
    server.store.completeEventDelivery(due[0]!.id, slow);
    expect(server.store.dueEventDeliveries().map((d) => [d.eventSeq, d.attempts])).toEqual([
      [second, 0],
    ]);
  });
});
