import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Blocking and reporting (E12). A block is one account's: it keeps the
 * blocked person's mentions out of its badges and Activity and ends their
 * friendship, while they are told nothing and their messages still reach
 * everyone, the blocker's devices included, which collapse them. A report
 * goes to the admins, who dismiss it, remove the message, or remove it and
 * deactivate its author.
 */
let server: WorkspaceServer;
let base: string;
let general: string;
const sockets: WebSocket[] = [];
type Account = { token: string; user: { id: string } };
let owner: Account;
let maya: Account;
let sam: Account;

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  owner = await register("owner");
  maya = await register("maya");
  sam = await register("sam");
  general = server.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
});

async function call(path: string, token?: string, body?: unknown, method = "POST") {
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

async function register(handle: string): Promise<Account> {
  return (
    await call("/api/auth/register", undefined, {
      handle,
      displayName: handle,
      password: "password123",
    })
  ).data;
}

const post = async (channelId: string, who: Account, text: string) =>
  (await call(`/api/channels/${channelId}/messages`, who.token, { text })).data.message as {
    id: string;
  };
const dm = async (from: Account, to: Account) =>
  (await call("/api/channels", from.token, { type: "dm", memberIds: [to.user.id] })).data.channel
    .id as string;
const block = (who: Account, whom: Account) =>
  call(`/api/me/blocks/${whom.user.id}`, who.token, undefined, "PUT");
const report = (who: Account, messageId: string, reason = "harassment", note?: string) =>
  call(`/api/messages/${messageId}/report`, who.token, { reason, ...(note ? { note } : {}) });
const queue = async (who: Account = owner) =>
  (await call("/api/admin/reports", who.token, undefined, "GET")).data.reports as any[];

async function connect(token: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerToClient));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  return {
    frames,
    closed: () => ws.readyState === WebSocket.CLOSED,
    ready: () =>
      frames.find((f) => f.type === "ready") as Extract<ServerToClient, { type: "ready" }>,
    /** The ephemeral events of one type heard so far. */
    heard: <T extends string>(type: T) =>
      frames.flatMap((f) =>
        f.type === "ephemeral" && f.event.type === type
          ? [f.event as Extract<typeof f.event, { type: T }>]
          : [],
      ),
    /** Waits for the server to have sent everything it was going to. */
    settle: async () => {
      const from = frames.length;
      ws.send(JSON.stringify({ type: "ping" }));
      await expect.poll(() => frames.slice(from).some((f) => f.type === "pong")).toBe(true);
    },
  };
}

describe("blocking someone", () => {
  it("is told to the blocker's devices and nobody else's, and undone by unblocking", async () => {
    const laptop = await connect(maya.token);
    const theirs = await connect(sam.token);
    expect(laptop.ready().blocked).toEqual([]);

    const blocked = await block(maya, sam);
    expect(blocked).toMatchObject({ status: 200, data: { blocked: [sam.user.id] } });
    await expect.poll(() => laptop.heard("blocks").at(-1)?.blocked).toEqual([sam.user.id]);
    // Blocking again changes nothing and says nothing more.
    expect((await block(maya, sam)).data.blocked).toEqual([sam.user.id]);
    const phone = await connect(maya.token);
    expect(phone.ready().blocked).toEqual([sam.user.id]);
    await theirs.settle();
    expect(theirs.heard("blocks")).toEqual([]);
    expect(theirs.heard("friends")).toEqual([]);
    await laptop.settle();
    expect(laptop.heard("blocks")).toHaveLength(1);

    const unblocked = await call(`/api/me/blocks/${sam.user.id}`, maya.token, undefined, "DELETE");
    expect(unblocked.data.blocked).toEqual([]);
    await expect.poll(() => phone.heard("blocks").at(-1)?.blocked).toEqual([]);
  });

  it("is not for oneself, an app or nobody", async () => {
    expect((await block(maya, maya)).data.error).toBe("cannot_block_self");
    const app = await call("/api/apps", owner.token, { name: "Deploy Bot" });
    expect(
      (await call(`/api/me/blocks/${app.data.botUser.id}`, maya.token, undefined, "PUT")).data
        .error,
    ).toBe("cannot_block_app");
    expect((await call("/api/me/blocks/U_NOBODY", maya.token, undefined, "PUT")).data.error).toBe(
      "user_not_found",
    );
  });

  it("keeps their mentions out of the badges and Activity, until unblocked", async () => {
    await post(general, sam, `<@${maya.user.id}> look at this`);
    const counts = async () => (await connect(maya.token)).ready().mentionCounts?.[general] ?? 0;
    const activity = async (mode: string) =>
      (await call(`/api/activity?mode=${mode}`, maya.token, undefined, "GET")).data.messages.length;
    expect(await counts()).toBe(1);
    expect(await activity("mentions")).toBe(1);
    const laptop = await connect(maya.token);

    await block(maya, sam);
    // Told as it happens, as well as at the next connection.
    await expect.poll(() => laptop.heard("mentions").length).toBeGreaterThan(0);
    expect(laptop.heard("mentions").at(-1)!.counts[general]).toBeUndefined();
    expect(await counts()).toBe(0);
    expect(await activity("mentions")).toBe(0);
    expect(await activity("unread")).toBe(0);
    // Someone else's mention still counts.
    await post(general, owner, `<@${maya.user.id}> and mine`);
    expect(await counts()).toBe(1);

    await call(`/api/me/blocks/${sam.user.id}`, maya.token, undefined, "DELETE");
    expect(await counts()).toBe(2);
  });

  it("ends a friendship between the two, which is all the other one hears", async () => {
    await call(`/api/friends/${sam.user.id}`, maya.token);
    await call(`/api/friends/${maya.user.id}`, sam.token, undefined, "PUT");
    const theirs = await connect(sam.token);
    expect(theirs.ready().friends).toHaveLength(1);
    await block(maya, sam);
    await expect.poll(() => theirs.heard("friends").at(-1)?.friends).toEqual([]);
    expect((await call("/api/friends", maya.token, undefined, "GET")).data.friends).toEqual([]);

    // Asking again, they see their request waiting; she sees nothing until she unblocks.
    expect((await call(`/api/friends/${maya.user.id}`, sam.token)).data.friends).toMatchObject([
      { userId: maya.user.id, status: "outgoing" },
    ]);
    expect((await call("/api/friends", maya.token, undefined, "GET")).data.friends).toEqual([]);
    const laptop = await connect(maya.token);
    expect(laptop.ready().friends).toEqual([]);
    await call(`/api/me/blocks/${sam.user.id}`, maya.token, undefined, "DELETE");
    await expect
      .poll(() => laptop.heard("friends").at(-1)?.friends)
      .toMatchObject([{ userId: sam.user.id, status: "incoming" }]);
  });

  it("leaves them able to write, and their words reaching everyone, the blocker's devices too", async () => {
    const channelId = await dm(sam, maya);
    await block(maya, sam);
    const laptop = await connect(maya.token);
    const others = await connect(owner.token);
    // No refusal tells them they were blocked.
    const sent = await call(`/api/channels/${channelId}/messages`, sam.token, { text: "hello?" });
    expect(sent.status).toBe(201);
    const inGeneral = await post(general, sam, "morning all");
    await expect
      .poll(() =>
        others.frames.some(
          (f) => f.type === "event" && f.envelope.event.type === "message.created",
        ),
      )
      .toBe(true);
    // The blocker's devices get them too, to fold away rather than lose.
    await expect
      .poll(
        () =>
          laptop.frames.filter(
            (f) => f.type === "event" && f.envelope.event.type === "message.created",
          ).length,
      )
      .toBe(2);
    const history = await call(`/api/channels/${general}/messages`, maya.token, undefined, "GET");
    expect(history.data.messages.map((m: { id: string }) => m.id)).toContain(inGeneral.id);
  });

  it("is open to a guest", async () => {
    server.setAccessPolicy("guest_allowed");
    const guest = (await call("/api/auth/guest", undefined, { displayName: "Visitor" })).data;
    expect((await block(guest, sam)).data.blocked).toEqual([sam.user.id]);
  });
});

describe("reporting a message", () => {
  it("goes to the admins' queue and devices, once per person while it is open", async () => {
    const admin = await connect(owner.token);
    const member = await connect(sam.token);
    expect(admin.ready().openReports).toBe(0);
    expect(member.ready().openReports).toBeUndefined();
    const message = await post(general, maya, "something nasty");

    expect((await report(sam, message.id, "harassment", "  Third time this week.  ")).status).toBe(
      200,
    );
    await expect.poll(() => admin.heard("reports").at(-1)?.open).toBe(1);
    expect((await report(sam, message.id, "spam")).status).toBe(200);
    await report(owner, message.id, "inappropriate");
    const [reported, ...rest] = await queue();
    expect(rest).toEqual([]);
    expect(reported).toMatchObject({
      messageId: message.id,
      authorId: maya.user.id,
      message: { id: message.id, text: "something nasty" },
      channel: { id: general },
    });
    // Sam's second report changed nothing; Owner's is the second.
    expect(reported.reports).toMatchObject([
      { reporterId: sam.user.id, reason: "harassment", note: "Third time this week." },
      { reporterId: owner.user.id, reason: "inappropriate", note: "" },
    ]);
    await member.settle();
    expect(member.heard("reports")).toEqual([]);
    expect((await connect(owner.token)).ready().openReports).toBe(1);
    // The author hears nothing.
    expect((await connect(maya.token)).ready().openReports).toBeUndefined();
  });

  it("is for what one can read and did not write", async () => {
    const mine = await post(general, maya, "my own words");
    expect((await report(maya, mine.id)).data.error).toBe("cannot_report_own_message");
    const privately = await dm(maya, owner);
    const hidden = await post(privately, maya, "between us");
    expect((await report(sam, hidden.id)).data.error).toBe("message_not_found");
    expect(
      (await call(`/api/messages/${mine.id}/report`, sam.token, { reason: "rude" })).status,
    ).toBe(400);
    expect((await report(sam, mine.id, "other", "x".repeat(501))).status).toBe(400);
    expect(await queue()).toEqual([]);
  });

  it("is open to a guest, and the queue is not", async () => {
    server.setAccessPolicy("guest_allowed");
    const guest = (await call("/api/auth/guest", undefined, { displayName: "Visitor" })).data;
    const message = await post(general, maya, "hello guest");
    expect((await report(guest, message.id, "spam")).status).toBe(200);
    expect((await call("/api/admin/reports", guest.token, undefined, "GET")).status).toBe(403);
    expect((await call("/api/admin/reports", sam.token, undefined, "GET")).data.error).toBe(
      "admin_only",
    );
  });

  it("shows admins a message from a conversation they are not in", async () => {
    const privately = await dm(maya, sam);
    const message = await post(privately, maya, "you will regret this");
    await report(sam, message.id, "harassment");
    const [reported] = await queue();
    expect(reported.message.text).toBe("you will regret this");
    expect(reported.channel).toMatchObject({ id: privately, type: "dm" });
  });

  it("keeps who wrote a message its author deleted, without its words", async () => {
    const message = await post(general, maya, "gone soon");
    await report(sam, message.id);
    await call(`/api/messages/${message.id}`, maya.token, undefined, "DELETE");
    const [reported] = await queue();
    expect(reported).toMatchObject({
      messageId: message.id,
      authorId: maya.user.id,
      message: null,
    });
  });
});

describe("settling a report", () => {
  const resolve = (messageId: string, action: string, who: Account = owner) =>
    call(`/api/admin/reports/${messageId}/resolve`, who.token, { action });

  it("dismissed, closes every report of it and leaves the message", async () => {
    const message = await post(general, maya, "borderline");
    await report(sam, message.id);
    await report(owner, message.id, "spam");
    const admin = await connect(owner.token);
    expect((await resolve(message.id, "dismiss")).status).toBe(200);
    expect(await queue()).toEqual([]);
    await expect.poll(() => admin.heard("reports").at(-1)?.open).toBe(0);
    const history = await call(`/api/channels/${general}/messages`, sam.token, undefined, "GET");
    expect(history.data.messages.map((m: { id: string }) => m.id)).toContain(message.id);
    expect(server.store.listAudit({ limit: 1 })[0]).toEqual(
      expect.objectContaining({
        action: "report.resolved",
        actorId: owner.user.id,
        targetType: "user",
        targetId: maya.user.id,
        details: { resolution: "dismiss", reports: 2 },
      }),
    );
    expect((await resolve(message.id, "dismiss")).data.error).toBe("report_not_found");
    // A new report of it opens again.
    await report(sam, message.id, "spam");
    expect(await queue()).toHaveLength(1);
  });

  it("by removing the message, deletes it for everyone, even from a conversation the admin is not in", async () => {
    const privately = await dm(maya, sam);
    const message = await post(privately, maya, "awful");
    await report(sam, message.id);
    const watching = await connect(sam.token);
    expect((await resolve(message.id, "remove")).status).toBe(200);
    await expect
      .poll(() =>
        watching.frames.some(
          (f) =>
            f.type === "event" &&
            f.envelope.event.type === "message.deleted" &&
            f.envelope.event.messageId === message.id,
        ),
      )
      .toBe(true);
    expect(server.store.getMessage(message.id)).toBeNull();
    expect(await queue()).toEqual([]);
    expect(server.store.listAudit({ limit: 1 })[0]!.details).toEqual({
      resolution: "remove",
      reports: 1,
    });
  });

  it("by deactivating, removes the message and signs its author out everywhere", async () => {
    const message = await post(general, maya, "the last straw");
    await report(sam, message.id);
    const theirs = await connect(maya.token);
    expect((await resolve(message.id, "deactivate")).status).toBe(200);
    expect(server.store.getMessage(message.id)).toBeNull();
    expect(server.store.getUser(maya.user.id)!.deactivated).toBe(true);
    expect((await call("/api/me", maya.token, undefined, "GET")).status).toBe(401);
    await expect.poll(() => theirs.closed()).toBe(true);
    const actions = server.store.listAudit({ limit: 2 }).map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(["user.deactivated", "report.resolved"]));
    // Reactivated, they sign in again: what they held before is gone for good.
    await call(`/api/admin/users/${maya.user.id}`, owner.token, { deactivated: false }, "PATCH");
    expect((await call("/api/me", maya.token, undefined, "GET")).status).toBe(401);
  });

  it("deactivates by People's rules, and is for admins only", async () => {
    const admin = await register("adele");
    await call(`/api/admin/users/${admin.user.id}`, owner.token, { role: "admin" }, "PATCH");
    const byOwner = await post(general, owner, "owner speaking");
    const byAdmin = await post(general, admin, "admin speaking");
    await report(sam, byOwner.id);
    await report(sam, byAdmin.id);
    expect((await resolve(byOwner.id, "deactivate", admin)).data.error).toBe("owner_is_protected");
    expect((await resolve(byOwner.id, "deactivate")).data.error).toBe("cannot_change_self");
    const other = await register("odin");
    await call(`/api/admin/users/${other.user.id}`, owner.token, { role: "admin" }, "PATCH");
    expect((await resolve(byAdmin.id, "deactivate", other)).data.error).toBe("admins_are_equals");
    expect((await resolve(byAdmin.id, "dismiss", sam)).data.error).toBe("admin_only");
    // Refused, it changed nothing.
    expect(await queue()).toHaveLength(2);
    expect(server.store.getMessage(byOwner.id)).not.toBeNull();
  });
});
