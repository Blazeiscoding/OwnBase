import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Marking a thread unread at a reply also sent to the channel, after the
 * channel was read past it (RECHECK-12). The reply is unread again on every
 * surface: the mention count, Activity, the followed-threads list and its
 * badge. It stays so until the thread is read, or the channel is read past
 * where its cursor stood when the thread was marked unread. A quiet reply
 * keeps being read only through its thread (#163).
 */
let server: WorkspaceServer;
let base: string;
let owner: { token: string; id: string };
let reader: { token: string; id: string };
let general: string;

async function call(token: string, path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function register(handle: string) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  const { token, user } = (await response.json()) as { token: string; user: { id: string } };
  return { token, id: user.id };
}

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
  reader = await register("reader");
  general = server.store.channels.byName("general")!.id;
  await call(reader.token, `/api/channels/${general}/join`, "POST");
});

afterEach(async () => {
  await server.stop();
});

const post = async (text: string, extra: Record<string, unknown> = {}) =>
  (await call(owner.token, `/api/channels/${general}/messages`, "POST", { text, ...extra })).body
    .message as { id: string; seq: number };

const readChannel = (seq: number) =>
  call(reader.token, `/api/channels/${general}/read`, "POST", { seq });

/** Everything that says whether the reply is read, as the reader would see it. */
async function surfaces(replyId: string) {
  const activity = await call(reader.token, "/api/activity?mode=unread");
  const followed = await call(reader.token, "/api/threads/followed?unreadOnly=true&limit=30");
  return {
    mentions: server.store.channels.unreadMentionCounts(reader.id)[general] ?? 0,
    inActivity: activity.body.messages.some((m: { id: string }) => m.id === replyId),
    followedUnread: followed.body.threads.length,
    badge: server.store.threads.unreadCount(reader.id),
  };
}
const unread = { mentions: 1, inActivity: true, followedUnread: 1, badge: 1 };
const read = { mentions: 0, inActivity: false, followedUnread: 0, badge: 0 };

/** A thread whose reply, naming the reader, was also sent to the channel, read there. */
async function readInChannel() {
  const root = await post("a question");
  const reply = await post(`<@${reader.id}> the answer, for everyone`, {
    threadRootId: root.id,
    alsoSendToChannel: true,
  });
  await readChannel(reply.seq);
  expect(await surfaces(reply.id)).toEqual({ ...read, badge: 0 });
  return { root, reply };
}

describe("a thread marked unread at a reply already read in the channel", () => {
  it("is unread on every surface, and stays so when the channel is read again", async () => {
    const { root, reply } = await readInChannel();
    const marked = await call(reader.token, `/api/messages/${root.id}/thread/unread`, "POST", {
      seq: reply.seq,
    });
    expect(marked.status).toBe(200);
    // It used to report read everywhere: the channel's cursor read it.
    expect(await surfaces(reply.id)).toEqual(unread);
    expect(marked.body.state).toMatchObject({
      following: true,
      lastReadSeq: reply.seq - 1,
      unreadHold: reply.seq,
    });
    // Reading the channel again, with nothing new in it, does not undo that.
    await readChannel(reply.seq);
    expect(await surfaces(reply.id)).toEqual(unread);
  });

  it("is read again once its thread is read", async () => {
    const { root, reply } = await readInChannel();
    await call(reader.token, `/api/messages/${root.id}/thread/unread`, "POST", { seq: reply.seq });
    const done = await call(reader.token, `/api/messages/${root.id}/thread/read`, "POST", {
      seq: reply.seq,
    });
    expect(done.body.state.unreadHold).toBeUndefined();
    expect(await surfaces(reply.id)).toEqual(read);
  });

  it("is read again once the channel is read past where it stood", async () => {
    const { root, reply } = await readInChannel();
    await call(reader.token, `/api/messages/${root.id}/thread/unread`, "POST", { seq: reply.seq });
    const later = await post("something new in the channel");
    await readChannel(later.seq);
    expect(await surfaces(reply.id)).toEqual(read);
    expect(server.store.threads.follow(reader.id, root.id)?.unreadHold).toBeUndefined();
  });

  it("leaves a quiet reply read only through its thread", async () => {
    const root = await post("a question");
    const quiet = await post(`<@${reader.id}> only in the thread`, { threadRootId: root.id });
    await readChannel(quiet.seq);
    // Reading the channel never read it, before or after a thread unread.
    expect((await surfaces(quiet.id)).mentions).toBe(1);
    await call(reader.token, `/api/messages/${root.id}/thread/unread`, "POST", { seq: quiet.seq });
    expect((await surfaces(quiet.id)).mentions).toBe(1);
    await call(reader.token, `/api/messages/${root.id}/thread/read`, "POST", { seq: quiet.seq });
    expect((await surfaces(quiet.id)).mentions).toBe(0);
  });

  it("agrees on every surface when the channel is marked unread before a reply read in its thread", async () => {
    // The other direction: the thread reads replies, so one read there stays read.
    const root = await post("a question");
    const reply = await post(`<@${reader.id}> also in the channel`, {
      threadRootId: root.id,
      alsoSendToChannel: true,
    });
    await call(reader.token, `/api/messages/${root.id}/thread/read`, "POST", { seq: reply.seq });
    await readChannel(reply.seq);
    await call(reader.token, `/api/channels/${general}/unread`, "POST", { seq: root.seq });
    expect(await surfaces(reply.id)).toEqual(read);
  });
});
