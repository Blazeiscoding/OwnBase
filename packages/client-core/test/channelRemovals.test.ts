import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient, unreadRemovalCount } from "../src/index.js";

/**
 * Notes that someone else removed this account from a channel, as a client
 * keeps them for Activity, against a real server.
 */
let server: WorkspaceServer;
let client: WorkspaceClient;
let other: WorkspaceClient;
let owner: Api;
let ownerId: string;
let memberId: string;
let memberToken: string;

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
  const b = await api.register({
    handle: "member",
    displayName: "Member",
    password: "password123",
  });
  owner = new Api(base, a.token);
  ownerId = a.user.id;
  memberId = b.user.id;
  memberToken = b.token;
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

const joined = async (name: string) => {
  const { channel } = await owner.createChannel({ type: "public", name });
  await client.api.joinChannel(channel.id);
  await expect.poll(() => channel.id in client.state.memberships).toBe(true);
  return channel;
};

describe("notes of removals", () => {
  it("arrive as someone removes this account, and reading one clears it everywhere", async () => {
    expect(client.state.channelRemovals).toEqual({});
    const design = await joined("design");
    await owner.removeChannelMember(design.id, memberId);

    await expect.poll(() => unreadRemovalCount(client.state)).toBe(1);
    const [note] = Object.values(client.state.channelRemovals);
    expect(note).toMatchObject({
      channelId: design.id,
      channelName: "design",
      channelType: "public",
      removedBy: ownerId,
    });
    await expect.poll(() => unreadRemovalCount(other.state)).toBe(1);

    expect(await client.readChannelRemovals([note!.id])).toBe(true);
    expect(client.state.channelRemovals).toEqual({});
    await expect.poll(() => unreadRemovalCount(other.state)).toBe(0);
    // Read again, as another device did first: nothing to do.
    expect(await client.readChannelRemovals([note!.id])).toBe(true);
  });

  it("leave none behind for leaving by oneself", async () => {
    const design = await joined("design");
    await client.api.leaveChannel(design.id);
    await expect.poll(() => design.id in client.state.memberships).toBe(false);
    // Something after it, so that a note would have come by now.
    const plans = await joined("plans");
    await owner.removeChannelMember(plans.id, memberId);
    await expect.poll(() => unreadRemovalCount(client.state)).toBe(1);
    expect(Object.values(client.state.channelRemovals).map((r) => r.channelName)).toEqual([
      "plans",
    ]);
  });

  it("come back when the server could not be told", async () => {
    const design = await joined("design");
    await owner.removeChannelMember(design.id, memberId);
    await expect.poll(() => unreadRemovalCount(client.state)).toBe(1);
    const [note] = Object.values(client.state.channelRemovals);
    let fail!: (error: Error) => void;
    vi.spyOn(client.api, "readChannelRemovals").mockReturnValueOnce(
      new Promise((_, reject) => (fail = reject)),
    );
    const reading = client.readChannelRemovals([note!.id]);
    // Gone at once,
    expect(unreadRemovalCount(client.state)).toBe(0);
    fail(new Error("offline"));
    // and back when it could not be read.
    expect(await reading).toBe(false);
    expect(client.state.channelRemovals).toEqual({ [note!.id]: note });
  });

  it("are handed to a device that connects later", async () => {
    const design = await joined("design");
    await owner.removeChannelMember(design.id, memberId);
    await expect.poll(() => unreadRemovalCount(client.state)).toBe(1);
    other.destroy();
    const later = new WorkspaceClient(`http://127.0.0.1:${server.port}`, memberToken);
    try {
      later.connect();
      await expect.poll(() => later.state.status).toBe("online");
      expect(Object.values(later.state.channelRemovals).map((r) => r.channelName)).toEqual([
        "design",
      ]);
    } finally {
      later.destroy();
    }
  });
});
