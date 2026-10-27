import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import type { Message, Reminder } from "@ownbase/protocol";
import { Api, WorkspaceClient } from "../src/index.js";

/** Reminders (E4) as a client keeps them, against a real server. */
const DAY = 24 * 60 * 60_000;
let server: WorkspaceServer;
let client: WorkspaceClient;
let other: WorkspaceClient;
let owner: Api;
let channelId: string;

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    retentionDays: 1,
    rateLimits: false,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base);
  const a = await api.register({ handle: "owner", displayName: "Owner", password: "password123" });
  const b = await api.register({
    handle: "member",
    displayName: "Member",
    password: "password123",
  });
  owner = new Api(base, a.token);
  // One account on two devices.
  client = new WorkspaceClient(base, b.token);
  other = new WorkspaceClient(base, b.token);
  client.connect();
  other.connect();
  await expect.poll(() => client.state.status).toBe("online");
  await expect.poll(() => other.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find((c) => c.name === "general")!.id;
});

afterEach(async () => {
  client?.destroy();
  other?.destroy();
  await server?.stop();
});

const say = async (text: string, threadRootId?: string) =>
  (await owner.sendMessage(channelId, { text, threadRootId })).message;

describe("reminders", () => {
  it("are set, moved and cancelled, and the account's other device keeps up", async () => {
    expect(client.state.reminders).toEqual({});
    const message = await say("Order the cake");
    const at = Date.now() + 3_600_000;

    expect(await client.setReminder(message.id, at)).toBe(true);
    expect(client.state.reminders?.[message.id]).toMatchObject({ remindAt: at, dueAt: null });
    await expect.poll(() => other.state.reminders?.[message.id]?.remindAt).toBe(at);

    expect(await client.setReminder(message.id, at + 60_000)).toBe(true);
    await expect.poll(() => other.state.reminders?.[message.id]?.remindAt).toBe(at + 60_000);

    expect(await client.cancelReminder(message.id)).toBe(true);
    expect(client.state.reminders?.[message.id]).toBeUndefined();
    await expect.poll(() => other.state.reminders?.[message.id]).toBeUndefined();
    // Already gone, as when another device finished it first.
    expect(await client.cancelReminder(message.id)).toBe(true);
  });

  it("keeps what the server answered, before its echo arrives", async () => {
    const message = await say("Answered first");
    const reminder: Reminder = {
      id: "R_1",
      messageId: message.id,
      channelId,
      threadRootId: null,
      remindAt: Date.now() + 60_000,
      dueAt: null,
    };
    vi.spyOn(client.api, "setReminder").mockResolvedValueOnce({ reminder });
    expect(await client.setReminder(message.id, reminder.remindAt)).toBe(true);
    expect(client.state.reminders?.[message.id]).toEqual(reminder);
  });

  it("says false when the server refuses, and changes nothing", async () => {
    const message = await say("Too late");
    expect(await client.setReminder(message.id, Date.now() - 1_000)).toBe(false);
    expect(client.state.reminders?.[message.id]).toBeUndefined();
    vi.spyOn(client.api, "cancelReminder").mockRejectedValueOnce(new Error("offline"));
    await client.setReminder(message.id, Date.now() + 60_000);
    expect(await client.cancelReminder(message.id)).toBe(false);
    expect(client.state.reminders?.[message.id]).toBeDefined();
  });

  it("says once, on each device, that a reminder came due, with its message", async () => {
    const due: [Reminder, Message][] = [];
    const elsewhere: Reminder[] = [];
    client.onReminderDue = (reminder, message) => due.push([reminder, message]);
    other.onReminderDue = (reminder) => elsewhere.push(reminder);
    const message = await say("Call the venue");

    await client.setReminder(message.id, Date.now() + 300);
    await expect.poll(() => due.length, { timeout: 5_000 }).toBe(1);
    expect(due[0]![1].text).toBe("Call the venue");
    expect(client.state.reminders?.[message.id]?.dueAt).toBe(due[0]![0].dueAt);
    await expect.poll(() => elsewhere.length).toBe(1);

    // Told again, as by a later echo, it is not news.
    const echo = { ...due[0]![0] };
    (client as unknown as { applyEphemeral(e: unknown): void }).applyEphemeral({
      type: "reminder",
      reminder: echo,
      message,
    });
    expect(due).toHaveLength(1);
  });

  it("lets go of the reminders retention took with their threads", async () => {
    const old = await say("An old question");
    const reply = await say("An old answer", old.id);
    const kept = await say("Said today");
    await client.setReminder(old.id, Date.now() + 3_600_000);
    await client.setReminder(reply.id, Date.now() + 3_600_000);
    await client.setReminder(kept.id, Date.now() + 3_600_000);

    const db = (server.store as unknown as { db: { exec(sql: string): void } }).db;
    db.exec(
      `UPDATE messages SET created_at = created_at - ${2 * DAY} WHERE id IN ('${old.id}', '${reply.id}')`,
    );
    expect(server.applyRetention()).toBe(2);

    await expect.poll(() => Object.keys(client.state.reminders ?? {})).toEqual([kept.id]);
    expect((await client.api.listReminders()).reminders.map((r) => r.message.id)).toEqual([
      kept.id,
    ]);
  });
});
