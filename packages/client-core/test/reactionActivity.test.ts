import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient, markEverythingRead, unreadEverywhere } from "../src/index.js";

/**
 * Reactions to this account's messages, as a client keeps them for
 * Activity's Reactions tab (K13), against a real server.
 */
let server: WorkspaceServer;
let client: WorkspaceClient;
let other: WorkspaceClient;
let owner: Api;
let mine: Api;

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base);
  const a = await api.register({ handle: "owner", displayName: "Owner", password: "password123" });
  const b = await api.register({ handle: "maya", displayName: "Maya", password: "password123" });
  owner = new Api(base, a.token);
  mine = new Api(base, b.token);
  // One account on two devices.
  client = new WorkspaceClient(base, b.token);
  other = new WorkspaceClient(base, b.token);
  client.connect();
  other.connect();
  await expect.poll(() => client.state.status).toBe("online");
  await expect.poll(() => other.state.status).toBe("online");
});

afterEach(async () => {
  client?.destroy();
  other?.destroy();
  await server?.stop();
});

async function myMessage(text: string) {
  const { channel } = await owner.createChannel({ type: "public", name: "design" });
  await mine.joinChannel(channel.id);
  const { message } = await mine.sendMessage(channel.id, { text });
  return message;
}

describe("reactions to my messages", () => {
  it("count as new on every device until seen, and then on none", async () => {
    const message = await myMessage("Launch notes");
    expect(client.state.reactionActivity.unseen).toBe(0);
    expect(unreadEverywhere(client.state).reactions).toBe(0);

    await owner.addReaction(message.id, "🎉");
    await expect.poll(() => client.state.reactionActivity.unseen).toBe(1);
    await expect.poll(() => other.state.reactionActivity.unseen).toBe(1);
    expect(unreadEverywhere(client.state).reactions).toBe(1);

    expect(await client.seeReactions()).toBeNull();
    expect(client.state.reactionActivity.unseen).toBe(0);
    await expect.poll(() => other.state.reactionActivity.unseen).toBe(0);
    expect(other.state.reactionActivity.seenAt).toBe(client.state.reactionActivity.seenAt);
  });

  it("keep the open list current as reactions come and go", async () => {
    const message = await myMessage("Launch notes");
    const list = client.lists.reactionActivity();
    const close = list.open();
    try {
      await expect.poll(() => list.current.items).toEqual([]);
      await owner.addReaction(message.id, "🎉");
      await expect
        .poll(() => list.current.items?.map((row) => [row.id, row.emoji, row.count]))
        .toEqual([[`${message.id}:🎉`, "🎉", 1]]);
      await owner.removeReaction(message.id, "🎉");
      await expect.poll(() => list.current.items).toEqual([]);
    } finally {
      close();
    }
  });

  it("are seen by marking everything read", async () => {
    const message = await myMessage("Launch notes");
    await owner.addReaction(message.id, "👀");
    await expect.poll(() => client.state.reactionActivity.unseen).toBe(1);
    expect(await markEverythingRead(client)).toBeNull();
    expect(client.state.reactionActivity.unseen).toBe(0);
    await expect.poll(() => other.state.reactionActivity.unseen).toBe(0);
  });
});
