import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient, type ThreadFollow } from "@slackoss/protocol";
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

const post = async (text: string, auth: string, threadRootId?: string) =>
  (
    await request(
      `/api/channels/${channelId}/messages`,
      { text, nonce: `${text}-${auth.slice(0, 6)}`, threadRootId },
      "POST",
      auth,
    )
  ).body.message;

const register = async (handle: string) => {
  const res = await request("/api/auth/register", {
    handle,
    displayName: handle,
    password: "password123",
  });
  return { token: res.body.token as string, id: res.body.user.id as string };
};

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
  peer = await register("peer");
  channelId = server.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.stop();
});

describe("thread following", () => {
  it("follows a thread for the replier and the root's author, and counts only what is unseen", async () => {
    const root = await post("Anyone looked at this?", owner.token);
    const reply = await post("I have", peer.token, root.id);

    // The reply's author wrote it, so nothing is unread for them.
    const peerList = (await request("/api/threads/followed", undefined, "GET", peer.token)).body;
    expect(peerList.threads).toHaveLength(1);
    expect(peerList.threads[0].root.id).toBe(root.id);
    expect(peerList.threads[0].unreadCount).toBe(0);
    expect(peerList.threads[0].lastSeq).toBe(reply.seq);

    // The root's author has one reply waiting.
    const ownerList = (await request("/api/threads/followed", undefined, "GET")).body;
    expect(ownerList.threads[0].unreadCount).toBe(1);

    const read = await request(`/api/messages/${root.id}/thread/read`, { seq: reply.seq });
    expect(read.body.state.lastReadSeq).toBe(reply.seq);
    expect(
      (await request("/api/threads/followed", undefined, "GET")).body.threads[0].unreadCount,
    ).toBe(0);
  });

  it("keeps an explicit unfollow when someone else replies, but not when you reply yourself", async () => {
    const root = await post("Long thread", owner.token);
    await post("First", peer.token, root.id);
    expect(
      (await request(`/api/messages/${root.id}/follow`, { following: false }, "PUT")).status,
    ).toBe(200);

    await post("Second", peer.token, root.id);
    expect((await request("/api/threads/followed", undefined, "GET")).body.threads).toHaveLength(0);

    // Writing in it is a clear statement of interest, so it follows again.
    await post("Back in", owner.token, root.id);
    expect((await request("/api/threads/followed", undefined, "GET")).body.threads).toHaveLength(1);
  });

  it("starts a newly followed thread caught up rather than showing its whole history as unread", async () => {
    const root = await post("Old thread", peer.token);
    await post("One", peer.token, root.id);
    const second = await post("Two", peer.token, `${root.id}`);

    const followed = await request(`/api/messages/${root.id}/follow`, { following: true }, "PUT");
    expect(followed.body.state.lastReadSeq).toBe(second.seq);
    expect(
      (await request("/api/threads/followed", undefined, "GET")).body.threads[0].unreadCount,
    ).toBe(0);
  });

  it("clamps a read cursor to what exists so a future seq cannot hide later replies", async () => {
    const root = await post("Clamp me", owner.token);
    const reply = await post("Reply", peer.token, root.id);

    const ahead = await request(`/api/messages/${root.id}/thread/read`, { seq: reply.seq + 5_000 });
    expect(ahead.body.state.lastReadSeq).toBe(reply.seq);

    const later = await post("Later reply", peer.token, root.id);
    const list = (await request("/api/threads/followed", undefined, "GET")).body;
    expect(list.threads[0].unreadCount).toBe(1);
    expect(list.threads[0].lastSeq).toBe(later.seq);
  });

  it("never moves a read cursor backwards", async () => {
    const root = await post("Backwards", owner.token);
    const reply = await post("Reply", peer.token, root.id);
    await request(`/api/messages/${root.id}/thread/read`, { seq: reply.seq });
    const stale = await request(`/api/messages/${root.id}/thread/read`, { seq: 1 });
    expect(stale.body.state.lastReadSeq).toBe(reply.seq);
  });

  it("tells every follower's own devices about a new reply", async () => {
    const root = await post("Fan out", owner.token);
    await post("Joining in", peer.token, root.id);

    const ownerSocket = await connect(owner.token);
    const peerSocket = await connect(peer.token);
    const third = await register("third");
    const thirdSocket = await connect(third.token);

    const reply = await post("Another", peer.token, root.id);

    await expect.poll(() => followFrames(ownerSocket.frames).at(-1)?.lastSeq).toBe(reply.seq);
    await expect.poll(() => followFrames(peerSocket.frames).at(-1)?.lastSeq).toBe(reply.seq);
    // Someone who has never touched the thread does not follow it, so says nothing.
    expect(followFrames(thirdSocket.frames)).toHaveLength(0);
  });

  it("carries follow state through the handshake snapshot", async () => {
    const root = await post("Snapshot", owner.token);
    const reply = await post("Reply", peer.token, root.id);
    const { frames } = await connect(owner.token);
    const ready = frames.find((f) => f.type === "ready");
    const follow = (ready as any).threadFollows.find((f: ThreadFollow) => f.rootId === root.id);
    expect(follow).toMatchObject({ following: true, channelId, lastSeq: reply.seq });
    expect(follow.lastReadSeq).toBeLessThan(reply.seq);
  });

  it("pages newest activity first with a stable cursor and an unread-only filter", async () => {
    const roots = [];
    for (let i = 0; i < 5; i++) {
      const root = await post(`Root ${i}`, owner.token);
      await post(`Reply ${i}`, peer.token, root.id);
      roots.push(root);
    }
    // Read the two most recent, leaving three unread.
    for (const root of roots.slice(3)) {
      const state = await request(`/api/messages/${root.id}/thread/read`, { seq: 1_000_000 });
      expect(state.status).toBe(200);
    }

    const first = (await request("/api/threads/followed?limit=2", undefined, "GET")).body;
    expect(first.threads.map((t: any) => t.root.id)).toEqual([roots[4]!.id, roots[3]!.id]);
    expect(first.nextCursor).toBeTruthy();

    const second = (
      await request(
        `/api/threads/followed?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
        undefined,
        "GET",
      )
    ).body;
    expect(second.threads.map((t: any) => t.root.id)).toEqual([roots[2]!.id, roots[1]!.id]);

    const unread = (await request("/api/threads/followed?unreadOnly=true", undefined, "GET")).body;
    expect(unread.threads.map((t: any) => t.root.id)).toEqual([
      roots[2]!.id,
      roots[1]!.id,
      roots[0]!.id,
    ]);
  });

  it("lists unread replies in followed threads, newest first, as Activity's threads mode", async () => {
    const followed = await post("Ship it Friday?", owner.token);
    const elsewhere = await post("Lunch plans", peer.token);
    const first = await post("Friday works", peer.token, followed.id);
    const second = await post("Or Monday", peer.token, followed.id);
    // Not a reply, and a reply in a thread the owner does not follow.
    await post("Build is green", peer.token);
    await post("Tacos", peer.token, elsewhere.id);

    const threads = async () =>
      ((await request("/api/activity?mode=threads", undefined, "GET")).body.messages as any[]).map(
        (message) => message.id,
      );
    expect(await threads()).toEqual([second.id, first.id]);

    // Read, the thread leaves the list.
    await request(`/api/messages/${followed.id}/thread/read`, { seq: second.seq });
    expect(await threads()).toEqual([]);

    // The ready snapshot says this server answers the mode.
    const { frames } = await connect(owner.token);
    expect((frames.find((f) => f.type === "ready") as any).activityThreads).toBe(true);
  });

  it("drops a thread from the list when its root is deleted", async () => {
    const root = await post("Doomed", owner.token);
    await post("Reply", peer.token, root.id);
    expect((await request("/api/threads/followed", undefined, "GET")).body.threads).toHaveLength(1);

    await request(`/api/messages/${root.id}`, undefined, "DELETE");
    expect((await request("/api/threads/followed", undefined, "GET")).body.threads).toHaveLength(0);
    const { frames } = await connect(owner.token);
    expect((frames.find((f) => f.type === "ready") as any).threadFollows).toHaveLength(0);
  });

  it("hides threads in a private channel from someone who has lost access", async () => {
    const priv = (
      await request("/api/channels", { type: "private", name: "secret", memberIds: [peer.id] })
    ).body.channel;
    const root = (
      await request(`/api/channels/${priv.id}/messages`, { text: "Private root", nonce: "pr" })
    ).body.message;
    await request(
      `/api/channels/${priv.id}/messages`,
      { text: "Private reply", nonce: "pr2" },
      "POST",
      peer.token,
    );
    await request(`/api/messages/${root.id}/follow`, { following: true }, "PUT", peer.token);
    expect(
      (await request("/api/threads/followed", undefined, "GET", peer.token)).body.threads,
    ).toHaveLength(1);

    expect(
      (await request(`/api/channels/${priv.id}/leave`, undefined, "POST", peer.token)).status,
    ).toBe(200);
    expect(
      (await request("/api/threads/followed", undefined, "GET", peer.token)).body.threads,
    ).toHaveLength(0);
  });

  it("leaves a reply and everything after it unread, and follows the thread doing it", async () => {
    const root = await post("Come back to this", peer.token);
    const first = await post("One", peer.token, root.id);
    const second = await post("Two", peer.token, root.id);

    // Owner did not write the root and has not replied, so does not follow yet.
    expect((await request("/api/threads/followed", undefined, "GET")).body.threads).toHaveLength(0);

    const marked = await request(`/api/messages/${root.id}/thread/unread`, { seq: first.seq });
    expect(marked.body.state.following).toBe(true);
    expect(marked.body.state.lastReadSeq).toBe(first.seq - 1);

    const list = (await request("/api/threads/followed", undefined, "GET")).body;
    expect(list.threads[0].unreadCount).toBe(2);
    expect(list.threads[0].lastSeq).toBe(second.seq);
  });

  it("counts a reply you wrote yourself when you deliberately mark it unread", async () => {
    const root = await post("Mine", owner.token);
    const mine = await post("A note to self", owner.token, root.id);
    expect(
      (await request("/api/threads/followed", undefined, "GET")).body.threads[0].unreadCount,
    ).toBe(0);

    await request(`/api/messages/${root.id}/thread/unread`, { seq: mine.seq });
    expect(
      (await request("/api/threads/followed", undefined, "GET")).body.threads[0].unreadCount,
    ).toBe(1);
  });

  it("rejects a future thread unread position without hiding a later reply", async () => {
    const root = await post("Thread position", peer.token);
    const first = await post("First reply", peer.token, root.id);
    const follow = await request(
      "/api/messages/" + root.id + "/follow",
      { following: true },
      "PUT",
    );
    expect(follow.body.state.lastReadSeq).toBe(first.seq);

    const future = server.store.currentSeq() + 1_000_000;
    expect(
      (await request("/api/messages/" + root.id + "/thread/unread", { seq: future })).status,
    ).toBe(400);

    await post("Later reply", peer.token, root.id);
    const unread = await request("/api/threads/followed?unreadOnly=true", undefined, "GET");
    expect(unread.body.threads).toEqual([
      expect.objectContaining({ root: expect.objectContaining({ id: root.id }), unreadCount: 1 }),
    ]);
  });

  it("rejects another thread, a deleted reply, and a non-message seq without changing the follow", async () => {
    const root = await post("Scoped thread", peer.token);
    const first = await post("First scoped reply", peer.token, root.id);
    await request("/api/messages/" + root.id + "/follow", { following: true }, "PUT");
    const otherRoot = await post("Other thread", peer.token);
    const otherReply = await post("Other reply", peer.token, otherRoot.id);
    const deleted = await post("Deleted scoped reply", peer.token, root.id);
    expect(
      (await request("/api/messages/" + deleted.id, undefined, "DELETE", peer.token)).status,
    ).toBe(200);
    const nonMessageSeq = server.store.currentSeq();
    const sendToUser = vi.spyOn(server.gateway, "sendToUser");

    for (const seq of [otherReply.seq, deleted.seq, nonMessageSeq]) {
      expect((await request("/api/messages/" + root.id + "/thread/unread", { seq })).status).toBe(
        400,
      );
    }
    expect(
      sendToUser.mock.calls.some(
        ([userId, event]) => userId === owner.id && event.type === "thread.follow",
      ),
    ).toBe(false);
    sendToUser.mockRestore();
    const state = server.store.threadFollow(owner.id, root.id);
    expect(state?.lastReadSeq).toBe(first.seq);
    expect(state?.following).toBe(true);
  });

  it("marks a whole thread unread from its live root and keeps repeated requests harmless", async () => {
    const root = await post("Read the whole thread", peer.token);
    await post("First reply to revisit", peer.token, root.id);
    const second = await post("Second reply to revisit", peer.token, root.id);
    await request("/api/messages/" + root.id + "/follow", { following: true }, "PUT");

    for (let attempt = 0; attempt < 2; attempt++) {
      const marked = await request("/api/messages/" + root.id + "/thread/unread", {
        seq: root.seq,
      });
      expect(marked.status).toBe(200);
      expect(marked.body.state.lastReadSeq).toBe(root.seq - 1);
      expect(marked.body.state.lastSeq).toBe(second.seq);
    }
    const followed = await request("/api/threads/followed?unreadOnly=true", undefined, "GET");
    expect(followed.body.threads).toEqual([
      expect.objectContaining({ root: expect.objectContaining({ id: root.id }), unreadCount: 2 }),
    ]);
  });

  it("marks a channel unread from one message and reads forward again afterwards", async () => {
    const first = await post("First", peer.token);
    const second = await post("Second", peer.token);
    await request(`/api/channels/${channelId}/read`, { seq: second.seq });

    const marked = await request(`/api/channels/${channelId}/unread`, { seq: second.seq });
    expect(marked.body.seq).toBe(second.seq - 1);
    expect(marked.body.seq).toBeGreaterThanOrEqual(first.seq);

    // Reading still advances from there, so returning to the channel clears it.
    const read = await request(`/api/channels/${channelId}/read`, { seq: second.seq });
    expect(read.body.seq).toBe(second.seq);
  });

  it("rejects a future channel unread position without hiding a later message", async () => {
    const first = await post("Read before forged position", peer.token);
    await request("/api/channels/" + channelId + "/read", { seq: first.seq });

    const future = server.store.currentSeq() + 1_000_000;
    expect((await request("/api/channels/" + channelId + "/unread", { seq: future })).status).toBe(
      400,
    );

    const later = await post("Still unread after forged position", peer.token);
    const activity = await request("/api/activity?mode=unread", undefined, "GET");
    expect(activity.body.messages.map((message: { id: string }) => message.id)).toContain(later.id);
  });

  it("rejects channel unread targets from another channel, deleted messages, and non-message events", async () => {
    const first = await post("Keep this read position", peer.token);
    await request("/api/channels/" + channelId + "/read", { seq: first.seq });
    const other = (await request("/api/channels", { type: "public", name: "another-room" })).body
      .channel;
    const nonMessageSeq = server.store.currentSeq();
    const otherMessage = (
      await request("/api/channels/" + other.id + "/messages", {
        text: "Another channel",
        nonce: "other-channel-seq",
      })
    ).body.message;
    const deleted = await post("Deleted channel target", owner.token);
    expect((await request("/api/messages/" + deleted.id, undefined, "DELETE")).status).toBe(200);
    const sendToUser = vi.spyOn(server.gateway, "sendToUser");

    for (const seq of [otherMessage.seq, deleted.seq, nonMessageSeq]) {
      expect((await request("/api/channels/" + channelId + "/unread", { seq })).status).toBe(400);
    }
    expect(
      sendToUser.mock.calls.some(
        ([userId, event]) => userId === owner.id && event.type === "channel.unread",
      ),
    ).toBe(false);
    sendToUser.mockRestore();
    const membership = server.store
      .memberships(owner.id)
      .find((item) => item.channelId === channelId);
    expect(membership?.lastReadSeq).toBe(first.seq);
  });

  it("tells the marking account's own devices, and only them", async () => {
    const message = await post("Notice me", peer.token);
    const ownerSocket = await connect(owner.token);
    const peerSocket = await connect(peer.token);

    await request(`/api/channels/${channelId}/unread`, { seq: message.seq });

    const unreadFrames = (frames: ServerToClient[]) =>
      frames.flatMap((f) =>
        f.type === "ephemeral" && f.event.type === "channel.unread" ? [f.event] : [],
      );
    await expect.poll(() => unreadFrames(ownerSocket.frames).at(-1)?.seq).toBe(message.seq - 1);
    expect(unreadFrames(peerSocket.frames)).toHaveLength(0);
  });

  it("refuses to mark unread outside a channel you are in, or with a meaningless seq", async () => {
    const root = await post("Root", owner.token);
    const priv = (
      await request("/api/channels", { type: "private", name: "closed", memberIds: [] })
    ).body.channel;
    expect(
      (await request(`/api/channels/${priv.id}/unread`, { seq: 2 }, "POST", peer.token)).status,
    ).toBe(404);
    // Nothing precedes seq 0, so there is no message it could leave unread.
    expect((await request(`/api/channels/${channelId}/unread`, { seq: 0 })).status).toBe(400);
    expect((await request(`/api/messages/${root.id}/thread/unread`, { seq: 0 })).status).toBe(400);
  });

  it("shows a reply sent to the channel in its timeline while it stays a reply", async () => {
    const root = await post("Deploy plan", owner.token);
    const quiet = (
      await request(
        `/api/channels/${channelId}/messages`,
        { text: "Only in the thread", nonce: "quiet", threadRootId: root.id },
        "POST",
        peer.token,
      )
    ).body.message;
    const loud = (
      await request(
        `/api/channels/${channelId}/messages`,
        {
          text: "Everyone should see this",
          nonce: "loud",
          threadRootId: root.id,
          alsoSendToChannel: true,
        },
        "POST",
        peer.token,
      )
    ).body.message;

    expect(loud.broadcast).toBe(true);
    expect(quiet.broadcast).toBe(false);
    // It is still a reply: it belongs to the thread and counts toward it.
    expect(loud.threadRootId).toBe(root.id);

    const timeline = (
      await request(`/api/channels/${channelId}/messages?limit=50`, undefined, "GET")
    ).body;
    const ids = timeline.messages.map((m: any) => m.id);
    expect(ids).toContain(loud.id);
    expect(ids).not.toContain(quiet.id);
    const markedChannel = await request("/api/channels/" + channelId + "/unread", {
      seq: loud.seq,
    });
    expect(markedChannel.status).toBe(200);
    expect(markedChannel.body.seq).toBe(loud.seq - 1);
    expect(
      (await request("/api/channels/" + channelId + "/unread", { seq: quiet.seq })).status,
    ).toBe(400);
    const markedThread = await request("/api/messages/" + root.id + "/thread/unread", {
      seq: loud.seq,
    });
    expect(markedThread.status).toBe(200);
    expect(markedThread.body.state.lastReadSeq).toBe(loud.seq - 1);

    const thread = (
      await request(`/api/channels/${channelId}/threads/${root.id}`, undefined, "GET")
    ).body;
    expect(thread.messages.map((m: any) => m.id)).toEqual(
      expect.arrayContaining([quiet.id, loud.id]),
    );
    expect(
      (
        await request(`/api/channels/${channelId}/messages?limit=50`, undefined, "GET")
      ).body.messages.find((m: any) => m.id === root.id).replyCount,
    ).toBe(2);
  });

  it("ignores the channel copy request on a message that is not a reply", async () => {
    const top = (
      await request(`/api/channels/${channelId}/messages`, {
        text: "Top level",
        nonce: "top",
        alsoSendToChannel: true,
      })
    ).body.message;
    expect(top.broadcast).toBe(false);
  });

  it("treats a retry that changes where the reply appears as a different request", async () => {
    const root = await post("Root", owner.token);
    const body = { text: "Same words", nonce: "shared-key", threadRootId: root.id };
    const first = (await request(`/api/channels/${channelId}/messages`, body, "POST", peer.token))
      .body.message;

    // The identical request settles onto the same message.
    const repeat = await request(`/api/channels/${channelId}/messages`, body, "POST", peer.token);
    expect(repeat.body.message.id).toBe(first.id);

    // Asking for it in the channel too is a different request under one key.
    const changed = await request(
      `/api/channels/${channelId}/messages`,
      { ...body, alsoSendToChannel: true },
      "POST",
      peer.token,
    );
    expect(changed.status).toBe(409);
  });

  it("keeps a channel-copied reply out of the timeline once it is deleted", async () => {
    const root = await post("Root", owner.token);
    const loud = (
      await request(`/api/channels/${channelId}/messages`, {
        text: "Broadcast me",
        nonce: "b",
        threadRootId: root.id,
        alsoSendToChannel: true,
      })
    ).body.message;
    await request(`/api/messages/${loud.id}`, undefined, "DELETE");
    const ids = (
      await request(`/api/channels/${channelId}/messages?limit=50`, undefined, "GET")
    ).body.messages.map((m: any) => m.id);
    expect(ids).not.toContain(loud.id);
  });

  it("counts unread mentions per conversation and clears them on reading", async () => {
    const mentionFrames = (frames: ServerToClient[]) =>
      frames.flatMap((f) =>
        f.type === "ephemeral" && f.event.type === "mentions" ? [f.event.counts] : [],
      );
    const socket = await connect(owner.token);

    await post("Nothing to do with anyone", peer.token);
    await request(
      `/api/channels/${channelId}/messages`,
      { text: `morning <@${owner.id}>`, nonce: "m1" },
      "POST",
      peer.token,
    );
    const second = (
      await request(
        `/api/channels/${channelId}/messages`,
        { text: `and again <@${owner.id}>`, nonce: "m2" },
        "POST",
        peer.token,
      )
    ).body.message;

    // Only the named account is told, and the plain message did not count.
    await expect.poll(() => mentionFrames(socket.frames).at(-1)?.[channelId]).toBe(2);
    expect(server.store.unreadMentionCounts(peer.id)[channelId] ?? 0).toBe(0);

    await request(`/api/channels/${channelId}/read`, { seq: second.seq });
    await expect.poll(() => mentionFrames(socket.frames).at(-1)?.[channelId] ?? 0).toBe(0);

    // Marking it unread again brings the mentions back with it.
    await request(`/api/channels/${channelId}/unread`, { seq: second.seq });
    await expect.poll(() => mentionFrames(socket.frames).at(-1)?.[channelId]).toBe(1);
  });

  it("counts a room-wide mention in a channel but not the same words in a DM", async () => {
    await request(
      `/api/channels/${channelId}/messages`,
      { text: "deploying now <!channel>", nonce: "rw" },
      "POST",
      peer.token,
    );
    expect(server.store.unreadMentionCounts(owner.id)[channelId]).toBe(1);

    const dm = (
      await request("/api/channels", { type: "dm", memberIds: [owner.id] }, "POST", peer.token)
    ).body.channel;
    await request(
      `/api/channels/${dm.id}/messages`,
      { text: "shipping <!here>", nonce: "dm" },
      "POST",
      peer.token,
    );
    // In a direct message there is no room to address, so it is just words.
    expect(server.store.unreadMentionCounts(owner.id)[dm.id] ?? 0).toBe(0);
  });

  it("drops a mention from the count when the message is deleted", async () => {
    const mention = (
      await request(
        `/api/channels/${channelId}/messages`,
        { text: `look <@${owner.id}>`, nonce: "d1" },
        "POST",
        peer.token,
      )
    ).body.message;
    expect(server.store.unreadMentionCounts(owner.id)[channelId]).toBe(1);

    await request(`/api/messages/${mention.id}`, undefined, "DELETE", peer.token);
    expect(server.store.unreadMentionCounts(owner.id)[channelId] ?? 0).toBe(0);
  });

  it("carries mention counts through the handshake snapshot", async () => {
    await request(
      `/api/channels/${channelId}/messages`,
      { text: `hello <@${owner.id}>`, nonce: "snap" },
      "POST",
      peer.token,
    );
    const { frames } = await connect(owner.token);
    const ready = frames.find((f) => f.type === "ready") as any;
    expect(ready.mentionCounts[channelId]).toBe(1);
  });

  it("refuses to follow a reply, an unreachable message, or a malformed cursor", async () => {
    const root = await post("Root", owner.token);
    const reply = await post("Reply", peer.token, root.id);
    expect(
      (await request(`/api/messages/${reply.id}/follow`, { following: true }, "PUT")).status,
    ).toBe(400);
    expect((await request("/api/messages/nope/follow", { following: true }, "PUT")).status).toBe(
      404,
    );
    expect((await request("/api/messages/nope/thread/unread", { seq: reply.seq })).status).toBe(
      404,
    );
    expect((await request(`/api/messages/${root.id}/follow`, {}, "PUT")).status).toBe(400);
    expect((await request(`/api/messages/${root.id}/thread/read`, { seq: -1 })).status).toBe(400);
    expect((await request("/api/threads/followed?cursor=nonsense", undefined, "GET")).status).toBe(
      400,
    );
    expect((await request("/api/threads/followed?limit=0", undefined, "GET")).status).toBe(400);
  });
});

describe("reading a thread", () => {
  /** Root, then an unseen channel mention, then a reply that also mentions. */
  async function rootMentionReply() {
    const root = await post("Plans for Friday", peer.token);
    await request(`/api/channels/${channelId}/read`, { seq: root.seq });
    const mention = (
      await request(
        `/api/channels/${channelId}/messages`,
        { text: `can you look at this <@${owner.id}>`, nonce: "top" },
        "POST",
        peer.token,
      )
    ).body.message;
    const reply = (
      await request(
        `/api/channels/${channelId}/messages`,
        { text: `and this one <@${owner.id}>`, nonce: "reply", threadRootId: root.id },
        "POST",
        peer.token,
      )
    ).body.message;
    expect([root.seq < mention.seq, mention.seq < reply.seq]).toEqual([true, true]);
    return { root, mention, reply };
  }

  const ready = async () =>
    (await connect(owner.token)).frames.find((f) => f.type === "ready") as any;
  const cursor = (snapshot: any) =>
    snapshot.memberships.find((m: any) => m.channelId === channelId).lastReadSeq;
  const unreadActivity = async () =>
    ((await request("/api/activity?mode=unread", undefined, "GET")).body.messages as any[]).map(
      (m) => m.id,
    );

  it("reads only the thread, leaving an unseen channel mention unread", async () => {
    const { root, mention, reply } = await rootMentionReply();
    expect(server.store.unreadMentionCounts(owner.id)[channelId]).toBe(2);

    const read = await request(`/api/messages/${root.id}/thread/read`, { seq: reply.seq });
    expect(read.status).toBe(200);
    // Reading a thread you do not follow keeps its cursor without following it.
    expect(read.body.state).toMatchObject({ following: false, lastReadSeq: reply.seq });

    const snapshot = await ready();
    expect(cursor(snapshot)).toBe(root.seq);
    expect(snapshot.mentionCounts[channelId]).toBe(1);
    expect(await unreadActivity()).toEqual([mention.id]);
    // Not following it, the thread is not one of yours with anything new.
    expect(snapshot.threadFollows).toEqual([
      expect.objectContaining({ rootId: root.id, following: false, lastReadSeq: reply.seq }),
    ]);
  });

  it("tells the reader's devices the mention count once the thread is read", async () => {
    const { root, reply } = await rootMentionReply();
    const socket = await connect(owner.token);
    await request(`/api/messages/${root.id}/thread/read`, { seq: reply.seq });
    await expect
      .poll(
        () =>
          socket.frames
            .flatMap((f) =>
              f.type === "ephemeral" && f.event.type === "mentions" ? [f.event.counts] : [],
            )
            .at(-1)?.[channelId],
      )
      .toBe(1);
  });

  it("counts a reply toward the channel's newest message only when it is also sent there", async () => {
    const { mention, reply } = await rootMentionReply();
    expect((await ready()).channelLastSeq[channelId]).toBe(mention.seq);
    expect(reply.seq).toBeGreaterThan(mention.seq);

    const copied = (
      await request(
        `/api/channels/${channelId}/messages`,
        {
          text: "for everyone",
          nonce: "copied",
          threadRootId: reply.threadRootId,
          alsoSendToChannel: true,
        },
        "POST",
        peer.token,
      )
    ).body.message;
    expect((await ready()).channelLastSeq[channelId]).toBe(copied.seq);
  });

  it("leaves a reply unread when the channel is read past it, until its thread is read", async () => {
    const { root, mention, reply } = await rootMentionReply();
    const later = await post("Later in the channel", peer.token);
    await request(`/api/channels/${channelId}/read`, { seq: later.seq });
    // The channel never showed the reply, so reading it read the mention above only.
    expect(server.store.unreadMentionCounts(owner.id)[channelId]).toBe(1);
    expect(await unreadActivity()).toEqual([reply.id]);
    expect([mention.seq, reply.seq].every((seq) => seq < later.seq)).toBe(true);

    await request(`/api/messages/${root.id}/thread/read`, { seq: reply.seq });
    expect(server.store.unreadMentionCounts(owner.id)[channelId] ?? 0).toBe(0);
    expect(await unreadActivity()).toEqual([]);
  });
});

describe("one read rule for a channel and its threads", () => {
  const unread = async (auth = owner.token) =>
    ((await request("/api/activity?mode=unread", undefined, "GET", auth)).body.messages as any[])
      .map((m) => m.text)
      .sort();
  const followed = async () =>
    ((await request("/api/threads/followed", undefined, "GET")).body.threads as any[]).map((t) => ({
      root: t.root.text,
      unread: t.unreadCount,
    }));
  const readChannel = (seq: number, auth = owner.token) =>
    request(`/api/channels/${channelId}/read`, { seq }, "POST", auth);
  const copy = async (text: string, rootId: string) =>
    (
      await request(
        `/api/channels/${channelId}/messages`,
        { text, nonce: text, threadRootId: rootId, alsoSendToChannel: true },
        "POST",
        peer.token,
      )
    ).body.message;

  it("counts a reply the same in Activity, mentions and Threads when the channel is read past it", async () => {
    // The reproduction: the owner's own thread, a reply naming them, then the
    // channel read past it. Activity and the mention badge used to call the
    // reply read while Threads still counted it.
    const root = await post("Owner's question", owner.token);
    await post(`over to you <@${owner.id}>`, peer.token, root.id);
    const later = await post("Meanwhile in the channel", peer.token);
    await readChannel(later.seq);

    expect(await unread()).toEqual([`over to you <@${owner.id}>`]);
    expect(server.store.unreadMentionCounts(owner.id)[channelId]).toBe(1);
    expect(await followed()).toEqual([{ root: "Owner's question", unread: 1 }]);
    expect(server.store.unreadThreadCount(owner.id)).toBe(1);
  });

  it("reads a reply also sent to the channel there, and in its thread as far as nothing comes first", async () => {
    const root = await post("Release notes", owner.token);
    const first = await copy("shipped", root.id);
    const socket = await connect(owner.token);
    await readChannel(first.seq);
    expect(await unread()).toEqual([]);
    expect(await followed()).toEqual([{ root: "Release notes", unread: 0 }]);
    // The owner's other devices hear that the thread moved on.
    await expect
      .poll(() => followFrames(socket.frames).at(-1))
      .toMatchObject({ rootId: root.id, lastReadSeq: first.seq });

    // A reply only in the thread, then another sent to the channel.
    await post("only here", peer.token, root.id);
    const third = await copy("and everywhere", root.id);
    await readChannel(third.seq);
    // The one shown in the channel is read; the one before it is not.
    expect(await unread()).toEqual(["only here"]);
    expect(await followed()).toEqual([{ root: "Release notes", unread: 1 }]);
    expect(server.store.threadFollow(owner.id, root.id)!.lastReadSeq).toBe(first.seq);
  });

  it("lists replies in Activity only from threads followed, and any that name you", async () => {
    const root = await post("Someone else's thread", peer.token);
    await readChannel(root.seq);
    await post("chatter", peer.token, root.id);
    await post(`a question for <@${owner.id}>`, peer.token, root.id);
    expect(await unread()).toEqual([`a question for <@${owner.id}>`]);
    expect(server.store.unreadMentionCounts(owner.id)[channelId]).toBe(1);

    // Opening the thread reads both.
    const last = server.store.threadFollow(owner.id, root.id)!;
    await request(`/api/messages/${root.id}/thread/read`, { seq: 1e9 });
    expect(await unread()).toEqual([]);
    expect(server.store.unreadMentionCounts(owner.id)[channelId] ?? 0).toBe(0);
    expect(last.following).toBe(false);
  });

  it("keeps a thread marked unread unread when the channel is read past it", async () => {
    const root = await post("Come back to this", owner.token);
    const reply = await post("the details", peer.token, root.id);
    await request(`/api/messages/${root.id}/thread/read`, { seq: reply.seq });
    await request(`/api/messages/${root.id}/thread/unread`, { seq: reply.seq });
    const later = await post("unrelated", peer.token);
    await readChannel(later.seq);
    expect(await unread()).toEqual(["the details"]);
    expect(await followed()).toEqual([{ root: "Come back to this", unread: 1 }]);
  });

  it("leaves what was read as it was when an untouched thread is unfollowed", async () => {
    const root = await post("Noisy", peer.token);
    await post("<!here> from before", peer.token, root.id);
    const newcomer = await register("newcomer");
    await readChannel(server.store.currentSeq(), newcomer.token);
    const off = await request(
      `/api/messages/${root.id}/follow`,
      { following: false },
      "PUT",
      newcomer.token,
    );
    expect(off.body.state).toMatchObject({ following: false });
    // What came before joining stays read,
    expect(server.store.unreadMentionCounts(newcomer.id)[channelId] ?? 0).toBe(0);
    // and unfollowing is not reading: a later mention still waits.
    await post("<!here> after", peer.token, root.id);
    expect(server.store.unreadMentionCounts(newcomer.id)[channelId]).toBe(1);
    expect(await unread(newcomer.token)).toEqual(["<!here> after"]);
  });

  it("does not hand a new member the replies written before they joined", async () => {
    const root = await post("Before your time", peer.token);
    await post("<!here> old news", peer.token, root.id);
    const newcomer = await register("newcomer");
    // Registration joins #general; reading the channel reads what it shows.
    await readChannel(server.store.currentSeq(), newcomer.token);
    expect(server.store.unreadMentionCounts(newcomer.id)[channelId] ?? 0).toBe(0);
    expect(await unread(newcomer.token)).toEqual([]);

    await post("<!here> new news", peer.token, root.id);
    expect(server.store.unreadMentionCounts(newcomer.id)[channelId]).toBe(1);
    expect(await unread(newcomer.token)).toEqual(["<!here> new news"]);
  });

  it("gives each membership's replies floor in the handshake and access events", async () => {
    const snapshot = (await connect(owner.token)).frames.find((f) => f.type === "ready") as any;
    const general = snapshot.memberships.find((m: any) => m.channelId === channelId);
    expect(general.repliesReadSeq).toEqual(expect.any(Number));
    expect(general.repliesReadSeq).toBeLessThanOrEqual(snapshot.seq);
  });
});
