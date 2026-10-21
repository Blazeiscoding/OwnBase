import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type Reminder, type ServerToClient } from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/** Reminders (E4): set, moved, come due on time and after a restart, and dropped. */
let server: WorkspaceServer | undefined;
let dataDir: string;
let base: string;
let owner: { token: string; id: string };
let peer: { token: string; id: string };
let channelId: string;
const sockets: WebSocket[] = [];

async function start(options: { isolated?: boolean; perAccount?: number } = {}) {
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    isolated: options.isolated,
    reminderLimits: options.perAccount ? { perAccount: options.perAccount } : undefined,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function stop() {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
  server = undefined;
}

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
  return frames;
}

/** Reminder events this socket was told, newest last. */
const told = (frames: ServerToClient[]) =>
  frames.flatMap((f) =>
    f.type === "ephemeral" && (f.event.type === "reminder" || f.event.type === "reminder.removed")
      ? [f.event]
      : [],
  );
const ready = (frames: ServerToClient[]) => frames.find((f) => f.type === "ready") as any;

let nonce = 0;
const post = async (text: string, auth = peer.token, channel = channelId) =>
  (
    await request(
      `/api/channels/${channel}/messages`,
      { text, nonce: `n-${++nonce}` },
      "POST",
      auth,
    )
  ).body.message;
const remind = (messageId: string, at: number, auth = owner.token) =>
  request(`/api/messages/${messageId}/reminder`, { at }, "PUT", auth);
const listed = async (auth = owner.token) =>
  (await request("/api/reminders", undefined, "GET", auth)).body.reminders as {
    reminder: Reminder;
    message: { id: string; text: string };
  }[];

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "slackoss-reminders-"));
  await start();
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
  channelId = server!.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("a reminder", () => {
  it("is set on a message, listed with it, and moved when set again", async () => {
    const mine = await connect(owner.token);
    const theirs = await connect(peer.token);
    const message = await post("Send the invoice by Friday");
    const at = Date.now() + 3_600_000;

    const set = await remind(message.id, at);
    expect(set.status).toBe(201);
    expect(set.body.reminder).toMatchObject({
      messageId: message.id,
      channelId,
      threadRootId: null,
      remindAt: at,
      dueAt: null,
    });
    expect((await listed()).map((item) => item.message.text)).toEqual([
      "Send the invoice by Friday",
    ]);

    const moved = await remind(message.id, at + 60_000);
    expect(moved.status).toBe(200);
    expect(moved.body.reminder).toMatchObject({ id: set.body.reminder.id, remindAt: at + 60_000 });
    expect(await listed()).toHaveLength(1);

    await expect.poll(() => told(mine).length).toBe(2);
    expect(told(mine).at(-1)).toMatchObject({
      type: "reminder",
      reminder: { remindAt: at + 60_000 },
    });
    // Someone else's reminders are their own.
    expect(told(theirs)).toEqual([]);
    expect(await listed(peer.token)).toEqual([]);
  });

  it("can be about a reply in a thread", async () => {
    const root = await post("Launch checklist");
    const reply = (
      await request(
        `/api/channels/${channelId}/messages`,
        { text: "Check the DNS", nonce: "r1", threadRootId: root.id },
        "POST",
        peer.token,
      )
    ).body.message;
    const set = await remind(reply.id, Date.now() + 60_000);
    expect(set.body.reminder.threadRootId).toBe(root.id);
  });

  it("comes due at its time, told only to the account's devices, with its message", async () => {
    const mine = await connect(owner.token);
    const theirs = await connect(peer.token);
    const message = await post("Stand up in five");
    await remind(message.id, Date.now() + 300);

    await expect
      .poll(() => told(mine).find((e) => e.type === "reminder" && e.reminder.dueAt !== null), {
        timeout: 5_000,
      })
      .toMatchObject({ message: { id: message.id, text: "Stand up in five" } });
    expect(told(theirs)).toEqual([]);
    const [item] = await listed();
    expect(item!.reminder.dueAt).not.toBeNull();
    expect(ready(await connect(owner.token)).reminders).toMatchObject([
      { messageId: message.id, dueAt: item!.reminder.dueAt },
    ]);

    // Set again, as Remind me later does, it waits again.
    const again = await remind(message.id, Date.now() + 60_000);
    expect([again.status, again.body.reminder.dueAt]).toEqual([200, null]);
  });

  it("lists those come due, the latest first, then those waiting, the soonest first", async () => {
    const later = await post("later");
    const sooner = await post("sooner");
    const first = await post("due first");
    const second = await post("due second");
    await remind(later.id, Date.now() + 7_200_000);
    await remind(sooner.id, Date.now() + 3_600_000);
    await remind(first.id, Date.now() + 200);
    await remind(second.id, Date.now() + 700);
    await expect
      .poll(async () => (await listed()).map((item) => item.message.text), { timeout: 5_000 })
      .toEqual(["due second", "due first", "sooner", "later"]);
  });

  it("comes due on starting when its time passed while the server was stopped, but not in an isolated copy", async () => {
    const message = await post("Renew the certificate");
    await remind(message.id, Date.now() + 400);
    await stop();
    await new Promise((resolve) => setTimeout(resolve, 600));

    await start({ isolated: true });
    expect((await listed())[0]!.reminder.dueAt).toBeNull();
    await stop();

    await start();
    await expect
      .poll(async () => (await listed())[0]?.reminder.dueAt ?? null, { timeout: 5_000 })
      .not.toBeNull();
    expect(ready(await connect(owner.token)).reminders[0].dueAt).not.toBeNull();
  });

  it("is not listed once its message is gone, even before it is dropped", async () => {
    const message = await post("Gone soon");
    await remind(message.id, Date.now() + 60_000);
    // The row alone, without the deletion's events, which drop it.
    server!.store.deleteMessage(message.id);
    expect(await listed()).toEqual([]);
    expect(ready(await connect(owner.token)).reminders).toEqual([]);
  });

  it("is cancelled, or marked done, by removing it", async () => {
    const mine = await connect(owner.token);
    const message = await post("Book the room");
    await remind(message.id, Date.now() + 60_000);

    expect(
      (await request(`/api/messages/${message.id}/reminder`, undefined, "DELETE")).status,
    ).toBe(200);
    expect(await listed()).toEqual([]);
    await expect
      .poll(() => told(mine).at(-1))
      .toEqual({ type: "reminder.removed", messageId: message.id });
    expect(
      (await request(`/api/messages/${message.id}/reminder`, undefined, "DELETE")).status,
    ).toBe(404);
  });

  it("goes with its message when the message is deleted, and its owners are told", async () => {
    const mine = await connect(owner.token);
    const theirs = await connect(peer.token);
    const message = await post("Draft agenda");
    const reply = (
      await request(
        `/api/channels/${channelId}/messages`,
        { text: "Item one", nonce: "agenda-reply", threadRootId: message.id },
        "POST",
        peer.token,
      )
    ).body.message;
    // A reply's reminder goes with its thread.
    await remind(reply.id, Date.now() + 60_000);
    await remind(message.id, Date.now() + 60_000);
    await remind(message.id, Date.now() + 60_000, peer.token);

    await request(`/api/messages/${message.id}`, undefined, "DELETE", peer.token);
    for (const frames of [mine, theirs]) {
      await expect
        .poll(() => told(frames).at(-1))
        .toEqual({ type: "reminder.removed", messageId: message.id });
    }
    expect(server!.store.getReminder(owner.id, message.id)).toBeNull();
    expect(server!.store.getReminder(owner.id, reply.id)).toBeNull();
    expect(told(mine)).toContainEqual({ type: "reminder.removed", messageId: reply.id });
    expect(await listed(peer.token)).toEqual([]);
  });

  it("is dropped, not delivered, once its account is deactivated", async () => {
    const message = await post("Quarterly review");
    await remind(message.id, Date.now() + 400, peer.token);
    expect(
      (await request(`/api/admin/users/${peer.id}`, { deactivated: true }, "PATCH")).status,
    ).toBe(200);
    await expect
      .poll(() => server!.store.getReminder(peer.id, message.id), { timeout: 5_000 })
      .toBeNull();
  });

  it("is dropped, not delivered, once its account can no longer read the message", async () => {
    const secret = (
      await request("/api/channels", { type: "private", name: "secret", memberIds: [peer.id] })
    ).body.channel;
    const message = await post("Private plans", owner.token, secret.id);
    await remind(message.id, Date.now() + 500, peer.token);
    const theirs = await connect(peer.token);

    await request(`/api/channels/${secret.id}/leave`, undefined, "POST", peer.token);
    expect(await listed(peer.token)).toEqual([]);
    expect(ready(await connect(peer.token)).reminders).toEqual([]);

    await expect
      .poll(() => told(theirs).at(-1), { timeout: 5_000 })
      .toEqual({ type: "reminder.removed", messageId: message.id });
    expect(told(theirs).some((e) => e.type === "reminder" && e.reminder.dueAt !== null)).toBe(
      false,
    );
    expect(server!.store.getReminder(peer.id, message.id)).toBeNull();
  });

  it("refuses a time past or too far off, a message it cannot see, and one too many", async () => {
    await stop();
    await start({ perAccount: 2 });
    const message = await post("One");
    expect((await remind(message.id, Date.now() - 1_000)).body.error).toBe("reminder_in_past");
    expect((await remind(message.id, Date.now() + 6 * 366 * 24 * 3_600_000)).body.error).toBe(
      "reminder_too_far",
    );
    expect((await request(`/api/messages/${message.id}/reminder`, {}, "PUT")).status).toBe(400);
    expect((await remind("nope", Date.now() + 60_000)).status).toBe(404);

    const secret = (await request("/api/channels", { type: "private", name: "secret" })).body
      .channel;
    const hidden = await post("Hidden", owner.token, secret.id);
    expect((await remind(hidden.id, Date.now() + 60_000, peer.token)).status).toBe(404);

    expect((await remind(message.id, Date.now() + 60_000)).status).toBe(201);
    expect((await remind((await post("Two")).id, Date.now() + 60_000)).status).toBe(201);
    const third = await remind((await post("Three")).id, Date.now() + 60_000);
    expect([third.status, third.body.error]).toEqual([409, "reminder_limit"]);
    // Moving one already set is not one more.
    expect((await remind(message.id, Date.now() + 120_000)).status).toBe(200);
  });

  it("can be set by a guest in a public channel, as a guest may save", async () => {
    server!.setAccessPolicy("guest_allowed");
    const guest = await request("/api/auth/guest", { displayName: "Visiting Vic" }, "POST", "");
    const message = await post("Welcome, visitors");
    expect((await remind(message.id, Date.now() + 60_000, guest.body.token)).status).toBe(201);
    expect(await listed(guest.body.token)).toHaveLength(1);
    expect(
      (await request(`/api/messages/${message.id}/reminder`, undefined, "DELETE", guest.body.token))
        .status,
    ).toBe(200);
  });
});
