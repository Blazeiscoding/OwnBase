import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient } from "../src/index.js";

/**
 * A connected client when retention removes old conversation (RECHECK-09):
 * what it holds of the threads that went goes too, its mention count is the
 * server's again, and a thread it followed no longer counts as unread.
 */
const DAY = 24 * 3600_000;

let server: WorkspaceServer;
let client: WorkspaceClient;
let owner: Api;
let channelId: string;
let readerId: string;

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
    handle: "reader",
    displayName: "Reader",
    password: "password123",
  });
  readerId = b.user.id;
  owner = new Api(base, a.token);
  client = new WorkspaceClient(base, b.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find((c) => c.name === "general")!.id;
});

afterEach(async () => {
  client?.destroy();
  await server?.stop();
});

/** Every message old enough to go, as two days passing would. */
function age() {
  const db = (server.store as unknown as { db: { exec(sql: string): void } }).db;
  db.exec(`UPDATE messages SET created_at = created_at - ${2 * DAY}`);
}

describe("a connected client when retention removes old conversation", () => {
  it("lets go of the threads that went, and of the counts they made", async () => {
    await client.loadTimeline(channelId);
    const { message: old } = await owner.sendMessage(channelId, {
      text: `<@${readerId}> an old question`,
    });
    const { message: reply } = await owner.sendMessage(channelId, {
      text: "an old answer",
      threadRootId: old.id,
      alsoSendToChannel: true,
    });
    await client.loadThread(old.id, channelId);
    client.setThreadFollow(old.id, true);
    await client.toggleSaved(old.id, true);
    await expect.poll(() => client.state.mentionCounts[channelId]).toBe(1);
    await expect.poll(() => client.state.threadFollows[old.id]?.following).toBe(true);
    const shown = () => client.state.timelines[channelId]!.items.map((m) => m.id);
    await expect.poll(shown).toEqual(expect.arrayContaining([old.id, reply.id]));

    age();
    // Something newer stays.
    const { message: recent } = await owner.sendMessage(channelId, { text: "said today" });
    expect(server.applyRetention()).toBe(2);

    await expect.poll(shown).toEqual([recent.id]);
    expect(client.state.threads[old.id]).toBeUndefined();
    expect(client.state.threadPages[old.id]).toBeUndefined();
    expect(client.state.threadFollows[old.id]).toBeUndefined();
    expect(client.state.saved[old.id]).toBeUndefined();
    await expect.poll(() => client.state.mentionCounts).toEqual({});
    expect(client.state.removedHistory[channelId]).toBeGreaterThan(0);
  });
});
