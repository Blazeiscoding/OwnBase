import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  type EphemeralEvent,
  type HuddleRing,
  type Message,
  type ServerToClient,
} from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import type { Limits } from "../src/limits.js";
import { moveableClock, passRing } from "./huddleClock.js";

/**
 * Asking someone into a channel's call (K18): whoever is in the call rings a
 * member of the channel through the same ring a direct call uses, until they
 * join, decline or miss it, or whoever asked leaves.
 */
let server: WorkspaceServer;
let base: string;
const sockets: WebSocket[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
});

async function start(rateLimits: false | Partial<Limits> = false) {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits,
    logger: false,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function request(path: string, token: string, body?: unknown, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as any };
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
  const send = (message: object) => ws.send(JSON.stringify(message));
  const settle = async () => {
    const from = frames.length;
    send({ type: "ping" });
    await expect.poll(() => frames.slice(from).some((f) => f.type === "pong")).toBe(true);
  };
  const events = <T extends EphemeralEvent["type"]>(type: T) =>
    frames.flatMap((f) =>
      f.type === "ephemeral" && f.event.type === type
        ? [f.event as Extract<EphemeralEvent, { type: T }>]
        : [],
    );
  return {
    frames,
    send,
    settle,
    rings: () => events("huddle.ring").map((e) => e.ring),
    refusals: () => events("huddle.ask.refused"),
    join: async (channelId: string) => {
      send({ type: "huddle.join", channelId, requestId: `join-${frames.length}` });
      await settle();
    },
    ask: async (channelId: string, userId: string) => {
      send({ type: "huddle.ask", channelId, userId });
      await settle();
    },
  };
}

const general = () => server.store.channels.byName("general")!.id;
const last = (rings: HuddleRing[]) => rings.at(-1);

async function people() {
  const maya = await register("maya");
  const sam = await register("sam");
  const priya = await register("priya");
  return { maya, sam, priya };
}

describe("asking someone into a channel's call", () => {
  it("rings them on every device, naming who asked, until they join", async () => {
    await start();
    const { maya, sam, priya } = await people();
    const m = await connect(maya.token);
    const laptop = await connect(sam.token);
    const phone = await connect(sam.token);
    const p = await connect(priya.token);
    await m.join(general());
    await p.join(general());

    await m.ask(general(), sam.user.id);
    for (const device of [laptop, phone, m])
      await expect.poll(() => last(device.rings())?.ringing).toEqual([sam.user.id]);
    expect(last(laptop.rings())).toMatchObject({
      channelId: general(),
      callerId: maya.user.id,
      askedBy: { [sam.user.id]: maya.user.id },
    });
    // Priya is in the call, but neither asked nor asked for.
    await p.settle();
    expect(p.rings()).toEqual([]);

    await laptop.join(general());
    for (const device of [laptop, phone, m])
      await expect
        .poll(() => last(device.rings()))
        .toMatchObject({ ringing: [], answered: [sam.user.id] });
    expect(server.huddles.ring(general())).toBeNull();
  });

  it("rings only members of the channel, and only for someone in its call", async () => {
    await start();
    const { maya, sam, priya } = await people();
    const design = (await request("/api/channels", maya.token, { type: "public", name: "design" }))
      .data.channel.id as string;
    // Sam can still see the public #design, and join it, but is not a member.
    await request(`/api/channels/${design}/leave`, sam.token);
    const m = await connect(maya.token);
    const s = await connect(sam.token);
    const p = await connect(priya.token);

    // Maya is not in a call yet.
    await m.ask(general(), sam.user.id);
    await m.join(design);
    await m.ask(design, sam.user.id);
    // Nor can anyone be asked into a call they are already in.
    await m.ask(design, maya.user.id);
    await s.settle();
    expect(s.rings()).toEqual([]);
    expect(server.huddles.ring(design)).toBeNull();

    // Priya, outside the call, cannot ring anyone into it.
    await request(`/api/channels/${design}/join`, sam.token);
    await p.ask(design, sam.user.id);
    await s.settle();
    expect(s.rings()).toEqual([]);

    await m.ask(design, sam.user.id);
    await expect.poll(() => last(s.rings())?.ringing).toEqual([sam.user.id]);
    // Asking again while it rings changes nothing.
    const count = s.rings().length;
    await m.ask(design, sam.user.id);
    await s.settle();
    expect(s.rings()).toHaveLength(count);
  });

  it("tells whoever asked of a decline, and leaves no note in the channel", async () => {
    await start();
    const { maya, sam } = await people();
    const m = await connect(maya.token);
    const s = await connect(sam.token);
    await m.join(general());
    const before: Message[] = (
      await request(`/api/channels/${general()}/messages`, maya.token, undefined, "GET")
    ).data.messages;

    await m.ask(general(), sam.user.id);
    await expect.poll(() => s.rings().length).toBe(1);
    s.send({ type: "huddle.decline", channelId: general() });
    await expect
      .poll(() => last(m.rings()))
      .toMatchObject({ ringing: [], declined: [sam.user.id] });
    expect(server.huddles.ring(general())).toBeNull();

    // Asked again, the decline is forgotten.
    await m.ask(general(), sam.user.id);
    await expect
      .poll(() => last(s.rings()))
      .toMatchObject({ ringing: [sam.user.id], declined: [] });
    expect(
      (await request(`/api/channels/${general()}/messages`, maya.token, undefined, "GET")).data
        .messages,
    ).toEqual(before);
  });

  it("stops ringing when whoever asked leaves, and for each once they missed it", async () => {
    await start();
    const { maya, sam, priya } = await people();
    const m = await connect(maya.token);
    const s = await connect(sam.token);
    const p = await connect(priya.token);
    const alex = await register("alex");
    const a = await connect(alex.token);
    await m.join(general());
    await p.join(general());

    moveableClock();
    await m.ask(general(), sam.user.id);
    await p.ask(general(), alex.user.id);
    await expect.poll(() => last(s.rings())?.ringing).toEqual([sam.user.id, alex.user.id]);
    // Maya leaves: Sam, whom she asked, stops ringing; Alex, whom Priya asked, does not.
    m.send({ type: "huddle.leave", channelId: general() });
    await expect.poll(() => last(a.rings())?.ringing).toEqual([alex.user.id]);
    expect(last(s.rings())?.ringing).toEqual([alex.user.id]);

    await passRing();
    await expect.poll(() => last(p.rings())?.ringing).toEqual([]);
    expect(last(p.rings())).toMatchObject({ answered: [], declined: [] });
    expect(server.huddles.ring(general())).toBeNull();
  });

  it("ends every ring with the call", async () => {
    await start();
    const { maya, sam } = await people();
    const m = await connect(maya.token);
    const s = await connect(sam.token);
    await m.join(general());
    await m.ask(general(), sam.user.id);
    await expect.poll(() => s.rings().length).toBe(1);
    m.send({ type: "huddle.leave", channelId: general() });
    await expect.poll(() => last(s.rings())?.ringing).toEqual([]);
    expect(server.huddles.ring(general())).toBeNull();
  });

  it("does not ring someone who paused notifications or blocked the asker", async () => {
    await start();
    const { maya, sam, priya } = await people();
    const m = await connect(maya.token);
    const s = await connect(sam.token);
    const p = await connect(priya.token);
    await m.join(general());
    await request("/api/me", sam.token, { dndUntil: Date.now() + 60_000 }, "PATCH");
    await request(`/api/me/blocks/${maya.user.id}`, priya.token, undefined, "PUT");

    await m.ask(general(), sam.user.id);
    await m.ask(general(), priya.user.id);
    await expect
      .poll(() => m.refusals().map((r) => [r.userId, r.reason]))
      .toEqual([
        [sam.user.id, "unavailable"],
        [priya.user.id, "unavailable"],
      ]);
    await s.settle();
    await p.settle();
    expect(s.rings()).toEqual([]);
    expect(p.rings()).toEqual([]);
  });

  it("gives each asker an allowance of rings", async () => {
    await start({ huddleRing: { burst: 1, perMinute: 1 } });
    const { maya, sam, priya } = await people();
    const m = await connect(maya.token);
    const p = await connect(priya.token);
    await m.join(general());

    await m.ask(general(), sam.user.id);
    await m.ask(general(), priya.user.id);
    await expect.poll(() => m.refusals()).toHaveLength(1);
    expect(m.refusals()[0]).toMatchObject({ userId: priya.user.id, reason: "limited" });
    expect(m.refusals()[0]!.retryAfterMs).toBeGreaterThan(0);
    await p.settle();
    expect(p.rings()).toEqual([]);
    expect(server.huddles.ring(general())?.ringing).toEqual([sam.user.id]);
  });
});
