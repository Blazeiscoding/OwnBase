import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient, waitsForAttention } from "../src/index.js";
// What waits for an account is said twice: by the server, in SQL, for the
// account's other devices showing another workspace, and by this device from
// what it holds. Each case here asks both, so neither can drift on its own.

let server: WorkspaceServer;
let client: WorkspaceClient;
let owner: Api;
let member: Api;
let memberId: string;
let ownerId: string;

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
  member = new Api(base, b.token);
  ownerId = a.user.id;
  memberId = b.user.id;
  client = new WorkspaceClient(base, b.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  for (const id of Object.keys(client.state.memberships)) await readAll(id);
});

afterEach(async () => {
  client?.destroy();
  await server?.stop();
});

async function readAll(channelId: string) {
  const last = client.state.channelLastSeq[channelId] ?? 0;
  client.markRead(channelId, last);
  await expect.poll(() => client.state.memberships[channelId] ?? 0).toBeGreaterThanOrEqual(last);
}

/** Posts as the owner and waits until this device has heard of it. */
async function ownerPosts(channelId: string, text: string) {
  const { message } = await owner.sendMessage(channelId, { text, nonce: text });
  await expect.poll(() => client.state.channelLastSeq[channelId] ?? 0).toBe(message.seq);
}

/** Asks both sides whether anything waits for the member. */
async function bothSay(waiting: boolean) {
  const here = Object.keys(client.state.memberships).some((id) =>
    waitsForAttention(client.state, id, null),
  );
  const there = (await member.unreadSummary()).unread;
  expect({ here, there }).toEqual({ here: waiting, there: waiting });
}

describe("what waits for this account", () => {
  it("is the same on this device and on the server", async () => {
    const general = Object.values(client.state.channels).find((c) => c.name === "general")!.id;
    await bothSay(false);

    await ownerPosts(general, "Hello");
    await bothSay(true);

    // Muted: still unread, but nothing asks for attention.
    await member.setChannelPrefs(general, { muted: true });
    await expect.poll(() => client.state.prefs[general]?.muted).toBe(true);
    await bothSay(false);
    await member.setChannelPrefs(general, { muted: false });
    await expect.poll(() => client.state.prefs[general]?.muted).toBe(false);
    await bothSay(true);
    await readAll(general);
    await bothSay(false);

    // Archived with something unread.
    const { channel: plans } = await owner.createChannel({ type: "public", name: "plans" });
    await member.joinChannel(plans.id);
    await expect.poll(() => plans.id in client.state.memberships).toBe(true);
    await readAll(plans.id);
    await ownerPosts(plans.id, "Plan");
    await bothSay(true);
    await owner.updateChannel(plans.id, { archived: true });
    await expect.poll(() => client.state.channels[plans.id]?.archived).toBe(true);
    await bothSay(false);

    // A direct conversation closed while unread, until someone writes again.
    const { channel: dm } = await owner.createChannel({ type: "dm", memberIds: [memberId] });
    await ownerPosts(dm.id, "Hi");
    await bothSay(true);
    const closedAt = client.state.channelLastSeq[dm.id]!;
    await member.setChannelPrefs(dm.id, { hiddenSeq: closedAt });
    await expect.poll(() => client.state.prefs[dm.id]?.hiddenSeq).toBe(closedAt);
    await bothSay(false);
    await ownerPosts(dm.id, "Still there?");
    await bothSay(true);

    // A DM with someone this account blocked.
    await member.blockUser(ownerId);
    await expect.poll(() => client.state.blocked).toEqual([ownerId]);
    await bothSay(false);
  });
});
