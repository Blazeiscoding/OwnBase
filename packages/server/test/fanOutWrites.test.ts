import { request } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * What a fan-out costs in writes to the network (J19). With 200 people, every
 * frame to every socket was a write of its own, the largest part of the
 * server's work; frames to one socket in one turn now go out as one write.
 */
let server: WorkspaceServer;
let base: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.stop();
});

async function person(handle: string) {
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
  // The server's end of this connection is the socket whose far port is ours.
  const port = (ws as unknown as { _socket: Socket })._socket.localPort ?? -1;
  return { frames, port };
}

/** Each write a server-side socket makes to the network, by the port of the far end. */
function writes() {
  const by = new Map<number, number>();
  const order: number[] = [];
  const count = function (this: Socket) {
    const port = this.remotePort;
    if (port === undefined) return;
    by.set(port, (by.get(port) ?? 0) + 1);
    order.push(port);
  };
  const writev = Socket.prototype._writev!;
  const write = Socket.prototype._write;
  vi.spyOn(Socket.prototype, "_writev").mockImplementation(function (this: Socket, ...args) {
    count.call(this);
    return writev.apply(this, args);
  });
  vi.spyOn(Socket.prototype, "_write").mockImplementation(function (this: Socket, ...args) {
    count.call(this);
    return write.apply(this, args);
  });
  return Object.assign(by, { order });
}

/** Posts a message over a connection of its own; resolves with its local port once answered. */
function post(token: string, channelId: string, text: string) {
  return new Promise<number>((resolve, reject) => {
    let port = -1;
    const body = JSON.stringify({ text });
    const req = request(
      `${base}/api/channels/${channelId}/messages`,
      {
        method: "POST",
        agent: false,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          res.statusCode === 201 ? resolve(port) : reject(new Error(String(res.statusCode))),
        );
      },
    );
    req.on("socket", (socket) => socket.on("connect", () => (port = socket.localPort ?? -1)));
    req.on("error", reject);
    req.end(body);
  });
}

describe("frames to one socket in one turn", () => {
  it("leave before the answer to the request that made them", async () => {
    // A client takes the answer to its own change as coming after the change's
    // events, as it always did; held frames go out before any answer.
    const sam = await person("sam");
    const kim = await person("kim");
    const { frames, port } = await connect(sam.token);
    const general = server.store.channels.byName("general")!.id;
    const counted = writes();
    const answeredOn = await post(kim.token, general, "Lunch at noon?");
    await expect
      .poll(() =>
        frames.some((f) => f.type === "event" && f.envelope.event.type === "message.created"),
      )
      .toBe(true);
    const event = counted.order.indexOf(port);
    const answer = counted.order.indexOf(answeredOn);
    expect(event).toBeGreaterThanOrEqual(0);
    expect(answer).toBeGreaterThanOrEqual(0);
    expect(event).toBeLessThan(answer);
  });

  it("reach the network as one write", async () => {
    const sam = await person("sam");
    const { frames, port } = await connect(sam.token);
    const before = frames.length;
    const counted = writes();

    // Three fan-outs in the same turn, as a burst of typing or presence makes.
    for (const presence of ["away", "online", "away"] as const)
      server.gateway.tellEveryone({ type: "presence", userId: sam.user.id, presence });

    await expect.poll(() => frames.length - before).toBe(3);
    expect(counted.get(port)).toBe(1);
  });

  it("still send each turn's frames in that turn, in order", async () => {
    const sam = await person("sam");
    const { frames } = await connect(sam.token);
    const before = frames.length;
    server.gateway.tellEveryone({ type: "presence", userId: sam.user.id, presence: "away" });
    await expect.poll(() => frames.length - before).toBe(1);
    server.gateway.tellEveryone({ type: "presence", userId: sam.user.id, presence: "online" });
    server.gateway.tellEveryone({ type: "presence", userId: sam.user.id, presence: "away" });
    await expect.poll(() => frames.length - before).toBe(3);
    expect(
      frames
        .slice(before)
        .map((f) =>
          f.type === "ephemeral" ? (f.event as { presence?: string }).presence : f.type,
        ),
    ).toEqual(["away", "online", "away"]);
  });
});
