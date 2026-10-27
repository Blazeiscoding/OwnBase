import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * What a fan-out costs in session checks (REV-06, slice B). One publication
 * asks once per session, however many of its devices it reaches, and a
 * private channel's fan-out visits only its members' sockets. An ended
 * session still closes every socket it has on the first fan-out after.
 */
type Person = { token: string; user: { id: string; handle: string } };
let server: WorkspaceServer;
let base: string;
let people: Person[];
let general: string;
const sockets: WebSocket[] = [];
const DEVICES = 20;

async function request(path: string, token?: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as any };
}

async function post(author: Person, channelId: string, text: string) {
  const response = await request(`/api/channels/${channelId}/messages`, author.token, { text });
  expect(response.status).toBe(201);
  return response.data.message as { id: string };
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
  const received = (messageId: string) =>
    frames.some(
      (f) =>
        f.type === "event" &&
        f.envelope.event.type === "message.created" &&
        f.envelope.event.message.id === messageId,
    );
  return { frames, received, closed: () => closed };
}

/** Each session check from here on, by the person it was for. */
function checks() {
  return vi.spyOn(server.store, "isSessionActive");
}
const asked = (spy: ReturnType<typeof checks>) => spy.mock.calls.map(([, userId]) => userId);

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  people = [];
  for (let i = 0; i < 3; i++)
    people.push(
      (
        await request("/api/auth/register", undefined, {
          handle: `person${i}`,
          displayName: `Person ${i}`,
          password: "password123",
        })
      ).data,
    );
  general = server.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.stop();
});

describe("session checks in a fan-out (REV-06)", () => {
  it("asks once per session, however many devices it reaches", async () => {
    const [author, busy, other] = people as [Person, Person, Person];
    const devices = [];
    for (let i = 0; i < DEVICES; i++) devices.push(await connect(busy.token));
    const elsewhere = await connect(other.token);
    const spy = checks();
    const message = await post(author, general, "Lunch is at noon.");
    for (const device of devices) await expect.poll(() => device.received(message.id)).toBe(true);
    await expect.poll(() => elsewhere.received(message.id)).toBe(true);
    // One check for the session on twenty sockets, one for the other person.
    expect(asked(spy).filter((id) => id === busy.user.id)).toHaveLength(1);
    expect(asked(spy).filter((id) => id === other.user.id)).toHaveLength(1);
  });

  it("asks separately for each session one person has", async () => {
    const [author, busy] = people as [Person, Person];
    const second = await request("/api/auth/login", undefined, {
      handle: busy.user.handle,
      password: "password123",
    });
    expect(second.status).toBe(200);
    const devices = [];
    for (let i = 0; i < 5; i++) devices.push(await connect(busy.token));
    for (let i = 0; i < 5; i++) devices.push(await connect(second.data.token));
    const spy = checks();
    const message = await post(author, general, "Two laptops, one person.");
    for (const device of devices) await expect.poll(() => device.received(message.id)).toBe(true);
    expect(asked(spy).filter((id) => id === busy.user.id)).toHaveLength(2);
  });

  it("closes every socket of an ended session on the next fan-out, and delivers to the rest", async () => {
    const [author, ended, other] = people as [Person, Person, Person];
    const devices = [];
    for (let i = 0; i < 5; i++) devices.push(await connect(ended.token));
    const elsewhere = await connect(other.token);
    // The session ends (it expires, say) without the gateway being told.
    const active = server.store.isSessionActive.bind(server.store);
    const spy = vi
      .spyOn(server.store, "isSessionActive")
      .mockImplementation((tokenHash, userId) =>
        userId === ended.user.id ? false : active(tokenHash, userId),
      );
    const message = await post(author, general, "Anyone still here?");
    await expect.poll(() => elsewhere.received(message.id)).toBe(true);
    for (const device of devices) {
      await expect.poll(() => device.closed()).toBe(4003);
      expect(device.received(message.id)).toBe(false);
      expect(device.frames.at(-1)).toMatchObject({ type: "error", code: "auth_failed" });
    }
    expect(asked(spy).filter((id) => id === ended.user.id)).toHaveLength(1);
  });

  it("visits only members' sockets for a private channel", async () => {
    const [author, member, outsider] = people as [Person, Person, Person];
    const created = await request("/api/channels", author.token, {
      type: "private",
      name: "plans",
      memberIds: [member.user.id],
    });
    expect(created.status).toBe(201);
    const inside = await connect(member.token);
    const outside = [];
    for (let i = 0; i < 5; i++) outside.push(await connect(outsider.token));
    const spy = checks();
    const message = await post(author, created.data.channel.id, "Just us.");
    await expect.poll(() => inside.received(message.id)).toBe(true);
    // A public message after it marks where the private fan-out ended.
    const marker = await post(author, general, "And now everyone.");
    for (const socket of outside) {
      await expect.poll(() => socket.received(marker.id)).toBe(true);
      expect(socket.received(message.id)).toBe(false);
    }
    // The outsider's session was checked for the public message alone.
    expect(asked(spy).filter((id) => id === outsider.user.id)).toHaveLength(1);
  });
});
