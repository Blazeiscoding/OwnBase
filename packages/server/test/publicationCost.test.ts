import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type Message, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * What publishing a message costs (REV-06, slice A). Text naming nobody reads
 * no members; text naming people checks just them; and only someone connected
 * is recounted, once per committed change. Anyone else gets their counts from
 * the handshake, which reads the committed rows.
 */
type Person = { token: string; user: { id: string } };
let server: WorkspaceServer;
let base: string;
let people: Person[];
let channelId: string;
const sockets: WebSocket[] = [];
const MEMBERS = 50;

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

async function post(author: Person, text: string, threadRootId?: string): Promise<Message> {
  const response = await request(`/api/channels/${channelId}/messages`, author.token, {
    text,
    ...(threadRootId ? { threadRootId } : {}),
  });
  expect(response.status).toBe(201);
  return response.data.message;
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
        syncVersion: 1,
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
      f.type === "ephemeral" && f.event.type === "mentions" ? [f.event.counts[channelId] ?? 0] : [],
    );
  return { frames, settle, counts };
}

/** Calls to what a publication may cost, from here on. */
function cost() {
  return {
    members: vi.spyOn(server.store, "memberIds"),
    membership: vi.spyOn(server.store, "isMember"),
    recounts: vi.spyOn(server.store, "unreadMentionCounts"),
  };
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
  people = [];
  for (let i = 0; i < MEMBERS; i++)
    people.push(
      (
        await request("/api/auth/register", undefined, {
          handle: `member${i}`,
          displayName: `Member ${i}`,
          password: "password123",
        })
      ).data,
    );
  channelId = server.store.getChannelByName("general")!.id;
  expect(server.store.memberIds(channelId)).toHaveLength(MEMBERS);
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.stop();
});

describe("publishing a message (REV-06)", () => {
  it("reads no members and recounts nobody for text naming nobody", async () => {
    const [author, reader] = people as [Person, Person];
    const watcher = await connect(reader);
    const { members, recounts } = cost();
    await post(author, "Lunch is at noon.");
    await watcher.settle();
    expect(members).not.toHaveBeenCalled();
    expect(recounts).not.toHaveBeenCalled();
  });

  it("checks just the people text names, and recounts the one connected", async () => {
    const [author, reader, absent] = people as [Person, Person, Person];
    const watcher = await connect(reader);
    const { members, membership, recounts } = cost();
    await post(author, `<@${reader.user.id}> and <@${absent.user.id}>, see this`);
    await watcher.settle();
    expect(members).not.toHaveBeenCalled();
    // Each person named is checked on their own; posting also checks the author.
    expect(membership.mock.calls.map(([, userId]) => userId)).toEqual(
      expect.arrayContaining([reader.user.id, absent.user.id]),
    );
    expect(recounts.mock.calls).toEqual([[reader.user.id]]);
    expect(watcher.counts()).toEqual([1]);
  });

  it("recounts nobody for a room-wide mention with nobody connected, and the handshake still counts it", async () => {
    const [author, reader] = people as [Person, Person];
    const { recounts } = cost();
    await post(author, "<!channel> the build is green");
    expect(recounts).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const late = await connect(reader);
    const ready = late.frames.find((f) => f.type === "ready") as Extract<
      ServerToClient,
      { type: "ready" }
    >;
    expect(ready.mentionCounts?.[channelId]).toBe(1);
  });

  it("deletes a 21-message thread with no recounts offline, and one per connected member", async () => {
    const [author, ...others] = people as [Person, ...Person[]];
    const root = await post(author, "<!channel> plans for the offsite");
    for (let i = 0; i < 20; i++) await post(author, `<!channel> detail ${i}`, root.id);

    const { members, recounts } = cost();
    const second = await post(author, "<!channel> a second thread");
    expect(recounts).not.toHaveBeenCalled();
    expect(
      (await request(`/api/messages/${root.id}`, author.token, undefined, "DELETE")).status,
    ).toBe(200);
    expect(recounts).not.toHaveBeenCalled();
    expect(members.mock.calls.length).toBeLessThanOrEqual(1);

    // Two members connected: each recounted once for the whole deletion.
    const watchers = [await connect(others[0]!), await connect(others[1]!)];
    for (let i = 0; i < 20; i++) await post(author, `<!channel> more ${i}`, second.id);
    recounts.mockClear();
    members.mockClear();
    expect(
      (await request(`/api/messages/${second.id}`, author.token, undefined, "DELETE")).status,
    ).toBe(200);
    for (const watcher of watchers) await watcher.settle();
    expect(members).toHaveBeenCalledTimes(1);
    expect(recounts.mock.calls.map(([userId]) => userId).sort()).toEqual(
      [others[0]!.user.id, others[1]!.user.id].sort(),
    );
    for (const watcher of watchers) expect(watcher.counts().at(-1)).toBe(0);
  });

  it("reads a private channel's members not at all offline, and once for a connected batch (F10)", async () => {
    const [author, ...others] = people as [Person, ...Person[]];
    const created = await request("/api/channels", author.token, {
      name: "private-plans",
      type: "private",
    });
    expect(created.status).toBe(201);
    channelId = created.data.channel.id;
    for (const other of others)
      expect(
        (
          await request(`/api/channels/${channelId}/invite-member`, author.token, {
            userId: other.user.id,
          })
        ).status,
      ).toBe(200);
    expect(server.store.memberIds(channelId)).toHaveLength(MEMBERS);

    const thread = async (label: string) => {
      const root = await post(author, `<!channel> ${label}`);
      for (let i = 0; i < 20; i++) await post(author, `<!channel> ${label} ${i}`, root.id);
      return root;
    };
    const deleted = (frames: ServerToClient[]) =>
      frames.filter((f) => f.type === "event" && f.envelope.event.type === "message.deleted")
        .length;

    // Nobody connected: no audience to read for any of the 21 deletions.
    const offline = await thread("offline");
    const { members, recounts } = cost();
    expect(
      (await request(`/api/messages/${offline.id}`, author.token, undefined, "DELETE")).status,
    ).toBe(200);
    expect(members).not.toHaveBeenCalled();
    expect(recounts).not.toHaveBeenCalled();

    // Two members connected: one read serves every deletion and the recounts.
    const watchers = [await connect(others[0]!), await connect(others[1]!)];
    const online = await thread("online");
    members.mockClear();
    recounts.mockClear();
    const before = watchers.map((w) => deleted(w.frames));
    expect(
      (await request(`/api/messages/${online.id}`, author.token, undefined, "DELETE")).status,
    ).toBe(200);
    for (const watcher of watchers) await watcher.settle();
    expect(members).toHaveBeenCalledTimes(1);
    expect(watchers.map((w, i) => deleted(w.frames) - before[i]!)).toEqual([21, 21]);
    expect(recounts.mock.calls.map(([userId]) => userId).sort()).toEqual(
      [others[0]!.user.id, others[1]!.user.id].sort(),
    );
    for (const watcher of watchers) expect(watcher.counts().at(-1)).toBe(0);
  }, 30_000);
});
