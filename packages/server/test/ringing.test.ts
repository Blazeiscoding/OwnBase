import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  type HuddleRing,
  type Message,
  type ServerToClient,
} from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Ringing for direct calls (E10): the first one into a direct message's
 * huddle rings everyone else in it, on every device, until each answers by
 * joining, declines, or has missed it; the caller leaving ends it too. A ring
 * nobody answered leaves a note in the conversation, as from the caller.
 */
let server: WorkspaceServer;
let base: string;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
});

async function start(huddleRingMs = 60_000) {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
    huddleGraceMs: 0,
    huddleRingMs,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function request(path: string, token?: string, body?: unknown, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as any };
}

async function register(handle: string) {
  return (
    await request("/api/auth/register", undefined, {
      handle,
      displayName: handle,
      password: "password123",
    })
  ).data as { token: string; user: { id: string } };
}

/** A direct message `owner` starts with these others. */
async function dm(owner: { token: string }, ...others: { user: { id: string } }[]) {
  const made = await request("/api/channels", owner.token, {
    type: others.length === 1 ? "dm" : "group_dm",
    memberIds: others.map((other) => other.user.id),
  });
  return made.data.channel.id as string;
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
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  return {
    ws,
    frames,
    send,
    /** Waits for the server to have read everything sent before. */
    settle: async () => {
      const from = frames.length;
      send({ type: "ping" });
      await expect.poll(() => frames.slice(from).some((f) => f.type === "pong")).toBe(true);
    },
    rings: () =>
      frames.flatMap((f) =>
        f.type === "ephemeral" && f.event.type === "huddle.ring" ? [f.event.ring] : [],
      ),
    ready: () =>
      frames.find((f) => f.type === "ready") as Extract<ServerToClient, { type: "ready" }>,
  };
}

/** What a conversation holds, newest last. */
async function messages(channelId: string, token: string): Promise<Message[]> {
  return (await request(`/api/channels/${channelId}/messages`, token, undefined, "GET")).data
    .messages;
}

const last = (rings: HuddleRing[]) => rings.at(-1);

describe("a direct message's huddle", () => {
  it("rings the other person on every device, and tells the caller", async () => {
    await start();
    const alice = await register("alice");
    const bob = await register("bob");
    const carol = await register("carol");
    const channelId = await dm(alice, bob);
    const caller = await connect(alice.token);
    const laptop = await connect(bob.token);
    const phone = await connect(bob.token);
    const outsider = await connect(carol.token);
    expect(laptop.ready().huddleRings).toEqual([]);

    caller.send({ type: "huddle.join", channelId, requestId: "a" });
    for (const device of [laptop, phone, caller])
      await expect.poll(() => last(device.rings())?.ringing).toEqual([bob.user.id]);
    const ring = last(laptop.rings())!;
    expect(ring).toMatchObject({ channelId, callerId: alice.user.id, answered: [], declined: [] });
    expect(ring.endsAt - ring.startedAt).toBe(60_000);
    expect(server.gateway.huddleRing(channelId)).toEqual(ring);
    await outsider.settle();
    expect(outsider.rings()).toEqual([]);
  });

  it("rings nobody in a channel, nor when joining a huddle already going", async () => {
    await start();
    const alice = await register("alice");
    const bob = await register("bob");
    const channelId = await dm(alice, bob);
    const general = server.store.getChannelByName("general")!.id;
    const caller = await connect(alice.token);
    const callee = await connect(bob.token);

    caller.send({ type: "huddle.join", channelId: general, requestId: "a" });
    await caller.settle();
    await callee.settle();
    expect(callee.rings()).toEqual([]);
    expect(server.gateway.huddleRing(general)).toBeNull();

    caller.send({ type: "huddle.join", channelId, requestId: "b" });
    await expect.poll(() => callee.rings().length).toBe(1);
    callee.send({ type: "huddle.decline", channelId });
    await expect.poll(() => last(caller.rings())?.ringing).toEqual([]);
    // Bob joins after all: the huddle is going, so it rings nobody again.
    const count = caller.rings().length;
    callee.send({ type: "huddle.join", channelId, requestId: "c" });
    await callee.settle();
    await caller.settle();
    expect(server.gateway.huddleParticipants(channelId)).toEqual([alice.user.id, bob.user.id]);
    expect(caller.rings()).toHaveLength(count);
  });

  it("stops ringing on every device once answered on one, and leaves no note", async () => {
    await start();
    const alice = await register("alice");
    const bob = await register("bob");
    const channelId = await dm(alice, bob);
    const caller = await connect(alice.token);
    const laptop = await connect(bob.token);
    const phone = await connect(bob.token);
    caller.send({ type: "huddle.join", channelId, requestId: "a" });
    await expect.poll(() => phone.rings().length).toBe(1);

    laptop.send({ type: "huddle.join", channelId, requestId: "b" });
    for (const device of [laptop, phone, caller])
      await expect
        .poll(() => last(device.rings()))
        .toMatchObject({
          ringing: [],
          answered: [bob.user.id],
        });
    expect(server.gateway.huddleRing(channelId)).toBeNull();
    expect(await messages(channelId, alice.token)).toEqual([]);
  });

  it("tells the caller who declined, and leaves no note when everyone did", async () => {
    await start();
    const alice = await register("alice");
    const bob = await register("bob");
    const channelId = await dm(alice, bob);
    const caller = await connect(alice.token);
    const callee = await connect(bob.token);
    caller.send({ type: "huddle.join", channelId, requestId: "a" });
    await expect.poll(() => callee.rings().length).toBe(1);

    // Only someone it rings can say no: the caller saying so changes nothing.
    caller.send({ type: "huddle.decline", channelId });
    await caller.settle();
    expect(server.gateway.huddleRing(channelId)).toMatchObject({
      ringing: [bob.user.id],
      declined: [],
    });

    callee.send({ type: "huddle.decline", channelId });
    await expect
      .poll(() => last(caller.rings()))
      .toMatchObject({
        ringing: [],
        declined: [bob.user.id],
        answered: [],
      });
    expect(last(callee.rings())?.ringing).toEqual([]);
    // The caller is still in the huddle, alone, and no note is left.
    expect(server.gateway.huddleParticipants(channelId)).toEqual([alice.user.id]);
    expect(await messages(channelId, alice.token)).toEqual([]);
  });

  it("leaves a note as from the caller when nobody answers in time", async () => {
    await start(150);
    const alice = await register("alice");
    const bob = await register("bob");
    const channelId = await dm(alice, bob);
    const caller = await connect(alice.token);
    const callee = await connect(bob.token);
    caller.send({ type: "huddle.join", channelId, requestId: "a" });
    await expect.poll(() => callee.rings().length).toBe(1);

    await expect.poll(() => last(callee.rings())?.ringing).toEqual([]);
    await expect.poll(async () => (await messages(channelId, bob.token)).length).toBe(1);
    const [note] = await messages(channelId, bob.token);
    expect(note).toMatchObject({
      userId: alice.user.id,
      text: "Missed huddle",
      call: { kind: "missed" },
      threadRootId: null,
    });
    // Bob hears it as any message, so it can notify him.
    await expect
      .poll(() =>
        callee.frames.some(
          (f) =>
            f.type === "event" &&
            f.envelope.event.type === "message.created" &&
            f.envelope.event.message.id === note!.id,
        ),
      )
      .toBe(true);
    // The huddle goes on with Alice in it, and her note says what happened, not what she wrote.
    expect(server.gateway.huddleParticipants(channelId)).toEqual([alice.user.id]);
    const edit = await request(
      `/api/messages/${note!.id}`,
      alice.token,
      { text: "Hello" },
      "PATCH",
    );
    expect(edit).toMatchObject({ status: 409, data: { error: "call_not_editable" } });
  });

  it("ends when the caller leaves before anyone answers, and leaves a note", async () => {
    await start();
    const alice = await register("alice");
    const bob = await register("bob");
    const channelId = await dm(alice, bob);
    const caller = await connect(alice.token);
    const callee = await connect(bob.token);
    caller.send({ type: "huddle.join", channelId, requestId: "a" });
    await expect.poll(() => callee.rings().length).toBe(1);

    caller.send({ type: "huddle.leave", channelId });
    await expect.poll(() => last(callee.rings())?.ringing).toEqual([]);
    expect(server.gateway.huddleRing(channelId)).toBeNull();
    await expect.poll(async () => (await messages(channelId, bob.token)).length).toBe(1);
    expect((await messages(channelId, bob.token))[0]).toMatchObject({
      userId: alice.user.id,
      call: { kind: "missed" },
    });
  });

  it("ends when the caller's connection goes and their place is given up", async () => {
    await start();
    const alice = await register("alice");
    const bob = await register("bob");
    const channelId = await dm(alice, bob);
    const caller = await connect(alice.token);
    const callee = await connect(bob.token);
    caller.send({ type: "huddle.join", channelId, requestId: "a" });
    await expect.poll(() => callee.rings().length).toBe(1);

    caller.ws.terminate();
    await expect.poll(() => last(callee.rings())?.ringing).toEqual([]);
    await expect.poll(async () => (await messages(channelId, bob.token)).length).toBe(1);
  });

  it("is in the snapshot of a device that connects while it rings, and gone after", async () => {
    await start();
    const alice = await register("alice");
    const bob = await register("bob");
    const channelId = await dm(alice, bob);
    const caller = await connect(alice.token);
    caller.send({ type: "huddle.join", channelId, requestId: "a" });
    await expect.poll(() => caller.rings().length).toBe(1);

    const late = await connect(bob.token);
    expect(late.ready().huddleRings).toEqual([
      expect.objectContaining({ channelId, callerId: alice.user.id, ringing: [bob.user.id] }),
    ]);
    const callersOther = await connect(alice.token);
    expect(callersOther.ready().huddleRings).toHaveLength(1);
    // Someone outside the conversation is not told of it.
    const carol = await register("carol");
    expect((await connect(carol.token)).ready().huddleRings).toEqual([]);

    late.send({ type: "huddle.decline", channelId });
    await expect.poll(() => last(late.rings())?.ringing).toEqual([]);
    expect((await connect(bob.token)).ready().huddleRings).toEqual([]);
  });
});

describe("a group direct message's huddle", () => {
  it("rings everyone in it but bots, and goes on for the others as one answers", async () => {
    await start(400);
    const alice = await register("alice");
    const bob = await register("bob");
    const carol = await register("carol");
    const bot = server.store.createBotUser("helper", "Helper", "x", "y");
    const channelId = await dm(alice, bob, carol, { user: { id: bot.id } });
    const caller = await connect(alice.token);
    const bobs = await connect(bob.token);
    const carols = await connect(carol.token);

    caller.send({ type: "huddle.join", channelId, requestId: "a" });
    await expect
      .poll(() => [...(last(carols.rings())?.ringing ?? [])].sort())
      .toEqual([bob.user.id, carol.user.id].sort());

    bobs.send({ type: "huddle.join", channelId, requestId: "b" });
    await expect
      .poll(() => last(carols.rings()))
      .toMatchObject({
        ringing: [carol.user.id],
        answered: [bob.user.id],
      });
    // Carol never answers. Someone did, so the call happened: no note.
    await expect.poll(() => last(caller.rings())?.ringing).toEqual([]);
    await new Promise((settled) => setTimeout(settled, 100));
    expect(await messages(channelId, alice.token)).toEqual([]);
  });

  it("does not ring a deactivated member", async () => {
    await start();
    const alice = await register("alice");
    const bob = await register("bob");
    const carol = await register("carol");
    const channelId = await dm(alice, bob, carol);
    server.store.updateUser(carol.user.id, { deactivated: true });
    const caller = await connect(alice.token);
    caller.send({ type: "huddle.join", channelId, requestId: "a" });
    await expect.poll(() => last(caller.rings())?.ringing).toEqual([bob.user.id]);
  });
});
