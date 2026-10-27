import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Losing a membership, by removal or by leaving: what each person is told,
 * who keeps a seat in the room's call, and what a group conversation becomes
 * when someone leaves it and the same people start one again.
 */
type Person = { token: string; id: string };

let server: WorkspaceServer;
let base: string;
let owner: Person;
let ana: Person;
let ben: Person;
const sockets: WebSocket[] = [];

async function request(path: string, token: string, method = "POST", body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}

async function register(handle: string): Promise<Person> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  const data = (await res.json()) as any;
  return { token: data.token, id: data.user.id };
}

async function connect(person: Person) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerToClient));
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
  const heard = (predicate: (frame: ServerToClient) => boolean) =>
    expect.poll(() => frames.some(predicate)).toBe(true);
  return { ws, frames, heard };
}

const lostAccess = (channelId: string) => (f: ServerToClient) =>
  f.type === "ephemeral" &&
  f.event.type === "channel.access" &&
  f.event.channelId === channelId &&
  f.event.channel === null &&
  f.event.membership === null;

const left = (channelId: string, userId: string) => (f: ServerToClient) =>
  f.type === "event" &&
  f.envelope.event.type === "member.left" &&
  f.envelope.event.channelId === channelId &&
  f.envelope.event.userId === userId;

const huddleOf = (channelId: string, userIds: string[]) => (f: ServerToClient) =>
  f.type === "ephemeral" &&
  f.event.type === "huddle.participants" &&
  f.event.channelId === channelId &&
  [...f.event.userIds].sort().join() === [...userIds].sort().join();

const post = (channelId: string, by: Person, text: string) =>
  request(`/api/channels/${channelId}/messages`, by.token, "POST", { text });
const history = (channelId: string, by: Person) =>
  request(`/api/channels/${channelId}/messages`, by.token, "GET");

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  owner = await register("owner");
  ana = await register("ana");
  ben = await register("ben");
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.stop();
});

describe("removing someone from a room", () => {
  it("tells them and the room, ends their seat in a private room's call, and stops what follows", async () => {
    const room = await request("/api/channels", owner.token, "POST", {
      type: "private",
      name: "leads",
      memberIds: [ana.id, ben.id],
    });
    const roomId = room.data.channel.id as string;
    const anaSocket = await connect(ana);
    const benSocket = await connect(ben);
    anaSocket.ws.send(JSON.stringify({ type: "huddle.join", channelId: roomId }));
    benSocket.ws.send(JSON.stringify({ type: "huddle.join", channelId: roomId }));
    await anaSocket.heard(huddleOf(roomId, [ana.id, ben.id]));

    expect(
      (await request(`/api/channels/${roomId}/members/${ben.id}`, owner.token, "DELETE")).status,
    ).toBe(200);

    await benSocket.heard(lostAccess(roomId));
    await anaSocket.heard(left(roomId, ben.id));
    await anaSocket.heard(huddleOf(roomId, [ana.id]));
    expect(server.gateway.huddleParticipants(roomId)).toEqual([ana.id]);
    // Asking to sit back down in the call is refused.
    benSocket.ws.send(JSON.stringify({ type: "huddle.join", channelId: roomId }));

    benSocket.frames.length = 0;
    await post(roomId, ana, "After Ben left");
    await anaSocket.heard(
      (f) =>
        f.type === "event" &&
        f.envelope.event.type === "message.created" &&
        f.envelope.event.message.text === "After Ben left",
    );
    expect(
      benSocket.frames.some(
        (f) => f.type === "event" && f.envelope.event.type === "message.created",
      ),
    ).toBe(false);
    expect(server.gateway.huddleParticipants(roomId)).toEqual([ana.id]);
    expect((await history(roomId, ben)).status).toBe(404);
  });

  it("leaves a public room readable to whoever was removed, and its call open to them", async () => {
    const room = await request("/api/channels", owner.token, "POST", {
      type: "public",
      name: "lobby",
    });
    const roomId = room.data.channel.id as string;
    await request(`/api/channels/${roomId}/invite-member`, owner.token, "POST", {
      userId: ben.id,
    });
    const benSocket = await connect(ben);
    benSocket.ws.send(JSON.stringify({ type: "huddle.join", channelId: roomId }));
    await expect.poll(() => server.gateway.huddleParticipants(roomId)).toEqual([ben.id]);

    await request(`/api/channels/${roomId}/members/${ben.id}`, owner.token, "DELETE");
    // Told the membership ended, but not that the room went away.
    await benSocket.heard(
      (f) =>
        f.type === "ephemeral" &&
        f.event.type === "channel.access" &&
        f.event.channelId === roomId &&
        f.event.channel?.id === roomId &&
        f.event.membership === null,
    );
    expect(server.gateway.huddleParticipants(roomId)).toEqual([ben.id]);
    expect((await history(roomId, ben)).status).toBe(200);
    expect(server.store.isMember(roomId, ben.id)).toBe(false);
  });
});

describe("public rooms take in everyone", () => {
  const joined = (channelId: string, userId: string) => (f: ServerToClient) =>
    f.type === "event" &&
    f.envelope.event.type === "member.joined" &&
    f.envelope.event.channelId === channelId &&
    f.envelope.event.userId === userId;
  const guestJoin = async (displayName: string): Promise<Person> => {
    const res = await fetch(`${base}/api/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    const data = (await res.json()) as any;
    return { token: data.token, id: data.user.id };
  };

  it("adds everyone here when one is made, and tells them at once", async () => {
    server.setAccessPolicy("guest_allowed");
    const gone = await guestJoin("Gone");
    // Turning guests off ends every guest's session; this one never returns.
    server.setAccessPolicy("account_required");
    server.setAccessPolicy("guest_allowed");
    const visitor = await guestJoin("Visitor");
    const cleo = await register("cleo");
    await request(`/api/admin/users/${cleo.id}`, owner.token, "PATCH", { deactivated: true });
    const app = await request("/api/apps", owner.token, "POST", { name: "Deploys" });
    const anaSocket = await connect(ana);

    const room = await request("/api/channels", owner.token, "POST", {
      type: "public",
      name: "lobby",
    });
    const roomId = room.data.channel.id as string;

    await anaSocket.heard(joined(roomId, ana.id));
    const members = server.store.memberIds(roomId);
    expect([...members].sort()).toEqual([owner.id, ana.id, ben.id, visitor.id].sort());
    for (const outsider of [gone.id, cleo.id, app.data.botUser.id as string])
      expect(members).not.toContain(outsider);
  });

  it("puts someone new in every open public room, but no archived or private one", async () => {
    const make = async (type: "public" | "private", name: string) =>
      (await request("/api/channels", owner.token, "POST", { type, name, memberIds: [] })).data
        .channel.id as string;
    const lobby = await make("public", "lobby");
    const old = await make("public", "old");
    await request(`/api/channels/${old}`, owner.token, "PATCH", { archived: true });
    const leads = await make("private", "leads");
    const general = server.store.getChannelByName("general")!.id;

    const dana = await register("dana");
    server.setAccessPolicy("guest_allowed");
    const visitor = await guestJoin("Visitor");

    for (const person of [dana, visitor]) {
      expect(server.store.isMember(general, person.id)).toBe(true);
      expect(server.store.isMember(lobby, person.id)).toBe(true);
      expect(server.store.isMember(old, person.id)).toBe(false);
      expect(server.store.isMember(leads, person.id)).toBe(false);
    }
  });
});

describe("group conversations", () => {
  const startGroup = (by: Person, others: Person[]) =>
    request("/api/channels", by.token, "POST", {
      type: "group_dm",
      memberIds: others.map((o) => o.id),
    });

  it("returns the same group to anyone starting one with the same people", async () => {
    const first = await startGroup(owner, [ana, ben]);
    expect(first.status).toBe(201);
    const again = await startGroup(ben, [owner, ana]);
    expect(again.status).toBe(200);
    expect(again.data.channel.id).toBe(first.data.channel.id);
  });

  it("lets someone leave a group, telling the others who is left", async () => {
    const group = (await startGroup(owner, [ana, ben])).data.channel;
    await post(group.id, owner, "Before Ben left");
    const anaSocket = await connect(ana);
    const benSocket = await connect(ben);
    benSocket.ws.send(JSON.stringify({ type: "huddle.join", channelId: group.id }));
    await expect.poll(() => server.gateway.huddleParticipants(group.id)).toEqual([ben.id]);

    expect((await request(`/api/channels/${group.id}/leave`, ben.token)).status).toBe(200);
    await benSocket.heard(lostAccess(group.id));
    await anaSocket.heard(left(group.id, ben.id));
    // The group's own member list changes too, so its name is right everywhere.
    await anaSocket.heard(
      (f) =>
        f.type === "event" &&
        f.envelope.event.type === "channel.updated" &&
        f.envelope.event.channel.id === group.id &&
        [...(f.envelope.event.channel.memberIds ?? [])].sort().join() ===
          [owner.id, ana.id].sort().join(),
    );
    expect(server.gateway.huddleParticipants(group.id)).toEqual([]);
    expect((await history(group.id, ben)).status).toBe(404);
  });

  it("starts a new group when the same people start again after someone left, without the old history", async () => {
    const group = (await startGroup(owner, [ana, ben])).data.channel;
    await post(group.id, owner, "Said after Ben left");
    await request(`/api/channels/${group.id}/leave`, ben.token);
    await post(group.id, ana, "Also after Ben left");

    const restarted = await startGroup(owner, [ana, ben]);
    expect(restarted.status).toBe(201);
    expect(restarted.data.channel.id).not.toBe(group.id);
    expect(restarted.data.channel.type).toBe("group_dm");
    const seen = await history(restarted.data.channel.id, ben);
    expect(seen.status).toBe(200);
    expect(seen.data.messages).toEqual([]);
    expect((await history(group.id, ben)).status).toBe(404);
    // The ones who stayed still have the old group, and its history.
    expect(
      (await history(group.id, ana)).data.messages.map((m: { text: string }) => m.text),
    ).toEqual(expect.arrayContaining(["Said after Ben left", "Also after Ben left"]));
  });

  it("cannot be left if it is a direct message, nor have anyone added", async () => {
    const dm = (
      await request("/api/channels", owner.token, "POST", { type: "dm", memberIds: [ana.id] })
    ).data.channel;
    const leave = await request(`/api/channels/${dm.id}/leave`, ana.token);
    expect(leave.status).toBe(400);
    expect(leave.data.error).toBe("cannot_leave_dm");
    const group = (await startGroup(owner, [ana, ben])).data.channel;
    const cara = await register("cara");
    for (const conversation of [dm.id, group.id]) {
      const added = await request(
        `/api/channels/${conversation}/invite-member`,
        owner.token,
        "POST",
        { userId: cara.id },
      );
      expect(added.status).toBe(400);
      expect(added.data.error).toBe("cannot_invite_to_dm");
    }
  });
});
