import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * The hourly round keeps the newest 20,000 events for clients catching up.
 * With 200 people an hour adds some 200,000, and removing them in one
 * statement held the server for 2 s (J06), so it goes a step at a time.
 */
let server: WorkspaceServer;

beforeEach(async () => {
  // The hourly round, run by hand; everything else keeps real time.
  vi.useFakeTimers({ toFake: ["setInterval"] });
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
  });
});

afterEach(async () => {
  await server.stop();
  vi.useRealTimers();
});

const db = () => server.store.db;
const events = () =>
  db().prepare("SELECT COUNT(*) AS n, MIN(seq) AS low, MAX(seq) AS high FROM events").get() as {
    n: number;
    low: number;
    high: number;
  };

function addEvents(count: number) {
  const insert = db().prepare(
    "INSERT INTO events (channel_id, type, payload, created_at) VALUES (NULL, 'test', '{}', ?)",
  );
  db().exec("BEGIN");
  for (let i = 0; i < count; i++) insert.run(Date.now());
  db().exec("COMMIT");
}

describe("removing old events every hour", () => {
  it("lets other work run between steps, and keeps the newest 20,000", async () => {
    addEvents(30_000 - events().n);
    expect(events().n).toBe(30_000);
    const newest = events().high;

    vi.advanceTimersByTime(3600_000);
    // Work that arrives just after the round starts gets a turn before it ends.
    const seen = await new Promise<number>((resolve) => setImmediate(() => resolve(events().n)));
    expect(seen).toBeGreaterThan(20_000);
    expect(seen).toBeLessThan(30_000);

    await expect.poll(() => events().n).toBe(20_000);
    expect(events()).toEqual({ n: 20_000, low: newest - 20_000 + 1, high: newest });
  });

  it("leaves events written during the round alone", async () => {
    addEvents(25_000 - events().n);
    const cutoff = events().high - 20_000;
    vi.advanceTimersByTime(3600_000);
    addEvents(100);
    await expect.poll(() => events().low).toBe(cutoff + 1);
    expect(events().n).toBe(20_100);
  });
});
