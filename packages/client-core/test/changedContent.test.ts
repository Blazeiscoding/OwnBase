import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import { Api, WorkspaceClient } from "../src/index.js";

/**
 * Search results and the Pinned panel hold their own copies of messages. What
 * tells them to ask again is `changedContent`, which has to move when a
 * message is edited, deleted or pinned in a conversation whose history this
 * client has not loaded (Q07, Q08). Nothing here loads a timeline.
 */
let server: WorkspaceServer;
let client: WorkspaceClient;
let owner: Api;
let general: string;

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
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
  client = new WorkspaceClient(base, b.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  general = Object.values(client.state.channels).find((c) => c.name === "general")!.id;
});

afterEach(async () => {
  client?.destroy();
  await server?.stop();
});

const changed = (channelId = general) => client.state.changedContent[channelId] ?? 0;

describe("what changed in a conversation", () => {
  it("is not moved by a new message, which changes nothing already there", async () => {
    const { message } = await owner.sendMessage(general, { text: "Hello", nonce: "one" });
    await expect.poll(() => client.state.channelLastSeq[general]).toBe(message.seq);
    expect(changed()).toBe(0);
  });

  it("moves when a message is pinned, edited or deleted, with none of its history loaded", async () => {
    const { message } = await owner.sendMessage(general, { text: "Original", nonce: "one" });
    await expect.poll(() => client.state.channelLastSeq[general]).toBe(message.seq);
    expect(client.state.timelines[general]?.loaded ?? false).toBe(false);

    await owner.pinMessage(message.id);
    await expect.poll(changed).toBeGreaterThan(0);
    const pinned = changed();

    await owner.editMessage(message.id, "Edited");
    await expect.poll(changed).toBeGreaterThan(pinned);
    const edited = changed();

    await owner.deleteMessage(message.id);
    await expect.poll(changed).toBeGreaterThan(edited);
  });

  it("moves when this account leaves the conversation", async () => {
    const { channel } = await owner.createChannel({ name: "side", type: "public" });
    await client.api.joinChannel(channel.id);
    await expect.poll(() => channel.id in client.state.memberships).toBe(true);
    expect(changed(channel.id)).toBe(0);

    await client.api.leaveChannel(channel.id);
    await expect.poll(() => changed(channel.id)).toBeGreaterThan(0);
  });
});

describe("who is in a conversation", () => {
  const moved = () => client.state.memberChanges[general] ?? 0;

  it("moves when someone joins or leaves, and not for a message", async () => {
    const { message } = await owner.sendMessage(general, { text: "Hello", nonce: "one" });
    await expect.poll(() => client.state.channelLastSeq[general]).toBe(message.seq);
    expect(moved()).toBe(0);

    // A new account joins the public channels.
    const base = `http://127.0.0.1:${server.port}`;
    const joined = await new Api(base).register({
      handle: "newcomer",
      displayName: "Newcomer",
      password: "password123",
    });
    await expect.poll(moved).toBeGreaterThan(0);
    const first = moved();

    await new Api(base, joined.token).leaveChannel(general);
    await expect.poll(moved).toBeGreaterThan(first);
  });
});
