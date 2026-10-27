import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  type EventEnvelope,
  type Message,
  type ServerToClient,
} from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * After a change commits, its events must reach everyone who may see them,
 * whatever fails after it (REV-10). A recount is replaceable and fails alone;
 * a frame that cannot go out makes clients replay from what they have.
 */
type Person = { token: string; user: { id: string } };
let server: WorkspaceServer;
let base: string;
let author: Person;
let reader: Person;
let channelId: string;
const sockets: WebSocket[] = [];

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

async function register(handle: string): Promise<Person> {
  return (
    await request("/api/auth/register", undefined, {
      handle,
      displayName: handle,
      password: "password123",
    })
  ).data;
}

function connect(person: Person, lastSeq: number | null = null) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  let closeCode: number | null = null;
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerToClient));
  ws.on("close", (code) => (closeCode = code));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        type: "hello",
        token: person.token,
        lastSeq,
        syncVersion: 1,
        protocolVersion: PROTOCOL_VERSION,
      }),
    ),
  );
  const events = () =>
    frames.flatMap((f) => (f.type === "event" ? [f.envelope] : [])) as EventEnvelope[];
  const settle = async () => {
    const from = frames.length;
    ws.send(JSON.stringify({ type: "ping" }));
    await expect.poll(() => frames.slice(from).some((f) => f.type === "pong")).toBe(true);
  };
  return { ws, frames, events, settle, closed: () => closeCode };
}

async function post(text: string, threadRootId?: string): Promise<Message> {
  const response = await request(`/api/channels/${channelId}/messages`, author.token, {
    text,
    ...(threadRootId ? { threadRootId } : {}),
  });
  expect(response.status).toBe(201);
  return response.data.message;
}

/** A root naming the reader, so deleting it changes their mention count, with three replies. */
async function thread() {
  const root = await post(`plans <@${reader.user.id}>`);
  const replies = [
    await post("one", root.id),
    await post("two", root.id),
    await post("three", root.id),
  ];
  return { root, ids: [root.id, ...replies.map((m) => m.id)] };
}

const deleted = (events: EventEnvelope[]) =>
  events.flatMap((e) => (e.event.type === "message.deleted" ? [e.event.messageId] : []));

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  author = await register("author");
  reader = await register("reader");
  channelId = server.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.stop();
});

describe("publishing what has committed (REV-10)", () => {
  it("sends every deletion and says the delete happened when a recount fails after it", async () => {
    const watcher = connect(reader);
    await expect.poll(() => watcher.frames.some((f) => f.type === "ready")).toBe(true);
    const { root, ids } = await thread();
    await watcher.settle();
    vi.spyOn(server.store, "unreadMentionCounts").mockImplementation(() => {
      throw new Error("disk read failed");
    });

    const response = await request(`/api/messages/${root.id}`, author.token, undefined, "DELETE");
    expect(response.status).toBe(200);
    await watcher.settle();
    expect(deleted(watcher.events()).sort()).toEqual([...ids].sort());
    expect(watcher.closed()).toBeNull();

    // The next change goes out as usual once counts can be read again.
    vi.restoreAllMocks();
    const later = await post("after");
    await watcher.settle();
    expect(watcher.events().at(-1)?.event).toMatchObject({
      type: "message.created",
      message: { id: later.id },
    });
  });

  it("closes sockets when a committed frame cannot go out, and the rest replay on reconnect", async () => {
    const watcher = connect(reader);
    await expect.poll(() => watcher.frames.some((f) => f.type === "ready")).toBe(true);
    const { root, ids } = await thread();
    await watcher.settle();
    const publish = server.gateway.publish.bind(server.gateway);
    let calls = 0;
    vi.spyOn(server.gateway, "publish").mockImplementation((envelope, channel) => {
      if (++calls === 2) throw new Error("could not serialize");
      publish(envelope, channel);
    });

    const response = await request(`/api/messages/${root.id}`, author.token, undefined, "DELETE");
    expect(response.status).toBe(200);
    await expect.poll(watcher.closed).toBe(1012);
    // Only the first deletion reached it live; nothing after the failure did.
    const live = deleted(watcher.events());
    expect(live).toHaveLength(1);
    const checkpoint = watcher.events().at(-1)!.seq;

    vi.restoreAllMocks();
    const again = connect(reader, checkpoint);
    await expect.poll(() => again.frames.some((f) => f.type === "synced")).toBe(true);
    expect([...live, ...deleted(again.events())].sort()).toEqual([...ids].sort());
  });
});
