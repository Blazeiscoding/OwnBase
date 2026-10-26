import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import { Store } from "../src/store.js";

/**
 * Retrying an endpoint's given-up events stays within its queue's ceiling
 * (REV-15, slice A). The deep review restored 1,000 failed rows into a full
 * queue of 500 and left 1,500 waiting; now the retry waits for room, keeps
 * what it cannot place yet, and drains as the endpoint answers.
 */
const CEILING = Store.MAX_PENDING_DELIVERIES;
const WEEK = 7 * 24 * 3600_000;
let server: WorkspaceServer;
let store: Store;
let subscriptionId: string;
let appId: string;
let seq = 0;
let dataDir: string;

async function open(dir: string) {
  // Isolated: nothing is sent, so the queue moves only as these tests move it.
  server = await createWorkspaceServer({
    dataDir: dir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    isolated: true,
  });
  store = server.store;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-retry-"));
  await open(dataDir);
  const owner = await fetch(`http://127.0.0.1:${server.port}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
  }).then((r) => r.json() as Promise<{ user: { id: string } }>);
  const app = store.createApp({
    name: "Slow App",
    botUserId: owner.user.id,
    createdBy: owner.user.id,
    signingSecret: "test-signing-secret-not-a-credential",
  });
  appId = app.id;
  subscriptionId = store.createSubscription({
    appId,
    url: "https://example.invalid/events",
    eventTypes: [],
  }).id;
  seq = 0;
});

afterEach(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Queues `n` events; returns how many the ceiling let in. */
function enqueue(n: number): number {
  let queued = 0;
  for (let i = 0; i < n; i++) {
    seq++;
    if (store.enqueueEventDelivery(subscriptionId, null, seq, JSON.stringify({ seq }), 0)) queued++;
  }
  return queued;
}

const delivery = () => store.listSubscriptions(appId)[0]!.delivery!;

/** Answers `n` due events, oldest first, as a healthy endpoint would; returns their seqs. */
function answer(n: number): number[] {
  const sent: number[] = [];
  while (sent.length < n) {
    const due = store.dueEventDeliveries(Date.now(), 10);
    if (due.length === 0) break;
    for (const d of due) {
      store.completeEventDelivery(d.id, d.subscriptionId);
      sent.push(d.eventSeq);
      expect(delivery().pending).toBeLessThanOrEqual(CEILING);
    }
  }
  return sent;
}

/** What the deep review set up: 1,000 given up on and a full queue of 500 behind them. */
function failedAndFull(failedAt = Date.now()) {
  expect(enqueue(CEILING)).toBe(CEILING);
  store.abandonEventBacklog(subscriptionId, "HTTP 500", failedAt);
  expect(enqueue(CEILING)).toBe(CEILING);
  store.abandonEventBacklog(subscriptionId, "HTTP 500", failedAt);
  expect(enqueue(CEILING)).toBe(CEILING);
  expect(delivery()).toMatchObject({ pending: CEILING, failed: 1_000, retrying: 0 });
}

// Each test walks a queue of up to 1,500 rows one delivery at a time.
describe("retrying given-up app events (REV-15)", { timeout: 30_000 }, () => {
  it("places none in a full queue, keeps all 1,000, and new events still meet the ceiling", () => {
    failedAndFull();
    expect(store.retryFailedEventDeliveries(subscriptionId)).toEqual({
      retried: 1_000,
      waiting: 1_000,
    });
    expect(delivery()).toMatchObject({ pending: CEILING, failed: 0, retrying: 1_000 });
    expect(enqueue(1)).toBe(0);
  });

  it("hands each freed slot to a retry, oldest first, and drains everything after repair", () => {
    failedAndFull();
    store.retryFailedEventDeliveries(subscriptionId);
    const sent = answer(10_000);
    expect(sent).toHaveLength(1_500);
    expect(delivery()).toMatchObject({ pending: 0, failed: 0, retrying: 0 });
    // The retried events went out in their own order, oldest first.
    const retried = sent.filter((s) => s <= 1_000);
    expect(retried).toEqual([...retried].sort((a, b) => a - b));
    expect(new Set(sent).size).toBe(1_500);
  });

  it("gives a freed slot to a waiting retry before a new event can take it", () => {
    failedAndFull();
    store.retryFailedEventDeliveries(subscriptionId);
    answer(1);
    expect(delivery()).toMatchObject({ pending: CEILING, retrying: 999 });
    expect(enqueue(1)).toBe(0);
  });

  it("keeps what is still waiting when the endpoint fails again, for another retry", () => {
    failedAndFull();
    store.retryFailedEventDeliveries(subscriptionId);
    answer(100);
    store.abandonEventBacklog(subscriptionId, "HTTP 503");
    // Nothing waits for room any more; it is all given up on again, within the kept history.
    const now = delivery();
    expect(now.retrying).toBe(0);
    expect(now.pending).toBe(0);
    expect(now.failed).toBe(Store.MAX_FAILED_DELIVERIES);
    expect(now.dropped).toBe(1_400 - Store.MAX_FAILED_DELIVERIES);
    // And a second retry drains it within the ceiling.
    expect(store.retryFailedEventDeliveries(subscriptionId)).toEqual({
      retried: Store.MAX_FAILED_DELIVERIES,
      waiting: Store.MAX_FAILED_DELIVERIES - CEILING,
    });
    expect(answer(10_000)).toHaveLength(Store.MAX_FAILED_DELIVERIES);
    expect(delivery()).toMatchObject({ pending: 0, failed: 0, retrying: 0 });
  });

  it("keeps the newest given-up events past the history budget, counting the rest as dropped", () => {
    for (let round = 0; round < 3; round++) {
      enqueue(CEILING);
      store.abandonEventBacklog(subscriptionId, "HTTP 500");
    }
    expect(delivery()).toMatchObject({
      failed: Store.MAX_FAILED_DELIVERIES,
      dropped: 3 * CEILING - Store.MAX_FAILED_DELIVERIES,
    });
    store.retryFailedEventDeliveries(subscriptionId);
    expect(Math.min(...answer(10_000))).toBe(3 * CEILING - Store.MAX_FAILED_DELIVERIES + 1);
  });

  it("answers the administrator's retry with how many still wait for room", async () => {
    failedAndFull();
    const admin = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "owner", password: "password123" }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/subscriptions/${subscriptionId}/retry`,
      { method: "POST", headers: { authorization: `Bearer ${admin.token}` } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, retried: 1_000, waiting: 1_000 });
  });

  it("keeps an accepted retry past the history window and a restart, then sends each once (F04)", async () => {
    // Given up on a week ago, as after an outage: retried into a full queue.
    failedAndFull(Date.now() - WEEK + 60_000);
    expect(store.retryFailedEventDeliveries(subscriptionId)).toEqual({
      retried: 1_000,
      waiting: 1_000,
    });
    // The hourly prune crosses the original deadline while the queue is full.
    store.pruneEventDeliveries(Date.now() + 120_000 - WEEK);
    expect(delivery()).toMatchObject({ pending: CEILING, retrying: 1_000, dropped: 0 });

    await server.stop();
    await open(dataDir);
    store.pruneEventDeliveries(Date.now() + 120_000 - WEEK);
    expect(delivery()).toMatchObject({ pending: CEILING, retrying: 1_000, dropped: 0 });

    const sent = answer(10_000);
    expect(sent).toHaveLength(1_500);
    expect(new Set(sent).size).toBe(1_500);
    expect(delivery()).toMatchObject({ pending: 0, failed: 0, retrying: 0 });
  });

  it("still forgets expired given-up events nobody asked to retry (F04)", () => {
    failedAndFull(Date.now() - WEEK - 60_000);
    store.pruneEventDeliveries(Date.now() - WEEK);
    expect(delivery()).toMatchObject({ pending: CEILING, failed: 0, retrying: 0 });
  });

  it("starts the history window again for a retry given up on once more (F04)", () => {
    failedAndFull(Date.now() - WEEK + 60_000);
    store.retryFailedEventDeliveries(subscriptionId);
    answer(100);
    store.abandonEventBacklog(subscriptionId, "HTTP 503");
    // Given up on again today, so a prune at the old deadline keeps it all.
    store.pruneEventDeliveries(Date.now() + 120_000 - WEEK);
    expect(delivery()).toMatchObject({ pending: 0, failed: Store.MAX_FAILED_DELIVERIES });
  });

  /**
   * The order a retry keeps, measured as an integration sees it (F04, S6): a
   * retry goes out oldest first among itself, but events already queued when
   * it was asked for are not held back for it, so it can arrive after newer
   * ones. docs/INTEGRATIONS.md says so.
   */
  it("sends a retry in its own order, after events already queued ahead of it", () => {
    seq = 0;
    enqueue(3);
    store.abandonEventBacklog(subscriptionId, "HTTP 500");
    seq = 3;
    expect(enqueue(CEILING)).toBe(CEILING);
    store.retryFailedEventDeliveries(subscriptionId);
    const sent = answer(5);
    expect(sent).toEqual([4, 1, 2, 3, 5]);
  });
});
