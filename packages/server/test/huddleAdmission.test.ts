import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

let server: WorkspaceServer;
let base: string;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
});

async function start(burst: number) {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: { ephemeral: { burst, perMinute: 1 } },
    // A dropped device's place in a call goes at once here; huddleRejoin.test.ts
    // covers the grace it gets for coming back.
    huddleGraceMs: 0,
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
  const participants = () =>
    frames.flatMap((f) =>
      f.type === "ephemeral" && f.event.type === "huddle.participants" ? [f.event] : [],
    );
  return { ws, frames, settle, participants };
}

describe("huddle transition admission", () => {
  it("bounds an alternating join/leave burst while always permitting departure", async () => {
    await start(1);
    const person = await register("caller");
    const observer = await register("observer");
    const sender = await connect(person.token);
    const reader = await connect(observer.token);
    const channelId = server.store.getChannelByName("general")!.id;

    for (let i = 0; i < 20; i++) {
      sender.ws.send(JSON.stringify({ type: "huddle.join", channelId, requestId: `join-${i}` }));
      sender.ws.send(JSON.stringify({ type: "huddle.leave", channelId }));
    }
    await sender.settle();
    await reader.settle();

    expect(reader.participants().map((event) => event.userIds)).toEqual([[person.user.id], []]);
    expect(server.gateway.huddleParticipants(channelId)).toEqual([]);
    expect(sender.ws.readyState).toBe(WebSocket.OPEN);
    const results = sender.frames.flatMap((frame) =>
      frame.type === "ephemeral" && frame.event.type === "huddle.join.result" ? [frame.event] : [],
    );
    expect(results).toHaveLength(20);
    expect(results[0]).toMatchObject({ requestId: "join-0", accepted: true });
    expect(results[1]).toMatchObject({ requestId: "join-1", accepted: false });
    expect(results[1]).toHaveProperty("retryAfterMs");
    expect(results.slice(1).every((result) => !result.accepted)).toBe(true);
    expect(results.map((result) => result.requestId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `join-${i}`),
    );
    expect(
      reader.frames.some(
        (frame) => frame.type === "ephemeral" && frame.event.type === "huddle.join.result",
      ),
    ).toBe(false);
  });

  it("coalesces duplicate joins and shares the admission across one person's sockets", async () => {
    await start(2);
    const person = await register("caller");
    const sender = await connect(person.token);
    const otherDevice = await connect(person.token);
    const firstChannel = server.store.getChannelByName("general")!.id;
    const secondChannel = (
      await request("/api/channels", person.token, { type: "public", name: "second-room" })
    ).data.channel.id;

    sender.ws.send(
      JSON.stringify({ type: "huddle.join", channelId: firstChannel, requestId: "first" }),
    );
    for (let i = 0; i < 20; i++) {
      sender.ws.send(
        JSON.stringify({
          type: "huddle.join",
          channelId: firstChannel,
          requestId: `duplicate-${i}`,
        }),
      );
    }
    await sender.settle();
    otherDevice.ws.send(JSON.stringify({ type: "huddle.join", channelId: secondChannel }));
    await otherDevice.settle();
    sender.ws.send(JSON.stringify({ type: "huddle.leave", channelId: firstChannel }));
    sender.ws.send(JSON.stringify({ type: "huddle.join", channelId: firstChannel }));
    await sender.settle();
    await otherDevice.settle();

    expect(server.gateway.huddleParticipants(firstChannel)).toEqual([]);
    expect(server.gateway.huddleParticipants(secondChannel)).toEqual([person.user.id]);
    expect(otherDevice.participants()).toHaveLength(3);
    const results = sender.frames.flatMap((frame) =>
      frame.type === "ephemeral" && frame.event.type === "huddle.join.result" ? [frame.event] : [],
    );
    expect(results).toHaveLength(21);
    expect(results.every((result) => result.accepted)).toBe(true);
    expect(
      otherDevice.frames.some(
        (frame) => frame.type === "ephemeral" && frame.event.type === "huddle.join.result",
      ),
    ).toBe(false);
    otherDevice.ws.send(JSON.stringify({ type: "huddle.leave", channelId: secondChannel }));
    await otherDevice.settle();
    expect(server.gateway.huddleParticipants(secondChannel)).toEqual([]);
  });

  it("immediately answers distinct duplicate attempts without spending admission or fanning out", async () => {
    await start(2);
    const person = await register("caller");
    const existingDevice = await connect(person.token);
    const joiningDevice = await connect(person.token);
    const firstChannel = server.store.getChannelByName("general")!.id;
    const secondChannel = (
      await request("/api/channels", person.token, { type: "public", name: "second-room" })
    ).data.channel.id;
    existingDevice.ws.send(JSON.stringify({ type: "huddle.join", channelId: firstChannel }));
    existingDevice.ws.send(JSON.stringify({ type: "huddle.join", channelId: secondChannel }));
    await existingDevice.settle();
    joiningDevice.ws.send(
      JSON.stringify({ type: "huddle.join", channelId: firstChannel, requestId: "first" }),
    );
    joiningDevice.ws.send(
      JSON.stringify({ type: "huddle.join", channelId: secondChannel, requestId: "second" }),
    );
    await joiningDevice.settle();
    const results = () =>
      joiningDevice.frames.flatMap((frame) =>
        frame.type === "ephemeral" && frame.event.type === "huddle.join.result"
          ? [frame.event]
          : [],
      );
    expect(results().map((event) => event.requestId)).toEqual(["first", "second"]);
    expect(results().every((event) => event.accepted)).toBe(true);
    expect(server.gateway.huddleParticipants(secondChannel)).toEqual([person.user.id]);
    expect(existingDevice.participants()).toHaveLength(2);
  });

  it("cleans an exhausted participant on access revocation and closes without a ghost", async () => {
    await start(1);
    const owner = await register("owner");
    const member = await register("member");
    const room = (
      await request("/api/channels", owner.token, {
        type: "private",
        name: "private-room",
        memberIds: [member.user.id],
      })
    ).data.channel;
    const caller = await connect(member.token);
    caller.ws.send(
      JSON.stringify({ type: "huddle.join", channelId: room.id, requestId: "initial" }),
    );
    await caller.settle();
    expect(server.gateway.huddleParticipants(room.id)).toEqual([member.user.id]);

    expect(
      (
        await request(
          `/api/channels/${room.id}/members/${member.user.id}`,
          owner.token,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    expect(server.gateway.huddleParticipants(room.id)).toEqual([]);
    caller.ws.send(
      JSON.stringify({ type: "huddle.join", channelId: room.id, requestId: "revoked" }),
    );
    await caller.settle();
    expect(caller.participants()).toHaveLength(1);
    expect(caller.frames).toContainEqual({
      type: "ephemeral",
      event: {
        type: "huddle.join.result",
        channelId: room.id,
        requestId: "revoked",
        accepted: false,
        message: "You no longer have access to this conversation.",
      },
    });

    // A different exhausted account drops its admitted seat on disconnect.
    const ownerSocket = await connect(owner.token);
    ownerSocket.ws.send(JSON.stringify({ type: "huddle.join", channelId: room.id }));
    await ownerSocket.settle();
    expect(server.gateway.huddleParticipants(room.id)).toEqual([owner.user.id]);
    ownerSocket.ws.terminate();
    await expect.poll(() => server.gateway.huddleParticipants(room.id)).toEqual([]);
  });
});
