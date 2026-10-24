import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * A place in a huddle belongs to the device in the call. When that device's
 * connection drops, the place waits for it a while, so a blip or a restarted
 * socket does not end the call for everyone; it moves when the person joins
 * from another device, and goes at once when the device is signed out.
 */
let server: WorkspaceServer;
let base: string;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
});

async function start(huddleGraceMs?: number) {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
    ...(huddleGraceMs === undefined ? {} : { huddleGraceMs }),
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function request(path: string, token?: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as any;
}

async function register(handle: string) {
  return (await request("/api/auth/register", undefined, {
    handle,
    displayName: handle,
    password: "password123",
  })) as { token: string; user: { id: string } };
}

/** Another sign-in for the same person, as a second device has. */
async function signIn(handle: string) {
  return (await request("/api/auth/login", undefined, { handle, password: "password123" })) as {
    token: string;
  };
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
  return { ws, frames, settle, events, send };
}

const general = () => server.store.getChannelByName("general")!.id;

/** Alice and Bob in #general's huddle, each on one device. */
async function call() {
  const alice = await register("alice");
  const bob = await register("bob");
  const a = await connect(alice.token);
  const b = await connect(bob.token);
  a.send({ type: "huddle.join", channelId: general(), requestId: "a1" });
  await a.settle();
  b.send({ type: "huddle.join", channelId: general(), requestId: "b1" });
  await b.settle();
  await a.settle();
  expect(server.gateway.huddleParticipants(general()).sort()).toEqual(
    [alice.user.id, bob.user.id].sort(),
  );
  return { alice, bob, a, b };
}

describe("a place in a huddle when its device's connection drops", () => {
  it("waits for the device to come back, and the others hear nothing of it", async () => {
    await start();
    const { alice, bob, a, b } = await call();
    const rosters = a.events("huddle.participants").length;

    b.ws.terminate();
    await expect.poll(() => server.gateway.isOnline(bob.user.id)).toBe(false);
    await a.settle();
    expect(server.gateway.huddleParticipants(general()).sort()).toEqual(
      [alice.user.id, bob.user.id].sort(),
    );

    // Back on a new socket, Bob joins again and has his place without a word to the room.
    const back = await connect(bob.token);
    back.send({ type: "huddle.join", channelId: general(), requestId: "b2" });
    await back.settle();
    expect(back.events("huddle.join.result")).toContainEqual(
      expect.objectContaining({ requestId: "b2", accepted: true }),
    );
    await a.settle();
    expect(a.events("huddle.participants")).toHaveLength(rosters);
    expect(server.gateway.calls.entries(() => true)).toContainEqual(
      expect.objectContaining({
        userId: bob.user.id,
        kind: "joined",
        reason: "came back after a lost connection",
      }),
    );

    // And the call goes on: Alice's offer reaches the device that came back.
    a.send({
      type: "huddle.signal",
      channelId: general(),
      to: bob.user.id,
      signal: { kind: "offer", sdp: "v=0" },
    });
    await expect.poll(() => back.events("huddle.signal")).toHaveLength(1);
  });

  it("is given up when the device does not come back in time, and the others are told", async () => {
    await start(100);
    const { alice, bob, a, b } = await call();
    b.ws.terminate();
    await expect
      .poll(() => a.events("huddle.participants").at(-1))
      .toEqual({ type: "huddle.participants", channelId: general(), userIds: [alice.user.id] });
    expect(server.gateway.calls.entries(() => true).at(-1)).toMatchObject({
      userId: bob.user.id,
      kind: "left",
      reason: "disconnected",
    });
  });

  it("is given up even while another of the person's devices stays online", async () => {
    await start(100);
    const { alice, bob, b } = await call();
    const phone = await connect((await signIn("bob")).token);
    b.ws.terminate();
    await expect.poll(() => server.gateway.huddleParticipants(general())).toEqual([alice.user.id]);
    expect(server.gateway.isOnline(bob.user.id)).toBe(true);
    // The phone was never in the call, so nothing meant for it went there.
    expect(phone.events("huddle.signal")).toEqual([]);
  });

  it("passes on no signal while it waits, to the device or to any other", async () => {
    await start();
    const { bob, a, b } = await call();
    const phone = await connect((await signIn("bob")).token);
    b.ws.terminate();
    // Bob stays online on the phone, so give the server a moment to see the drop.
    await new Promise((done) => setTimeout(done, 150));
    await phone.settle();
    a.send({
      type: "huddle.signal",
      channelId: general(),
      to: bob.user.id,
      signal: { kind: "offer", sdp: "v=0" },
    });
    await a.settle();
    await phone.settle();
    expect(phone.events("huddle.signal")).toEqual([]);
    expect(server.gateway.calls.entries(() => true).at(-1)).toMatchObject({
      kind: "dropped",
      reason: "offer: the other person's connection is down",
    });
  });

  it("goes at once when the device is signed out", async () => {
    await start();
    const { alice, bob, a } = await call();
    await request("/api/auth/logout", bob.token);
    await expect
      .poll(() => a.events("huddle.participants").at(-1))
      .toEqual({ type: "huddle.participants", channelId: general(), userIds: [alice.user.id] });
  });
});

describe("a place in a huddle when the person joins from another device", () => {
  it("moves there, tells the first device, and does not let it end the call", async () => {
    await start();
    const { alice, bob, a, b } = await call();
    const rosters = a.events("huddle.participants").length;
    const phone = await connect((await signIn("bob")).token);
    phone.send({ type: "huddle.join", channelId: general(), requestId: "p1" });
    await phone.settle();
    await b.settle();
    expect(b.events("huddle.moved")).toEqual([{ type: "huddle.moved", channelId: general() }]);
    expect(phone.events("huddle.moved")).toEqual([]);

    // The first device leaving, as an older client would on its way out, changes nothing.
    b.send({ type: "huddle.leave", channelId: general() });
    await b.settle();
    await a.settle();
    expect(server.gateway.huddleParticipants(general()).sort()).toEqual(
      [alice.user.id, bob.user.id].sort(),
    );
    expect(a.events("huddle.participants")).toHaveLength(rosters);

    // Signals go to the phone only, and only the phone may send them.
    a.send({
      type: "huddle.signal",
      channelId: general(),
      to: bob.user.id,
      signal: { kind: "offer", sdp: "v=0" },
    });
    await expect.poll(() => phone.events("huddle.signal")).toHaveLength(1);
    b.send({
      type: "huddle.signal",
      channelId: general(),
      to: alice.user.id,
      signal: { kind: "answer", sdp: "v=0" },
    });
    await b.settle();
    await a.settle();
    expect(a.events("huddle.signal")).toEqual([]);

    // The phone leaving ends Bob's place.
    phone.send({ type: "huddle.leave", channelId: general() });
    await expect.poll(() => server.gateway.huddleParticipants(general())).toEqual([alice.user.id]);
  });
});

describe("what one side of a huddle says it is sending", () => {
  it("is passed on whole, the share's sound included", async () => {
    await start();
    const { bob, a, b } = await call();
    a.send({
      type: "huddle.signal",
      channelId: general(),
      to: bob.user.id,
      signal: { kind: "media", camera: false, screen: true, muted: true, screenSound: true },
    });
    await expect.poll(() => b.events("huddle.signal")).toHaveLength(1);
    expect(b.events("huddle.signal")[0]).toMatchObject({
      signal: { kind: "media", camera: false, screen: true, muted: true, screenSound: true },
    });
  });

  it("passes on how big the other side draws their camera and share, or that it does not (E13b)", async () => {
    await start();
    const { alice, bob, a, b } = await call();
    a.send({
      type: "huddle.signal",
      channelId: general(),
      to: bob.user.id,
      signal: { kind: "media", camera: true, screen: false, view: { camera: 180, screen: 720 } },
    });
    b.send({
      type: "huddle.signal",
      channelId: general(),
      to: alice.user.id,
      signal: { kind: "media", camera: true, screen: false, view: { camera: 0, screen: 0 } },
    });
    await expect.poll(() => b.events("huddle.signal")).toHaveLength(1);
    await expect.poll(() => a.events("huddle.signal")).toHaveLength(1);
    expect(b.events("huddle.signal")[0]).toMatchObject({
      signal: { kind: "media", view: { camera: 180, screen: 720 } },
    });
    expect(a.events("huddle.signal")[0]).toMatchObject({
      signal: { kind: "media", view: { camera: 0, screen: 0 } },
    });
  });
});
