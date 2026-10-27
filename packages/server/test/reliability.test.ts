import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import { hashToken } from "../src/auth.js";

let server: WorkspaceServer;
let base: string;
let token: string;
let userId: string;
let channelId: string;
const sockets: WebSocket[] = [];
async function request(path: string, body?: unknown, method = "POST", auth = token) {
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
async function connect(auth = token) {
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
beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  const registration = await request("/api/auth/register", {
    handle: "owner",
    displayName: "Owner",
    password: "password123",
  });
  token = registration.body.token;
  userId = registration.body.user.id;
  channelId = server.store.getChannelByName("general")!.id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.stop();
});

describe("message integrity", () => {
  it("deduplicates nonce retries and rejects different content under the same key", async () => {
    const path = `/api/channels/${channelId}/messages`;
    const body = { text: "Send once", nonce: "stable-request" };
    const first = await request(path, body);
    const seq = server.store.currentSeq();
    const repeat = await request(path, body);
    expect(repeat.body.message.id).toBe(first.body.message.id);
    expect(server.store.currentSeq()).toBe(seq);
    expect((await request(path, { ...body, text: "Different request" })).status).toBe(409);
    await request(`/api/messages/${first.body.message.id}`, undefined, "DELETE");
    expect((await request(path, body)).status).toBe(409);
  });

  it("rolls back the message and event together if sequence stamping fails", async () => {
    const seq = server.store.currentSeq();
    vi.spyOn(server.store, "stampMessageSeq").mockImplementationOnce(() => {
      throw new Error("simulated write failure");
    });
    expect(
      (
        await request(`/api/channels/${channelId}/messages`, {
          text: "Never partly committed",
          nonce: "retry-after-rollback",
        })
      ).status,
    ).toBe(500);
    expect(server.store.currentSeq()).toBe(seq);
    expect(server.store.listMessages({ channelId, limit: 50 })).toHaveLength(0);
    expect(
      (
        await request(`/api/channels/${channelId}/messages`, {
          text: "Never partly committed",
          nonce: "retry-after-rollback",
        })
      ).status,
    ).toBe(201);
  });

  it("rejects unknown attachments without persisting an empty message", async () => {
    expect(
      (await request(`/api/channels/${channelId}/messages`, { text: "", fileIds: ["missing"] }))
        .status,
    ).toBe(400);
    expect(server.store.listMessages({ channelId, limit: 50 })).toHaveLength(0);
  });

  it.each(["-1", "0", "1.5", "Infinity", "201"])(
    "rejects invalid history limits: %s",
    async (limit) => {
      for (const suffix of [`after/0`, `around/missing`]) {
        expect(
          (
            await request(
              `/api/channels/${channelId}/messages/${suffix}?limit=${limit}`,
              undefined,
              "GET",
            )
          ).status,
        ).toBe(400);
      }
    },
  );
});

describe("live session access", () => {
  it.each(["message", "typing", "huddle.signal"])(
    "blocks %s delivery to an expired socket and removes its huddle seat",
    async (delivery) => {
      const expired = await connect();
      expired.ws.send(JSON.stringify({ type: "huddle.join", channelId }));
      await expect.poll(() => server.gateway.huddleParticipants(channelId)).toEqual([userId]);
      await expect
        .poll(() =>
          expired.frames.some(
            (f) =>
              f.type === "ephemeral" &&
              f.event.type === "huddle.participants" &&
              f.event.userIds.includes(userId),
          ),
        )
        .toBe(true);
      server.store.deleteSession(hashToken(token));
      server.store.createSession(hashToken(token), userId, "expired device", -1);
      expired.frames.length = 0;
      if (delivery === "message") {
        server.gateway.publish(
          { seq: 123, event: { type: "user.updated", user: server.store.getUser(userId)! } },
          null,
        );
      } else if (delivery === "typing") {
        server.gateway.broadcastEphemeral({ type: "typing", channelId, userId }, null);
      } else {
        server.gateway.sendToUser(userId, {
          type: "huddle.signal",
          channelId,
          from: userId,
          signal: { kind: "offer", sdp: "expired" },
        });
      }
      await expect.poll(() => expired.ws.readyState).toBe(WebSocket.CLOSED);
      expect(expired.frames).toEqual([
        expect.objectContaining({ type: "error", code: "auth_failed" }),
      ]);
      expect(server.gateway.huddleParticipants(channelId)).toEqual([]);
      expect((await request("/api/me", undefined, "GET")).status).toBe(401);
    },
  );

  it("refuses actions from an expired socket before the next heartbeat", async () => {
    const expired = await connect();
    server.store.deleteSession(hashToken(token));
    server.store.createSession(hashToken(token), userId, "expired device", -1);
    expired.ws.send(JSON.stringify({ type: "huddle.join", channelId }));
    await expect.poll(() => expired.ws.readyState).toBe(WebSocket.CLOSED);
    expect(server.gateway.huddleParticipants(channelId)).toEqual([]);
  });

  it("signs out all sockets for one token while retaining other sessions", async () => {
    const same1 = await connect();
    const same2 = await connect();
    const otherLogin = await request("/api/auth/login", {
      handle: "owner",
      password: "password123",
    });
    const other = await connect(otherLogin.body.token);
    await request("/api/auth/logout");
    await expect.poll(() => same1.ws.readyState).toBe(WebSocket.CLOSED);
    await expect.poll(() => same2.ws.readyState).toBe(WebSocket.CLOSED);
    expect(other.ws.readyState).toBe(WebSocket.OPEN);
    await request(
      `/api/channels/${channelId}/messages`,
      { text: "Other session remains usable" },
      "POST",
      otherLogin.body.token,
    );
    await expect
      .poll(() =>
        other.frames.some((f) => f.type === "event" && f.envelope.event.type === "message.created"),
      )
      .toBe(true);
    expect(
      same1.frames.some((f) => f.type === "event" && f.envelope.event.type === "message.created"),
    ).toBe(false);
  });
});

describe("channel access revocation", () => {
  it("takes the huddle seat away from someone who leaves a private channel", async () => {
    const invite = (await request("/api/invites", { maxUses: 5 })).body.invite.code;
    const guest = await request("/api/auth/register", {
      handle: "guest",
      displayName: "Guest",
      password: "password123",
      inviteCode: invite,
    });
    const channel = (await request("/api/channels", { type: "private", name: "leadership" })).body
      .channel;
    await request(`/api/channels/${channel.id}/invite-member`, { userId: guest.body.user.id });

    const host = await connect();
    const visitor = await connect(guest.body.token);
    for (const socket of [host, visitor])
      socket.ws.send(JSON.stringify({ type: "huddle.join", channelId: channel.id }));
    await expect.poll(() => server.gateway.huddleParticipants(channel.id).length).toBe(2);

    await request(`/api/channels/${channel.id}/leave`, undefined, "POST", guest.body.token);
    // Losing chat access loses call access in the same moment (F04).
    expect(server.gateway.huddleParticipants(channel.id)).toEqual([userId]);
    expect(
      (await request(`/api/channels/${channel.id}/messages`, undefined, "GET", guest.body.token))
        .status,
    ).toBe(404);

    // And the departing client is told, even though the channel audience no longer includes them.
    await expect
      .poll(() =>
        visitor.frames.some(
          (f) =>
            f.type === "ephemeral" &&
            f.event.type === "channel.access" &&
            f.event.channelId === channel.id &&
            f.event.channel === null,
        ),
      )
      .toBe(true);
  });
});

describe("scheduled delivery", () => {
  const queue = (body: Record<string, unknown>) =>
    request(`/api/channels/${channelId}/scheduled`, { sendAt: Date.now() + 3_600_000, ...body });
  /** Brings a queued row forward instead of idling the test until it is due. */
  const makeDue = (id: string) => server.store.rescheduleMessage(id, Date.now() - 1000);
  const listed = async () =>
    (await request("/api/scheduled", undefined, "GET")).body.scheduled as any[];
  const posted = () => server.store.listMessages({ channelId, limit: 50 });
  /** Brings a held row's next attempt forward, as waiting out its pause would. */
  const retryHeldNow = (id: string) =>
    (
      server.store as unknown as {
        db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } };
      }
    ).db
      .prepare("UPDATE scheduled_messages SET next_attempt_at = 0 WHERE id = ?")
      .run(id);

  it("refuses to queue a reply that could never be delivered", async () => {
    const root = await request(`/api/channels/${channelId}/messages`, { text: "Root" });
    const reply = await request(`/api/channels/${channelId}/messages`, {
      text: "Reply",
      threadRootId: root.body.message.id,
    });
    expect((await queue({ text: "Nested", threadRootId: reply.body.message.id })).status).toBe(400);
    expect((await queue({ text: "Nowhere", threadRootId: "missing" })).status).toBe(400);
    expect((await queue({ text: "Ghost file", fileIds: ["missing"] })).status).toBe(400);
  });

  it("fails a reply whose root was deleted rather than posting it under nothing", async () => {
    const root = await request(`/api/channels/${channelId}/messages`, { text: "Root" });
    const queued = await queue({ text: "Orphan", threadRootId: root.body.message.id });
    await request(`/api/messages/${root.body.message.id}`, undefined, "DELETE");
    makeDue(queued.body.scheduled.id);
    server.flushScheduled();

    const [item] = await listed();
    expect(item.status).toBe("failed");
    expect(item.failureReason).toMatch(/deleted/);
    expect(posted().some((m) => m.text === "Orphan")).toBe(false);
    // Terminal: further flushes neither post it nor lose it.
    server.flushScheduled();
    expect(posted().some((m) => m.text === "Orphan")).toBe(false);
    expect(await listed()).toHaveLength(1);
  });

  it("holds a message while its channel is archived and sends it once reopened", async () => {
    const queued = await queue({ text: "Waited for the channel" });
    await request(`/api/channels/${channelId}`, { archived: true }, "PATCH");
    makeDue(queued.body.scheduled.id);
    server.flushScheduled();

    expect((await listed())[0].status).toBe("held");
    expect(posted().some((m) => m.text === "Waited for the channel")).toBe(false);

    await request(`/api/channels/${channelId}`, { archived: false }, "PATCH");
    server.flushScheduled();
    expect(await listed()).toHaveLength(0);
    expect(posted().filter((m) => m.text === "Waited for the channel")).toHaveLength(1);
  });

  it("holds a message for a deactivated author and resumes on reactivation", async () => {
    const queued = await queue({ text: "Posted in my name" });
    makeDue(queued.body.scheduled.id);
    server.store.updateUser(userId, { deactivated: true });
    server.flushScheduled();
    expect(server.store.getScheduled(queued.body.scheduled.id)!.status).toBe("held");
    expect(posted().some((m) => m.text === "Posted in my name")).toBe(false);

    server.store.updateUser(userId, { deactivated: false });
    server.flushScheduled();
    expect(posted().filter((m) => m.text === "Posted in my name")).toHaveLength(1);
  });

  it("completes the queue row inside the message transaction and gives up after a bounded retry", async () => {
    const queued = await queue({ text: "All or nothing" });
    const id = queued.body.scheduled.id as string;
    makeDue(id);
    const failing = vi.spyOn(server.store, "stampMessageSeq").mockImplementation(() => {
      throw new Error("simulated write failure");
    });

    server.flushScheduled();
    // Neither half of the delivery survived the rollback.
    expect(posted()).toHaveLength(0);
    expect(server.store.getScheduled(id)!.status).toBe("held");
    expect(server.store.getScheduled(id)!.attempts).toBe(1);

    // A held row waits for its next attempt rather than the next tick.
    server.flushScheduled();
    expect(server.store.getScheduled(id)!.attempts).toBe(1);
    retryHeldNow(id);
    server.flushScheduled();
    retryHeldNow(id);
    server.flushScheduled();
    const exhausted = server.store.getScheduled(id)!;
    expect(exhausted.status).toBe("failed");
    expect(exhausted.messageId).toBeNull();

    // A failed row waits for the author, not for the next timer tick.
    failing.mockRestore();
    server.flushScheduled();
    expect(posted()).toHaveLength(0);

    await request(`/api/scheduled/${id}`, { sendAt: Date.now() }, "PATCH");
    server.flushScheduled();
    const sent = server.store.getScheduled(id)!;
    expect(sent.status).toBe("sent");
    expect(posted().find((m) => m.id === sent.messageId)!.text).toBe("All or nothing");
    expect(await listed()).toHaveLength(0);
  });
});

describe("editing a scheduled message's text", () => {
  const queue = (text: string, sendAt = Date.now() + 3_600_000) =>
    request(`/api/channels/${channelId}/scheduled`, { text, sendAt });
  const edit = (id: string, text: string, expectedText: string, auth = token) =>
    request(`/api/scheduled/${id}/text`, { text, expectedText }, "PATCH", auth);
  const posted = () => server.store.listMessages({ channelId, limit: 50 });

  it("changes only the text, and only if nobody changed it first", async () => {
    const queued = (await queue("Draft one")).body.scheduled;
    const first = await edit(queued.id, "Draft two", "Draft one");
    expect(first.status).toBe(200);
    expect(first.body.scheduled).toMatchObject({
      id: queued.id,
      text: "Draft two",
      sendAt: queued.sendAt,
      status: "queued",
    });

    // A second device still holding "Draft one" would overwrite "Draft two".
    const stale = await edit(queued.id, "Draft three", "Draft one");
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("scheduled_changed");
    expect(server.store.getScheduled(queued.id)!.text).toBe("Draft two");
  });

  it("accepts the same edit again, so a retried request does not report a conflict", async () => {
    const queued = (await queue("Before")).body.scheduled;
    expect((await edit(queued.id, "After", "Before")).status).toBe(200);
    // The response was lost and the client sends it again: the text already matches.
    const repeated = await edit(queued.id, "After", "Before");
    expect(repeated.status).toBe(200);
    expect(repeated.body.scheduled.text).toBe("After");
  });

  it("sends the edited text when it comes due, and refuses edits once sent", async () => {
    const queued = (await queue("Original")).body.scheduled;
    // Due, but not yet delivered: the edit still lands, and does not move it.
    server.store.rescheduleMessage(queued.id, Date.now() - 1000);
    const dueAt = server.store.getScheduled(queued.id)!.sendAt;
    expect((await edit(queued.id, "Edited in time", "Original")).status).toBe(200);
    expect(server.store.getScheduled(queued.id)!.sendAt).toBe(dueAt);

    server.flushScheduled();
    const sent = server.store.getScheduled(queued.id)!;
    expect(sent.status).toBe("sent");
    expect(posted().find((m) => m.id === sent.messageId)!.text).toBe("Edited in time");

    const late = await edit(queued.id, "Too late", "Edited in time");
    expect(late.status).toBe(404);
    expect(posted().find((m) => m.id === sent.messageId)!.text).toBe("Edited in time");
    // Completion keeps the message identity, not another copy of its words.
    expect(server.store.getScheduled(queued.id)!.text).toBe("");
  });

  it("keeps a held message held, with its reason and attempts, when its text changes", async () => {
    const queued = (await queue("Waiting")).body.scheduled;
    await request(`/api/channels/${channelId}`, { archived: true }, "PATCH");
    server.store.rescheduleMessage(queued.id, Date.now() - 1000);
    server.flushScheduled();
    const held = server.store.getScheduled(queued.id)!;
    expect(held.status).toBe("held");

    expect((await edit(queued.id, "Still waiting", "Waiting")).status).toBe(200);
    expect(server.store.getScheduled(queued.id)).toMatchObject({
      text: "Still waiting",
      status: "held",
      failureReason: held.failureReason,
      attempts: held.attempts,
      sendAt: held.sendAt,
    });
  });

  it("refuses an empty message, and anyone but its author", async () => {
    const queued = (await queue("Mine")).body.scheduled;
    const empty = await edit(queued.id, "   ", "Mine");
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("empty_message");

    const other = await request("/api/auth/register", {
      handle: "other",
      displayName: "Other",
      password: "password123",
    });
    expect((await edit(queued.id, "Theirs", "Mine", other.body.token)).status).toBe(404);
    expect((await edit("missing", "Theirs", "Mine")).status).toBe(404);
    expect(server.store.getScheduled(queued.id)!.text).toBe("Mine");
  });
});
