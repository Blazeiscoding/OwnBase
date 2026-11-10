import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledStore } from "../src/scheduled/store.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Queue work run from a timer, an immediate or startup must never end the
 * process (REV-01): a failure is logged and counted, the durable rows stay as
 * they were, and the queue goes on once the fault clears.
 */
let server: WorkspaceServer | null = null;

async function start(options: Partial<Parameters<typeof createWorkspaceServer>[0]> = {}) {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    ...options,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const owner = (await (
    await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
    })
  ).json()) as { token: string; user: { id: string } };
  const channelId = server.store.channels.byName("general")!.id;
  // Each due a moment before the last one scheduled, so they are taken in
  // the order scheduled, rather than by ids made in the same millisecond.
  let order = 0;
  const schedule = (text: string) =>
    server!.store.scheduled.schedule({
      channelId,
      userId: owner.user.id,
      text,
      threadRootId: null,
      fileIds: [],
      sendAt: Date.now() - 1_000 + order++,
    });
  const status = async () =>
    (await (
      await fetch(`${base}/api/admin/status`, {
        headers: { authorization: `Bearer ${owner.token}` },
      })
    ).json()) as { backgroundFailures: { queue: string; failures: number; since: number }[] };
  const healthy = async () => (await fetch(`${base}/api/health`)).status === 200;
  return { server, schedule, status, healthy };
}

const failing = (message: string) => () => {
  throw new Error(message);
};

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await server?.stop();
  server = null;
});

describe("background queues (REV-01)", () => {
  it("keeps serving when a scheduled read fails on its timer, and sends once it can", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { server, schedule, status, healthy } = await start();
    const due = vi.spyOn(server.store.scheduled, "due").mockImplementation(failing("disk read"));
    const waiting = schedule("later");

    vi.advanceTimersByTime(15_000);
    vi.advanceTimersByTime(15_000);
    expect(await healthy()).toBe(true);
    expect(server.store.scheduled.get(waiting.id)?.status).toBe("queued");
    expect((await status()).backgroundFailures).toEqual([
      { queue: "scheduled messages", failures: 2, since: expect.any(Number) },
    ]);

    due.mockRestore();
    vi.advanceTimersByTime(15_000);
    expect(server.store.scheduled.get(waiting.id)?.status).toBe("sent");
    expect((await status()).backgroundFailures).toEqual([]);
  });

  it("keeps serving when an event delivery read fails on its timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { server, status, healthy } = await start();
    vi.spyOn(server.store.deliveries, "due").mockImplementation(failing("disk read"));

    vi.advanceTimersByTime(5_000);
    await expect
      .poll(async () => (await status()).backgroundFailures.map((f) => f.queue))
      .toEqual(["event deliveries"]);
    expect(await healthy()).toBe(true);
  });

  it("keeps serving when the next batch's read fails on the turn after a full one", async () => {
    const { server, schedule, healthy } = await start({ scheduledLimits: { batch: 1 } });
    const first = schedule("first");
    const second = schedule("second");
    const due = server.store.scheduled.due.bind(server.store.scheduled);
    let calls = 0;
    vi.spyOn(server.store.scheduled, "due").mockImplementation((...args) => {
      if (++calls === 2) throw new Error("disk read");
      return due(...args);
    });
    // One full batch, then the read on the turn it schedules fails.
    server.flushScheduled();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(2);
    expect(await healthy()).toBe(true);
    expect(server.store.scheduled.get(first.id)?.status).toBe("sent");
    expect(server.store.scheduled.get(second.id)?.status).toBe("queued");
  });

  it("sends the rest of a batch when recording one message's hold fails", async () => {
    const { server, schedule } = await start();
    const archived = server.store.channels.create({
      type: "public",
      name: "old",
      creatorId: server.store.people.authByHandle("owner")!.id,
      memberIds: [server.store.people.authByHandle("owner")!.id],
    });
    server.store.channels.update(archived.id, { archived: true });
    const held = server.store.scheduled.schedule({
      channelId: archived.id,
      userId: server.store.people.authByHandle("owner")!.id,
      text: "to the archive",
      threadRootId: null,
      fileIds: [],
      sendAt: Date.now() - 2,
    });
    const sent = schedule("still goes");
    vi.spyOn(server.store.scheduled, "hold").mockImplementation(failing("disk write"));

    expect(() => server.flushScheduled()).not.toThrow();
    expect(server.store.scheduled.get(sent.id)?.status).toBe("sent");
    expect(server.store.scheduled.get(held.id)?.status).toBe("queued");
  });

  it("starts when a queue fails at startup, and says which", async () => {
    vi.spyOn(ScheduledStore.prototype, "due").mockImplementationOnce(failing("disk read"));
    const { status, healthy } = await start();
    expect(await healthy()).toBe(true);
    expect((await status()).backgroundFailures.map((f) => f.queue)).toEqual(["scheduled messages"]);
  });

  it("survives, as a real process, a delivery read that fails on every tick of its timer", async () => {
    const serverModule = new URL("../src/server.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { createWorkspaceServer } from ${JSON.stringify(serverModule)};
         const server = await createWorkspaceServer({ dataDir: ":memory:", host: "127.0.0.1", port: 0, mdns: false });
         server.store.deliveries.due = () => { throw new Error("disk read"); };
         // Two ticks of the five-second delivery timer.
         await new Promise((resolve) => setTimeout(resolve, 11_000));
         const health = await fetch("http://127.0.0.1:" + server.port + "/api/health");
         await server.stop();
         console.log("survived " + health.status);`,
      ],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    child.stdout!.on("data", (chunk) => (output += String(chunk)));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect({ code, output: output.trim() }).toEqual({ code: 0, output: "survived 200" });
  }, 30_000);
});
