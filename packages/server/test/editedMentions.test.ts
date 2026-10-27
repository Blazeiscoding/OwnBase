import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type Message, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

type Person = { token: string; user: { id: string } };
let server: WorkspaceServer;
let base: string;
let author: Person;
let reader: Person;
let other: Person;
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

async function connect(person: Person) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerToClient));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        type: "hello",
        token: person.token,
        lastSeq: null,
        protocolVersion: PROTOCOL_VERSION,
      }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  const settle = async () => {
    const from = frames.length;
    ws.send(JSON.stringify({ type: "ping" }));
    await expect.poll(() => frames.slice(from).some((f) => f.type === "pong")).toBe(true);
  };
  const counts = () =>
    frames.flatMap((f) =>
      f.type === "ephemeral" && f.event.type === "mentions" ? [f.event.counts] : [],
    );
  return { frames, settle, counts };
}

async function post(text: string, roomId = channelId): Promise<Message> {
  const response = await request(`/api/channels/${roomId}/messages`, author.token, { text });
  expect(response.status).toBe(201);
  return response.data.message;
}

const edit = (message: Message, text: string) =>
  request(
    `/api/messages/${message.id}`,
    author.token,
    { text, expectedText: message.text },
    "PATCH",
  );

async function mentions(person: Person) {
  const response = await request("/api/activity?mode=mentions", person.token, undefined, "GET");
  expect(response.status).toBe(200);
  return response.data.messages as Message[];
}

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
  other = await register("other");
  channelId = server.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.stop();
});

describe("live mention counts after edits", () => {
  it("refreshes removed and newly named readers once, matching Activity and stored counts", async () => {
    const firstReader = await connect(reader);
    const secondReader = await connect(other);
    const message = await post(`first <@${reader.user.id}>`);
    await firstReader.settle();
    await secondReader.settle();
    firstReader.frames.length = 0;
    secondReader.frames.length = 0;

    expect((await edit(message, `second <@${other.user.id}> <@${other.user.id}>`)).status).toBe(
      200,
    );
    await firstReader.settle();
    await secondReader.settle();

    expect(firstReader.counts()).toEqual([{}]);
    expect(secondReader.counts()).toEqual([{ [channelId]: 1 }]);
    expect(firstReader.counts().at(-1)).toEqual(server.store.unreadMentionCounts(reader.user.id));
    expect(secondReader.counts().at(-1)).toEqual(server.store.unreadMentionCounts(other.user.id));
    expect(await mentions(reader)).toEqual([]);
    expect((await mentions(other)).map((m) => m.id)).toEqual([message.id]);
  });

  it("adds and removes room-wide mentions without duplicate refreshes", async () => {
    const firstReader = await connect(reader);
    const secondReader = await connect(other);
    const authorSocket = await connect(author);
    const message = await post("plain text");
    expect((await edit(message, `<!here> <@${reader.user.id}>`)).status).toBe(200);
    await firstReader.settle();
    await secondReader.settle();
    await authorSocket.settle();
    expect(firstReader.counts()).toEqual([{ [channelId]: 1 }]);
    expect(secondReader.counts()).toEqual([{ [channelId]: 1 }]);
    expect(authorSocket.counts()).toEqual([]);

    const current = server.store.getMessage(message.id)!;
    expect((await edit(current, "no longer mentioned")).status).toBe(200);
    await firstReader.settle();
    await secondReader.settle();
    expect(firstReader.counts()).toEqual([{ [channelId]: 1 }, {}]);
    expect(secondReader.counts()).toEqual([{ [channelId]: 1 }, {}]);
    expect(await mentions(reader)).toEqual([]);
    expect(await mentions(other)).toEqual([]);
  });

  it("emits no mention refresh after a transaction failure or stale edit conflict", async () => {
    const readerSocket = await connect(reader);
    const message = await post("original");
    await readerSocket.settle();
    readerSocket.frames.length = 0;
    vi.spyOn(server.store, "appendEvent").mockImplementationOnce(() => {
      throw new Error("injected event commit failure");
    });
    expect((await edit(message, `<@${reader.user.id}>`)).status).toBe(500);
    await readerSocket.settle();
    expect(server.store.getMessage(message.id)?.text).toBe("original");
    expect(server.store.unreadMentionCounts(reader.user.id)).toEqual({});
    expect(readerSocket.counts()).toEqual([]);
    expect(readerSocket.frames.some((f) => f.type === "event")).toBe(false);

    expect((await edit(message, "new version")).status).toBe(200);
    await readerSocket.settle();
    readerSocket.frames.length = 0;
    expect((await edit(message, `<@${reader.user.id}> stale edit`)).status).toBe(409);
    await readerSocket.settle();
    expect(readerSocket.counts()).toEqual([]);
    expect(server.store.getMessage(message.id)?.text).toBe("new version");
  });

  it("does not refresh a removed private-channel reader or an unrelated member", async () => {
    const room = (
      await request("/api/channels", author.token, {
        type: "private",
        name: "private-room",
        memberIds: [reader.user.id],
      })
    ).data.channel;
    const readerSocket = await connect(reader);
    const outsiderSocket = await connect(other);
    const message = await post(`<@${reader.user.id}>`, room.id);
    await request(
      `/api/channels/${room.id}/members/${reader.user.id}`,
      author.token,
      undefined,
      "DELETE",
    );
    await readerSocket.settle();
    await outsiderSocket.settle();
    readerSocket.frames.length = 0;
    outsiderSocket.frames.length = 0;

    expect((await edit(message, `<!channel> <@${other.user.id}>`)).status).toBe(200);
    await readerSocket.settle();
    await outsiderSocket.settle();
    expect(readerSocket.counts()).toEqual([]);
    expect(outsiderSocket.counts()).toEqual([]);
    expect(readerSocket.frames.some((f) => f.type === "event")).toBe(false);
    expect(outsiderSocket.frames.some((f) => f.type === "event")).toBe(false);
  });
});
