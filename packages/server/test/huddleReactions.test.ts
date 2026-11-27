import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { HUDDLE_REACTION_MS, PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Reactions and raised hands in a huddle (K17). A reaction is passed on to
 * everyone in the call and kept nowhere; a hand is held with the person's
 * place, so whoever joins later sees it, until they lower it or leave.
 */
let server: WorkspaceServer;
let base: string;
const sockets: WebSocket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
});

async function start() {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function register(handle: string) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  return (await response.json()) as { token: string; user: { id: string } };
}

async function connect(token: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerToClient));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  const settle = async () => {
    const from = frames.length;
    ws.send(JSON.stringify({ type: "ping" }));
    await expect.poll(() => frames.slice(from).some((f) => f.type === "pong")).toBe(true);
  };
  const events = (type: string) =>
    frames.flatMap((f) => (f.type === "ephemeral" && f.event.type === type ? [f.event] : []));
  const send = (message: object) => ws.send(JSON.stringify(message));
  const join = async (requestId: string) => {
    send({ type: "huddle.join", channelId: general(), requestId });
    await settle();
  };
  return { ws, frames, settle, events, send, join };
}

const general = () => server.store.channels.byName("general")!.id;
const lastRoster = (c: { events: (type: string) => unknown[] }) =>
  c.events("huddle.participants").at(-1) as { userIds: string[]; hands?: string[] };

describe("reactions in a huddle", () => {
  it("go to every device in the call, the sender's too, and to nobody outside it", async () => {
    await start();
    const maya = await register("maya");
    const sam = await register("sam");
    const priya = await register("priya");
    const m = await connect(maya.token);
    const s = await connect(sam.token);
    const p = await connect(priya.token);
    await m.join("m1");
    await s.join("s1");

    s.send({ type: "huddle.react", channelId: general(), emoji: "👍" });
    await s.settle();
    await m.settle();
    await p.settle();
    const reaction = { type: "huddle.react", channelId: general(), from: sam.user.id, emoji: "👍" };
    expect(m.events("huddle.react")).toEqual([reaction]);
    expect(s.events("huddle.react")).toEqual([reaction]);
    // Priya can read #general but is not in its huddle.
    expect(p.events("huddle.react")).toEqual([]);
    // Nor can she react in it.
    p.send({ type: "huddle.react", channelId: general(), emoji: "🎉" });
    await p.settle();
    await m.settle();
    expect(m.events("huddle.react")).toHaveLength(1);
    expect(p.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("pass on one per person every 400 ms and drop the rest quietly", async () => {
    await start();
    const maya = await register("maya");
    const sam = await register("sam");
    const m = await connect(maya.token);
    const s = await connect(sam.token);
    await m.join("m1");
    await s.join("s1");
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);

    for (const emoji of ["👍", "❤️", "😂"])
      s.send({ type: "huddle.react", channelId: general(), emoji });
    // Maya's is her own, and not held back by Sam's.
    m.send({ type: "huddle.react", channelId: general(), emoji: "🎉" });
    await s.settle();
    await m.settle();
    expect(m.events("huddle.react").map((e: any) => e.emoji)).toEqual(["👍", "🎉"]);

    clock.mockReturnValue(t0 + HUDDLE_REACTION_MS - 1);
    s.send({ type: "huddle.react", channelId: general(), emoji: "👏" });
    await s.settle();
    clock.mockReturnValue(t0 + HUDDLE_REACTION_MS);
    s.send({ type: "huddle.react", channelId: general(), emoji: "😮" });
    await s.settle();
    await m.settle();
    expect(m.events("huddle.react").map((e: any) => e.emoji)).toEqual(["👍", "🎉", "😮"]);
    expect(s.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("drop words and a custom emoji the workspace does not have, without closing the socket", async () => {
    await start();
    const maya = await register("maya");
    const m = await connect(maya.token);
    await m.join("m1");
    let at = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    for (const emoji of ["hello", "👍 there", ":nope:", "1️⃣"]) {
      m.send({ type: "huddle.react", channelId: general(), emoji });
      await m.settle();
      clock.mockReturnValue((at += HUDDLE_REACTION_MS));
    }
    expect(m.events("huddle.react").map((e: any) => e.emoji)).toEqual(["1️⃣"]);
    expect(m.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("raised hands in a huddle", () => {
  it("are in the roster for whoever joins later, first raised first, until lowered", async () => {
    await start();
    const maya = await register("maya");
    const sam = await register("sam");
    const priya = await register("priya");
    const alex = await register("alex");
    const m = await connect(maya.token);
    const s = await connect(sam.token);
    const p = await connect(priya.token);
    await m.join("m1");
    await s.join("s1");
    await p.join("p1");
    expect(lastRoster(m).hands).toBeUndefined();

    p.send({ type: "huddle.hand", channelId: general(), raised: true });
    await p.settle();
    s.send({ type: "huddle.hand", channelId: general(), raised: true });
    await s.settle();
    await m.settle();
    expect(lastRoster(m).hands).toEqual([priya.user.id, sam.user.id]);
    // Raising it again changes nothing, and tells nobody.
    const rosters = m.events("huddle.participants").length;
    p.send({ type: "huddle.hand", channelId: general(), raised: true });
    await p.settle();
    await m.settle();
    expect(m.events("huddle.participants")).toHaveLength(rosters);

    const a = await connect(alex.token);
    await a.join("a1");
    expect(a.events("huddle.join.result")).toEqual([
      {
        type: "huddle.join.result",
        channelId: general(),
        requestId: "a1",
        accepted: true,
        hands: [priya.user.id, sam.user.id],
      },
    ]);
    expect(lastRoster(a).hands).toEqual([priya.user.id, sam.user.id]);

    s.send({ type: "huddle.hand", channelId: general(), raised: false });
    await s.settle();
    await a.settle();
    expect(lastRoster(a).hands).toEqual([priya.user.id]);
    p.send({ type: "huddle.hand", channelId: general(), raised: false });
    await p.settle();
    await a.settle();
    expect(lastRoster(a)).not.toHaveProperty("hands");
  });

  it("goes down when its person leaves the call, and does not come back with them", async () => {
    await start();
    const maya = await register("maya");
    const priya = await register("priya");
    const m = await connect(maya.token);
    const p = await connect(priya.token);
    await m.join("m1");
    await p.join("p1");
    p.send({ type: "huddle.hand", channelId: general(), raised: true });
    await p.settle();
    await m.settle();
    expect(lastRoster(m).hands).toEqual([priya.user.id]);

    p.send({ type: "huddle.leave", channelId: general() });
    await p.settle();
    await m.settle();
    expect(lastRoster(m)).toEqual({
      type: "huddle.participants",
      channelId: general(),
      userIds: [maya.user.id],
    });
    await p.join("p2");
    await m.settle();
    expect(lastRoster(m).userIds).toContain(priya.user.id);
    expect(lastRoster(m)).not.toHaveProperty("hands");
  });

  it("stays with a place kept through a dropped connection, and is told to the device that comes back", async () => {
    await start();
    const maya = await register("maya");
    const priya = await register("priya");
    const m = await connect(maya.token);
    const p = await connect(priya.token);
    await m.join("m1");
    await p.join("p1");
    p.send({ type: "huddle.hand", channelId: general(), raised: true });
    await p.settle();

    p.ws.terminate();
    await expect.poll(() => server.gateway.isOnline(priya.user.id)).toBe(false);
    const back = await connect(priya.token);
    await back.join("p2");
    expect(back.events("huddle.join.result")).toContainEqual(
      expect.objectContaining({ requestId: "p2", accepted: true, hands: [priya.user.id] }),
    );
  });

  it("is only raised by someone in the call, on the device in it", async () => {
    await start();
    const maya = await register("maya");
    const sam = await register("sam");
    const m = await connect(maya.token);
    const s = await connect(sam.token);
    await m.join("m1");
    const rosters = m.events("huddle.participants").length;
    s.send({ type: "huddle.hand", channelId: general(), raised: true });
    await s.settle();
    await m.settle();
    expect(m.events("huddle.participants")).toHaveLength(rosters);
    expect(s.ws.readyState).toBe(WebSocket.OPEN);
  });
});
