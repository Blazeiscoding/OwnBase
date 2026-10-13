import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, REPLY_EXCERPT_LENGTH, type ServerToClient } from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Inline replies, as Discord has them beside Slack's threads: a message that
 * answers another in place, showing who wrote that one and how it began, and
 * by default notifying its author.
 */
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

const send = (auth: string, body: Record<string, unknown>, channel = channelId) =>
  request(`/api/channels/${channel}/messages`, body, "POST", auth);

const post = async (auth: string, body: Record<string, unknown>, channel = channelId) => {
  const res = await send(auth, body, channel);
  expect(res.status).toBe(201);
  return res.body.message;
};

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
  return frames;
}

/** Everything the event log holds, as the raw text it is stored as. */
const logged = () => JSON.stringify(server.store.eventsSince(0, owner.id, 100_000) ?? []);

/** The log's copies of one message, oldest first. */
const loggedCopies = (id: string) =>
  (server.store.eventsSince(0, owner.id, 100_000) ?? []).flatMap(({ event }) =>
    (event.type === "message.created" || event.type === "message.updated") &&
    event.message.id === id
      ? [event.message]
      : [],
  );

const register = async (handle: string) => {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  const created = (await res.json()) as any;
  return { token: created.token as string, id: created.user.id as string };
};

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
  peer = await register("peer");
  channelId = server.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.stop();
});

describe("inline replies", () => {
  it("carry who wrote what they answer and how it began, and only replies carry it", async () => {
    const frames = await connect(owner.token);
    const ready = frames.find((f) => f.type === "ready");
    expect(ready && "inlineReplies" in ready && ready.inlineReplies).toBe(true);

    const original = await post(owner.token, { text: "Lunch at noon?" });
    expect(original).not.toHaveProperty("replyTo");
    const reply = await post(peer.token, { text: "Count me in", replyToId: original.id });
    expect(reply.replyTo).toEqual({
      id: original.id,
      userId: owner.id,
      text: "Lunch at noon?",
      fileCount: 0,
      deleted: false,
      ping: true,
    });

    const history = await request(`/api/channels/${channelId}/messages`, undefined, "GET");
    const listed = history.body.messages.find((m: { id: string }) => m.id === reply.id);
    expect(listed.replyTo.text).toBe("Lunch at noon?");
  });

  it("quote only the start of a long message, never half a mention", async () => {
    const long = `${"a".repeat(REPLY_EXCERPT_LENGTH - 5)} <@${peer.id}> and more after it`;
    const original = await post(owner.token, { text: long });
    const reply = await post(peer.token, { text: "Long one", replyToId: original.id });
    expect(reply.replyTo.text).toBe(`${"a".repeat(REPLY_EXCERPT_LENGTH - 5)} `);
  });

  it("notify the author of what they answer as a mention would, unless asked not to", async () => {
    const original = await post(owner.token, { text: "Who has the keys?" });
    const frames = await connect(owner.token);

    await post(peer.token, { text: "I do", replyToId: original.id });
    expect(server.store.unreadMentionCounts(owner.id)).toEqual({ [channelId]: 1 });
    // The author's connected devices hear their new count at once.
    await expect
      .poll(() =>
        frames.some(
          (f) =>
            f.type === "ephemeral" &&
            f.event.type === "mentions" &&
            f.event.counts[channelId] === 1,
        ),
      )
      .toBe(true);

    const quiet = await post(peer.token, {
      text: "Also me",
      replyToId: original.id,
      replyPing: false,
    });
    expect(quiet.replyTo.ping).toBe(false);
    expect(server.store.unreadMentionCounts(owner.id)).toEqual({ [channelId]: 1 });

    // Answering yourself notifies nobody.
    const own = await post(owner.token, { text: "Never mind", replyToId: original.id });
    expect(own.replyTo.ping).toBe(false);

    // The notification is the reply's, not its words', so an edit keeps it.
    const mentions = await request("/api/activity?mode=mentions", undefined, "GET");
    expect(mentions.body.messages.map((m: { text: string }) => m.text)).toEqual(["I do"]);
    const pinged = mentions.body.messages[0];
    expect(
      (
        await request(
          `/api/messages/${pinged.id}`,
          { text: "I do, at my desk" },
          "PATCH",
          peer.token,
        )
      ).status,
    ).toBe(200);
    expect(server.store.unreadMentionCounts(owner.id)).toEqual({ [channelId]: 1 });
  });

  it("answer only something in their own conversation", async () => {
    const other = (await request("/api/channels", { name: "random", type: "public" })).body.channel;
    const elsewhere = await post(owner.token, { text: "Over here" }, other.id);
    const refused = await send(peer.token, { text: "Hm", replyToId: elsewhere.id });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("bad_reply_target");

    const root = await post(owner.token, { text: "Thread start" });
    const inThread = await post(peer.token, { text: "In the thread", threadRootId: root.id });
    // A reply kept to its thread is not in the channel to be answered there...
    expect((await send(owner.token, { text: "Re", replyToId: inThread.id })).status).toBe(400);
    // ...but is in its thread, as is the thread's first message.
    const answered = await post(owner.token, {
      text: "Re",
      threadRootId: root.id,
      replyToId: inThread.id,
    });
    expect(answered.replyTo.id).toBe(inThread.id);
    expect(
      (await post(owner.token, { text: "Re root", threadRootId: root.id, replyToId: root.id }))
        .replyTo.id,
    ).toBe(root.id);

    // Another thread's reply is not this thread's to answer.
    const second = await post(owner.token, { text: "Another start" });
    expect(
      (await send(owner.token, { text: "Re", threadRootId: second.id, replyToId: inThread.id }))
        .status,
    ).toBe(400);

    // A reply sent to the channel too can be answered there.
    const shown = await post(peer.token, {
      text: "Also in the channel",
      threadRootId: root.id,
      alsoSendToChannel: true,
    });
    expect((await post(owner.token, { text: "Seen", replyToId: shown.id })).replyTo.id).toBe(
      shown.id,
    );
  });

  it("still go when what they answer was deleted meanwhile, saying so", async () => {
    const original = await post(owner.token, { text: "Going, going" });
    expect((await request(`/api/messages/${original.id}`, undefined, "DELETE")).status).toBe(200);
    const late = await post(peer.token, { text: "Gone already?", replyToId: original.id });
    expect(late.replyTo).toEqual({
      id: original.id,
      userId: "",
      text: "",
      fileCount: 0,
      deleted: true,
      ping: false,
    });
    expect(server.store.unreadMentionCounts(owner.id)).toEqual({});

    // Removed altogether, there is nothing to point at: it goes as a message.
    const plain = await post(peer.token, {
      text: "Hello?",
      replyToId: "01NOSUCHMESSAGE00000000000",
    });
    expect(plain).not.toHaveProperty("replyTo");
  });

  it("follow an edit, and keep no earlier words of it in the log", async () => {
    const original = await post(owner.token, { text: "The secret plan, first draft" });
    const reply = await post(peer.token, { text: "Love it", replyToId: original.id });
    expect(logged()).toContain("first draft");

    await request(`/api/messages/${original.id}`, { text: "The plan, revised" }, "PATCH");
    const history = await request(`/api/channels/${channelId}/messages`, undefined, "GET");
    const shown = history.body.messages.find((m: { id: string }) => m.id === reply.id);
    expect(shown.replyTo.text).toBe("The plan, revised");
    // The reply's own copies in the log now quote the edit, so replaying the
    // log can never show the words the author took back.
    expect(loggedCopies(reply.id).map((m) => m.replyTo?.text)).toEqual(["The plan, revised"]);
    expect(logged()).not.toContain("first draft");
  });

  it("say what they answer was deleted, in the log as well", async () => {
    const original = await post(owner.token, { text: "Regrettable words" });
    const reply = await post(peer.token, { text: "Wow", replyToId: original.id });
    // An edit of the reply itself is a copy too.
    await request(`/api/messages/${reply.id}`, { text: "Wow indeed" }, "PATCH", peer.token);

    await request(`/api/messages/${original.id}`, undefined, "DELETE");
    const history = await request(`/api/channels/${channelId}/messages`, undefined, "GET");
    const shown = history.body.messages.find((m: { id: string }) => m.id === reply.id);
    expect(shown.replyTo).toMatchObject({ deleted: true, text: "", userId: "" });
    expect(loggedCopies(reply.id).map((m) => m.replyTo?.deleted)).toEqual([true, true]);
    expect(logged()).not.toContain("Regrettable");
  });

  it("say what they answer is gone once older history is removed", async () => {
    const original = await post(owner.token, { text: "Ancient history" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reply = await post(peer.token, { text: "Still here", replyToId: original.id });

    server.store.transaction(() => server.store.purgeMessagesBefore(original.createdAt + 1));
    const history = await request(`/api/channels/${channelId}/messages`, undefined, "GET");
    const ids = history.body.messages.map((m: { id: string }) => m.id);
    expect(ids).toContain(reply.id);
    expect(ids).not.toContain(original.id);
    const shown = history.body.messages.find((m: { id: string }) => m.id === reply.id);
    expect(shown.replyTo).toMatchObject({ id: original.id, deleted: true, text: "" });
    expect(logged()).not.toContain("Ancient");
  });

  it("settle a retried send on the first, and refuse its key for a different answer", async () => {
    const original = await post(owner.token, { text: "First" });
    const other = await post(owner.token, { text: "Second" });
    const body = { text: "Re", nonce: "reply-retry-1", replyToId: original.id };
    const first = await post(peer.token, body);
    expect((await post(peer.token, body)).id).toBe(first.id);
    const changed = await send(peer.token, { ...body, replyToId: other.id });
    expect(changed.status).toBe(409);
  });
});
