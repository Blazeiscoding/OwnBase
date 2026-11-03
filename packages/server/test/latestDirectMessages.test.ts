import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * GET /api/conversations/latest: the newest message in each direct
 * conversation the caller is in, for the list of direct messages to show
 * under each name.
 */
let server: WorkspaceServer;
let base: string;
type Account = { token: string; id: string };
let owner: Account;
let sam: Account;
let priya: Account;

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

async function register(handle: string): Promise<Account> {
  const { body } = await request("/api/auth/register", {
    handle,
    displayName: handle,
    password: "password123",
  });
  return { token: body.token, id: body.user.id };
}

let nonce = 0;
const post = async (channelId: string, text: string, auth: string, threadRootId?: string) =>
  (
    await request(
      `/api/channels/${channelId}/messages`,
      { text, nonce: `n-${++nonce}`, threadRootId },
      "POST",
      auth,
    )
  ).body.message;

const conversation = async (memberIds: string[], auth = owner.token) =>
  (
    await request(
      "/api/channels",
      { type: memberIds.length === 1 ? "dm" : "group_dm", memberIds },
      "POST",
      auth,
    )
  ).body.channel.id as string;

const latest = async (auth = owner.token) => {
  const { status, body } = await request("/api/conversations/latest", undefined, "GET", auth);
  expect(status).toBe(200);
  return (body.messages as any[]).map((m) => [m.channelId, m.text]);
};

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  const first = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
  });
  const created = (await first.json()) as any;
  owner = { token: created.token, id: created.user.id };
  sam = await register("sam");
  priya = await register("priya");
});

afterEach(async () => {
  await server.stop();
});

describe("the newest message in each direct conversation", () => {
  it("is one per conversation the caller is in, newest first, leaving channels out", async () => {
    const withSam = await conversation([sam.id]);
    const group = await conversation([sam.id, priya.id]);
    const between = await conversation([priya.id], sam.token);
    const general = server.store.getChannelByName("general")!.id;
    await post(withSam, "Morning", sam.token);
    await post(withSam, "Morning! Coffee?", owner.token);
    await post(group, "Release at 4", priya.token);
    await post(between, "Not for the owner", sam.token);
    await post(general, "Channels are not direct", owner.token);
    expect(await latest()).toEqual([
      [group, "Release at 4"],
      [withSam, "Morning! Coffee?"],
    ]);
  });

  it("counts a reply only when it was also sent to the conversation, and skips deleted ones", async () => {
    const withSam = await conversation([sam.id]);
    const root = await post(withSam, "Plan for Friday", sam.token);
    await post(withSam, "In the thread only", owner.token, root.id);
    expect(await latest()).toEqual([[withSam, "Plan for Friday"]]);

    const broadcast = await request(
      `/api/channels/${withSam}/messages`,
      { text: "Sent to both", nonce: "n-both", threadRootId: root.id, alsoSendToChannel: true },
      "POST",
      owner.token,
    );
    expect(await latest()).toEqual([[withSam, "Sent to both"]]);

    await request(`/api/messages/${broadcast.body.message.id}`, undefined, "DELETE");
    expect(await latest()).toEqual([[withSam, "Plan for Friday"]]);
  });

  it("leaves out what someone the caller blocked wrote", async () => {
    const group = await conversation([sam.id, priya.id]);
    await post(group, "From Priya", priya.token);
    await post(group, "From Sam", sam.token);
    await request(`/api/me/blocks/${sam.id}`, undefined, "PUT");
    expect(await latest()).toEqual([[group, "From Priya"]]);
  });
});
