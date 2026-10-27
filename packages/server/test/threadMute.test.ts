import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient, type ThreadFollow } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

let server: WorkspaceServer;
let base: string;
let owner: { token: string; id: string };
let peer: { token: string; id: string };
let channelId: string;
const sockets: WebSocket[] = [];

async function request(path: string, body?: unknown, method = "POST", auth = owner.token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${auth}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function connect(auth: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerToClient));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        type: "hello",
        token: auth,
        lastSeq: null,
        protocolVersion: PROTOCOL_VERSION,
      }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  return { ws, frames };
}

/** Follow updates this socket has been told about, newest last. */
const followFrames = (frames: ServerToClient[]): ThreadFollow[] =>
  frames.flatMap((f) =>
    f.type === "ephemeral" && f.event.type === "thread.follow" ? [f.event.state] : [],
  );

let nonce = 0;
const post = async (text: string, auth: string, threadRootId?: string) =>
  (
    await request(
      `/api/channels/${channelId}/messages`,
      { text, nonce: `n-${++nonce}`, threadRootId },
      "POST",
      auth,
    )
  ).body.message;

const mute = (rootId: string, muted: boolean, auth = owner.token) =>
  request(`/api/messages/${rootId}/mute`, { muted }, "PUT", auth);

const followed = async () =>
  ((await request("/api/threads/followed", undefined, "GET")).body.threads as any[]).map(
    (thread) => thread.root.id,
  );

const activity = async (mode: "unread" | "threads") =>
  ((await request(`/api/activity?mode=${mode}`, undefined, "GET")).body.messages as any[]).map(
    (message) => message.text,
  );

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  const first = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
  });
  const created = (await first.json()) as any;
  owner = { token: created.token, id: created.user.id };
  const second = await request("/api/auth/register", {
    handle: "peer",
    displayName: "Peer",
    password: "password123",
  });
  peer = { token: second.body.token, id: second.body.user.id };
  channelId = server.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.stop();
});

describe("muting a thread", () => {
  it("unfollows it without reading it, and tells only the account's own devices", async () => {
    const root = await post("Where should the offsite be?", peer.token);
    await post("Somewhere warm", owner.token, root.id);
    await post("Lisbon", peer.token, root.id);
    const before = server.store.threadFollow(owner.id, root.id)!;
    expect(before.following).toBe(true);
    const ownerSocket = await connect(owner.token);
    const peerSocket = await connect(peer.token);

    const muted = await mute(root.id, true);
    expect(muted.status).toBe(200);
    expect(muted.body.state).toMatchObject({ following: false, muted: true });
    // Muting is not reading: the reply waiting stays unread.
    expect(muted.body.state.lastReadSeq).toBe(before.lastReadSeq);
    expect(await followed()).toEqual([]);
    expect(server.store.unreadThreadCount(owner.id)).toBe(0);

    await expect
      .poll(() => followFrames(ownerSocket.frames).at(-1))
      .toMatchObject({ rootId: root.id, muted: true });
    expect(followFrames(peerSocket.frames).some((state) => state.muted)).toBe(false);
  });

  it("leaves a mention from before the mute unread in a thread never opened", async () => {
    const root = await post("Agenda", peer.token);
    const named = await post(`<@${owner.id}> your item is first`, peer.token, root.id);
    const muted = await mute(root.id, true);
    expect(muted.body.state.lastReadSeq).toBeLessThan(named.seq);
    expect(server.store.unreadMentionCounts(owner.id)[channelId]).toBe(1);
  });

  it("stays unfollowed when the account that muted it replies, caught up to its reply", async () => {
    const root = await post("Standup notes", peer.token);
    await post("First", peer.token, root.id);
    await mute(root.id, true);

    const mine = await post("One thing from me", owner.token, root.id);
    expect(server.store.threadFollow(owner.id, root.id)).toMatchObject({
      following: false,
      muted: true,
      lastReadSeq: mine.seq,
    });
    expect(await followed()).toEqual([]);
  });

  it("keeps the root's author out when someone answers a message they muted", async () => {
    const root = await post("No replies needed", owner.token);
    await mute(root.id, true);

    await post("Replying anyway", peer.token, root.id);
    expect(server.store.threadFollow(owner.id, root.id)).toMatchObject({
      following: false,
      muted: true,
    });
    expect(await followed()).toEqual([]);
  });

  it("leaves its replies out of Activity and Threads, except one that mentions you", async () => {
    const root = await post("Release checklist", peer.token);
    await request(`/api/channels/${channelId}/read`, { seq: root.seq });
    await post("I'll take QA", owner.token, root.id);
    await mute(root.id, true);

    await post("chatter", peer.token, root.id);
    await post(`<@${owner.id}> can you sign off?`, peer.token, root.id);
    expect(await activity("unread")).toEqual([`<@${owner.id}> can you sign off?`]);
    expect(await activity("threads")).toEqual([]);
    expect(server.store.unreadMentionCounts(owner.id)[channelId]).toBe(1);
    expect(server.store.unreadThreadCount(owner.id)).toBe(0);
  });

  it("ends when the thread is followed, and lifting it leaves the thread unfollowed", async () => {
    const root = await post("Budget", peer.token);
    await post("Numbers attached", peer.token, root.id);
    await mute(root.id, true);

    const lifted = await mute(root.id, false);
    expect(lifted.body.state.following).toBe(false);
    expect(lifted.body.state).not.toHaveProperty("muted");

    await mute(root.id, true);
    const following = await request(`/api/messages/${root.id}/follow`, { following: true }, "PUT");
    expect(following.body.state.following).toBe(true);
    expect(following.body.state).not.toHaveProperty("muted");
    // Followed again, a reply from someone else counts.
    await post("Revised", peer.token, root.id);
    expect(server.store.unreadThreadCount(owner.id)).toBe(1);
  });

  it("ends when the thread is marked unread", async () => {
    const root = await post("Hiring plan", peer.token);
    const reply = await post("Two roles", peer.token, root.id);
    await mute(root.id, true);

    const unread = await request(`/api/messages/${root.id}/thread/unread`, { seq: reply.seq });
    expect(unread.body.state.following).toBe(true);
    expect(unread.body.state).not.toHaveProperty("muted");
    expect(await followed()).toEqual([root.id]);
  });

  it("carries a mute through the handshake, which says this server mutes threads", async () => {
    const root = await post("Snapshot", peer.token);
    await post("Reply", peer.token, root.id);
    await mute(root.id, true);

    const { frames } = await connect(owner.token);
    const ready = frames.find((f) => f.type === "ready") as any;
    expect(ready.threadMutes).toBe(true);
    expect(ready.threadFollows.find((f: ThreadFollow) => f.rootId === root.id)).toMatchObject({
      following: false,
      muted: true,
    });
  });

  it("lets a guest mute a thread in a public channel, as a guest may follow one", async () => {
    server.setAccessPolicy("guest_allowed");
    const guest = await request("/api/auth/guest", { displayName: "Visiting Vic" }, "POST", "");
    expect(guest.status).toBe(201);
    const root = await post("Open to visitors", owner.token);
    const muted = await mute(root.id, true, guest.body.token);
    expect(muted.status).toBe(200);
    expect(muted.body.state).toMatchObject({ following: false, muted: true });
  });

  it("refuses a reply, a message the account cannot see, and a body without a choice", async () => {
    const root = await post("Root", owner.token);
    const reply = await post("Reply", peer.token, root.id);
    expect((await mute(reply.id, true)).status).toBe(400);
    expect((await mute("nope", true)).status).toBe(404);
    expect((await request(`/api/messages/${root.id}/mute`, {}, "PUT")).status).toBe(400);

    const secret = (await request("/api/channels", { type: "private", name: "secret" })).body
      .channel;
    const hidden = (
      await request(`/api/channels/${secret.id}/messages`, { text: "Private", nonce: "p" })
    ).body.message;
    expect((await mute(hidden.id, true, peer.token)).status).toBe(404);
    expect(server.store.threadFollow(peer.id, hidden.id)?.muted).toBeUndefined();
  });
});
