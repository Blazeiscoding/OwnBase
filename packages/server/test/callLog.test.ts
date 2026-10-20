import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  type CallLogEntry,
  type CallReport,
  type ServerToClient,
} from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import { CALL_LOG_LIMIT, CallLog } from "../src/callLog.js";

/**
 * The host's call log: who joined and left a huddle, which call setups the
 * server passed on or could not, and what each side said of its connection.
 */
type Person = { token: string; user: { id: string } };
let server: WorkspaceServer;
let base: string;
let owner: Person;
let member: Person;
let general: string;
const sockets: WebSocket[] = [];

async function call(method: string, path: string, token?: string, body?: unknown) {
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

async function connect(token: string) {
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
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  const send = (msg: unknown) => ws.send(JSON.stringify(msg));
  return { frames, send, closed: () => closed };
}

const calls = async (token: string) =>
  (await call("GET", "/api/admin/calls", token)).data.entries as CallLogEntry[];
const kinds = (entries: CallLogEntry[]) =>
  entries.map((e) => [e.kind, e.userId, e.peerId ?? null, e.reason ?? null]);

const report: CallReport = {
  outcome: "stalled",
  afterMs: 15_000,
  iceServers: { stun: 1, turn: 0 },
  local: { host: 2, srflx: 1, prflx: 0, relay: 0 },
  remote: { host: 1, srflx: 1, prflx: 0, relay: 0 },
  connectionState: "connecting",
  iceConnectionState: "checking",
  retries: 0,
  cause: "needs_relay",
};

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
    // A dropped device's place in a call goes at once here; huddleRejoin.test.ts
    // covers the grace it gets for coming back.
    huddleGraceMs: 0,
  });
  base = `http://127.0.0.1:${server.port}`;
  const register = async (handle: string) =>
    (
      await call("POST", "/api/auth/register", undefined, {
        handle,
        displayName: handle,
        password: "password123",
      })
    ).data as Person;
  owner = await register("owner");
  member = await register("member");
  general = (await call("GET", "/api/channels", owner.token)).data.channels[0].id;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.stop();
});

describe("the call log", () => {
  it("records joining, the setup passed on, what each side reports, and leaving", async () => {
    const a = await connect(owner.token);
    const b = await connect(member.token);
    expect(a.frames.find((f) => f.type === "ready")).toMatchObject({ huddleReports: true });
    a.send({ type: "huddle.join", channelId: general, requestId: "1" });
    b.send({ type: "huddle.join", channelId: general, requestId: "1" });
    await expect.poll(async () => (await calls(owner.token)).length).toBe(2);
    a.send({
      type: "huddle.signal",
      channelId: general,
      to: member.user.id,
      signal: { kind: "offer", sdp: "v=0" },
    });
    b.send({
      type: "huddle.signal",
      channelId: general,
      to: owner.user.id,
      signal: { kind: "answer", sdp: "v=0" },
    });
    // Routes come by the dozen and are not written down one by one.
    b.send({
      type: "huddle.signal",
      channelId: general,
      to: owner.user.id,
      signal: { kind: "ice", candidate: { candidate: "c", sdpMid: "0", sdpMLineIndex: 0 } },
    });
    b.send({ type: "huddle.report", channelId: general, peer: owner.user.id, report });
    b.send({ type: "huddle.leave", channelId: general });
    await expect.poll(async () => (await calls(owner.token)).length).toBe(6);
    const entries = await calls(owner.token);
    expect(kinds(entries)).toEqual([
      ["joined", owner.user.id, null, null],
      ["joined", member.user.id, null, null],
      ["offer", owner.user.id, member.user.id, null],
      ["answer", member.user.id, owner.user.id, null],
      ["report", member.user.id, owner.user.id, null],
      ["left", member.user.id, null, "left"],
    ]);
    expect(entries[4]!.report).toEqual(report);
    expect(JSON.stringify(entries)).not.toContain("v=0");
  });

  it("says when a setup could not be passed on, and when someone's connection dropped", async () => {
    const a = await connect(owner.token);
    await connect(member.token);
    a.send({ type: "huddle.join", channelId: general, requestId: "1" });
    // The member is not in the huddle: the offer goes nowhere, and says so.
    a.send({
      type: "huddle.signal",
      channelId: general,
      to: member.user.id,
      signal: { kind: "offer", sdp: "v=0" },
    });
    await expect.poll(async () => (await calls(owner.token)).length).toBe(2);
    sockets[0]!.terminate();
    await expect.poll(async () => (await calls(owner.token)).length).toBe(3);
    expect(kinds(await calls(owner.token))).toEqual([
      ["joined", owner.user.id, null, null],
      ["dropped", owner.user.id, member.user.id, "offer: the other person is not in the huddle"],
      ["left", owner.user.id, null, "disconnected"],
    ]);
  });

  it("is for the owner and admins, and only for conversations they can see", async () => {
    expect((await call("GET", "/api/admin/calls", member.token)).status).toBe(403);
    const room = (
      await call("POST", "/api/channels", member.token, { type: "private", name: "hidden" })
    ).data.channel;
    const b = await connect(member.token);
    b.send({ type: "huddle.join", channelId: room.id, requestId: "1" });
    b.send({ type: "huddle.join", channelId: general, requestId: "2" });
    await expect.poll(async () => (await calls(owner.token)).length).toBe(1);
    expect((await calls(owner.token))[0]).toMatchObject({ channelId: general });
  });

  it("closes a socket that sends a report it cannot read, as for any message", async () => {
    const a = await connect(owner.token);
    a.send({
      type: "huddle.report",
      channelId: general,
      peer: member.user.id,
      report: { ...report, local: { host: -1 } },
    });
    await expect.poll(a.closed).toBe(4000);
  });

  it("keeps the latest lines and lets the oldest go", () => {
    let now = 0;
    const log = new CallLog(() => ++now);
    for (let i = 0; i < CALL_LOG_LIMIT + 5; i++)
      log.add({ channelId: i % 2 ? "C_ODD" : "C_EVEN", userId: "U", kind: "joined" });
    const all = log.entries(() => true);
    expect(all).toHaveLength(CALL_LOG_LIMIT);
    expect(all[0]!.at).toBe(6);
    expect(log.entries((id) => id === "C_ODD").every((e) => e.channelId === "C_ODD")).toBe(true);
  });
});
