import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Socket callbacks run outside Fastify's error handler, so a read that throws
 * in one used to end the whole process (F03). Each failure here must leave
 * the server answering, send nothing that depended on the failed read, and
 * close the affected socket with a server-fault code its client retries,
 * after which a new connection signs in as usual.
 */
type Person = { token: string; user: { id: string; handle: string } };
let server: WorkspaceServer;
let base: string;
let people: Person[];
let general: string;
const sockets: WebSocket[] = [];

const failing = (message: string) => () => {
  throw new Error(message);
};

async function request(method: string, path: string, token?: string, body?: unknown) {
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

const healthy = async () => (await fetch(`${base}/api/health`)).status === 200;

function open(token: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  let closed: number | null = null;
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerToClient));
  ws.on("close", (code) => (closed = code));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        type: "hello",
        token,
        lastSeq: null,
        syncVersion: 1,
        protocolVersion: PROTOCOL_VERSION,
      }),
    ),
  );
  return { ws, frames, closed: () => closed };
}

async function connect(token: string) {
  const socket = open(token);
  await expect.poll(() => socket.frames.some((f) => f.type === "ready")).toBe(true);
  return socket;
}

async function start() {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    // A dropped device's place in a call goes at once here; huddleRejoin.test.ts
    // covers the grace it gets for coming back.
    huddleGraceMs: 0,
  });
  base = `http://127.0.0.1:${server.port}`;
  people = [];
  for (let i = 0; i < 2; i++)
    people.push(
      (
        await request("POST", "/api/auth/register", undefined, {
          handle: `person${i}`,
          displayName: `Person ${i}`,
          password: "password123",
        })
      ).data,
    );
  general = server.store.getChannelByName("general")!.id;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
});

describe("socket callbacks that fail (F03)", () => {
  beforeEach(start);

  it("closes a socket whose session cannot be read on a ping, and keeps serving", async () => {
    const [person] = people as [Person];
    const device = await connect(person.token);
    const before = device.frames.length;
    const check = vi.spyOn(server.store, "isSessionActive").mockImplementation(failing("disk"));

    device.ws.send(JSON.stringify({ type: "ping" }));
    await expect.poll(() => device.closed()).toBe(1011);
    // Nothing answered while the session was unreadable.
    expect(device.frames.slice(before)).toEqual([]);
    expect(await healthy()).toBe(true);
    expect(server.gateway.isOnline(person.user.id)).toBe(false);

    check.mockRestore();
    const again = await connect(person.token);
    again.ws.send(JSON.stringify({ type: "ping" }));
    await expect.poll(() => again.frames.some((f) => f.type === "pong")).toBe(true);
  });

  it("sends no snapshot and announces nobody when a handshake read fails", async () => {
    const [person, watcher] = people as [Person, Person];
    const observer = await connect(watcher.token);
    const read = vi
      .spyOn(server.store, "listChannelsVisibleTo")
      .mockImplementationOnce(failing("disk"));

    const device = open(person.token);
    await expect.poll(() => device.closed()).toBe(1011);
    expect(read).toHaveBeenCalled();
    expect(device.frames).toEqual([]);
    expect(server.gateway.isOnline(person.user.id)).toBe(false);
    // The read failed before the socket joined, so nobody saw it come online.
    expect(
      observer.frames.some(
        (f) =>
          f.type === "ephemeral" &&
          f.event.type === "presence" &&
          f.event.userId === person.user.id,
      ),
    ).toBe(false);
    expect(await healthy()).toBe(true);

    const again = await connect(person.token);
    expect(again.closed()).toBe(null);
  });

  it("closes a socket whose session cannot be read during a fan-out, without failing the post", async () => {
    const [author, reader] = people as [Person, Person];
    const device = await connect(reader.token);
    const check = vi
      .spyOn(server.store, "isSessionActive")
      .mockImplementation((tokenHash, userId) => {
        if (userId === reader.user.id) throw new Error("disk");
        return true;
      });

    const posted = await request("POST", `/api/channels/${general}/messages`, author.token, {
      text: "Read while the disk misbehaves.",
    });
    expect(posted.status).toBe(201);
    await expect.poll(() => device.closed()).toBe(1011);
    expect(
      device.frames.some((f) => f.type === "event" && f.envelope.event.type === "message.created"),
    ).toBe(false);

    check.mockRestore();
    // Reconnecting replays what it missed.
    const again = await connect(reader.token);
    expect(again.closed()).toBe(null);
    expect(await healthy()).toBe(true);
  });

  it("reads each session once, without nesting, when every read fails in a fan-out", async () => {
    const devices = [];
    for (let i = 0; i < 20; i++) {
      const { data } = await request("POST", "/api/auth/register", undefined, {
        handle: `crowd${i}`,
        displayName: `Crowd ${i}`,
        password: "password123",
      });
      devices.push(await connect(data.token));
    }
    // How deep each read sits: before, each person's last socket failing
    // told everyone again from inside that failure, one level deeper per
    // person, so a thousand people were a thousand nested broadcasts.
    const depths: number[] = [];
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = Infinity;
    onTestFinished(() => void (Error.stackTraceLimit = limit));
    const check = vi.spyOn(server.store, "isSessionActive").mockImplementation(() => {
      depths.push(new Error().stack!.split("\n").length);
      throw new Error("disk");
    });

    server.gateway.broadcastEphemeral(
      { type: "presence", userId: "U_ANY", presence: "online" },
      null,
    );
    for (const device of devices) await expect.poll(() => device.closed()).toBe(1011);
    // Each session read once, and every read at the same depth.
    expect(check.mock.calls.length).toBe(20);
    expect(Math.max(...depths) - Math.min(...depths)).toBe(0);
    expect(server.gateway.onlineUserIds()).toEqual([]);
    expect(await healthy()).toBe(true);
  });

  it("forgets a socket whose close notices fail, leaving no ghost in a huddle", async () => {
    const [person, other] = people as [Person, Person];
    const device = await connect(person.token);
    await connect(other.token);
    device.ws.send(JSON.stringify({ type: "huddle.join", channelId: general, requestId: "j1" }));
    await expect.poll(() => server.gateway.huddleParticipants(general)).toEqual([person.user.id]);

    vi.spyOn(server.store, "getChannel").mockImplementation(failing("disk"));
    device.ws.close();
    await expect.poll(() => server.gateway.isOnline(person.user.id)).toBe(false);
    await expect.poll(() => server.gateway.huddleParticipants(general)).toEqual([]);
    expect(await healthy()).toBe(true);
  });
});

describe("the heartbeat when a session read fails (F03)", () => {
  it("closes the affected sockets and keeps serving", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await start();
    const [person, other] = people as [Person, Person];
    const device = await connect(person.token);
    const elsewhere = await connect(other.token);
    const check = vi.spyOn(server.store, "isSessionActive").mockImplementation(failing("disk"));

    vi.advanceTimersByTime(30_000);
    await expect.poll(() => device.closed()).toBe(1011);
    await expect.poll(() => elsewhere.closed()).toBe(1011);
    expect(await healthy()).toBe(true);

    check.mockRestore();
    const again = await connect(person.token);
    vi.advanceTimersByTime(30_000);
    expect(again.closed()).toBe(null);
    expect(server.gateway.isOnline(person.user.id)).toBe(true);
  });

  it("still revokes an ended session on the heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await start();
    const [person] = people as [Person];
    const device = await connect(person.token);
    vi.spyOn(server.store, "isSessionActive").mockReturnValue(false);

    vi.advanceTimersByTime(30_000);
    await expect.poll(() => device.closed()).toBe(4003);
  });
});
