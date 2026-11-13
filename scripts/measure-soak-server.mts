/**
 * The server side of measure-soak.mts, in a process of its own so its memory,
 * handles and event loop are the server's alone and not the clients'. Started
 * by that script with an IPC channel; it says `ready` with its port, seeds
 * history when told, answers each `sample` with what it holds, and stops.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createWorkspaceServer } from "../packages/server/src/index.js";

type Request =
  | { type: "seed"; messages: number; channelIds: string[]; userIds: string[] }
  | { type: "sample" }
  | { type: "stop" };

const dataDir = process.argv[2];
if (!dataDir || !process.send) throw new Error("started by measure-soak.mts with a data folder");
const send = (message: unknown) => process.send!(message);

const server = await createWorkspaceServer({
  dataDir,
  host: "127.0.0.1",
  port: 0,
  mdns: false,
  logger: false,
  rateLimits: false,
});
// One millisecond would be the delay a timer adds by itself; ten is finer
// than anything a person notices.
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const gc = (globalThis as { gc?: () => void }).gc;

process.on("message", async (request: Request) => {
  if (request.type === "seed") {
    const store = server.store;
    const DAY = 86_400_000;
    const realNow = Date.now;
    const start = realNow() - 90 * DAY;
    const step = (90 * DAY) / Math.max(1, request.messages);
    // Written as the server would have when each was new: the row, its event
    // in the log and its sequence number, so replays and watermarks agree.
    for (let batch = 0; batch < request.messages; batch += 1000) {
      store.transaction(() => {
        for (let i = batch; i < Math.min(request.messages, batch + 1000); i++) {
          const channelId = request.channelIds[i % request.channelIds.length]!;
          Date.now = () => Math.floor(start + i * step);
          try {
            const message = store.messages.get(
              store.messages.create({
                channelId,
                userId: request.userIds[(i * 7) % request.userIds.length]!,
                text: `seeded history ${i} about the release plan and the budget`,
                threadRootId: null,
                nonce: null,
              }),
            )!;
            const envelope = store.appendEvent(
              { type: "message.created", message },
              channelId,
              message.id,
            );
            store.messages.stampSeq(message.id, channelId, envelope.seq);
          } finally {
            Date.now = realNow;
          }
        }
      });
    }
    send({ type: "seeded" });
  } else if (request.type === "sample") {
    // Garbage that is merely not collected yet is not held; what survives a
    // full collection is what a leak would be.
    gc?.();
    const memory = process.memoryUsage();
    const handles: Record<string, number> = {};
    for (const kind of process.getActiveResourcesInfo()) handles[kind] = (handles[kind] ?? 0) + 1;
    send({
      type: "sample",
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      handles,
      connectedPeople: server.connectedPeople(),
      loop: {
        p50: delay.percentile(50) / 1e6,
        p99: delay.percentile(99) / 1e6,
        max: delay.max / 1e6,
      },
    });
    delay.reset();
  } else if (request.type === "stop") {
    await server.stop();
    send({ type: "stopped" });
    process.disconnect();
  }
});
send({ type: "ready", port: server.port, gc: Boolean(gc) });
