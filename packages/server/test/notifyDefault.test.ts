import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DatabaseSync } from "node:sqlite";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * What conversations notify about unless one is set on its own (v53), and the
 * summary of what waits that a device showing another workspace asks for.
 */
let server: WorkspaceServer | undefined;
let dataDir: string;
let base: string;
let owner: { token: string; id: string };
let peer: { token: string; id: string };
let general: string;
const sockets: WebSocket[] = [];

async function start() {
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
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
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
}

async function register(handle: string) {
  const made = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  const body = (await made.json()) as any;
  return { token: body.token as string, id: body.user.id as string };
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
const ready = (frames: ServerToClient[]) => frames.find((f) => f.type === "ready") as any;
/** One conversation's prefs, as a snapshot gives them. */
const prefsIn = (snapshot: any, channelId: string) =>
  snapshot.memberships.find((m: { channelId: string }) => m.channelId === channelId)?.prefs;
/** The defaults this socket was told, oldest first. */
const told = (frames: ServerToClient[]) =>
  frames.flatMap((f) =>
    f.type === "ephemeral" && f.event.type === "notify.default" ? [f.event.level] : [],
  );
const prefsTold = (frames: ServerToClient[]) =>
  frames.flatMap((f) => (f.type === "ephemeral" && f.event.type === "prefs" ? [f.event] : []));

const prefs = (channelId: string, patch: Record<string, unknown>, auth = owner.token) =>
  request(`/api/channels/${channelId}/prefs`, patch, "PATCH", auth);
const post = (channelId: string, text: string, auth: string) =>
  request(`/api/channels/${channelId}/messages`, { text, nonce: `${Math.random()}` }, "POST", auth);
const summary = async (auth = owner.token) =>
  (await request("/api/me/unread", undefined, "GET", auth)).body;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-notify-default-"));
  await start();
  owner = await register("owner");
  peer = await register("peer");
  general = server!.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the default for what notifies", () => {
  it("starts at mentions, in the snapshot, with every conversation following it", async () => {
    const snapshot = ready(await connect(owner.token));
    expect(snapshot.notifyDefault).toBe("mentions");
    expect(prefsIn(snapshot, general)).toMatchObject({
      notifyLevel: "mentions",
      notifyChosen: false,
    });
  });

  it("changes for this account alone, told to its own devices", async () => {
    const mine = await connect(owner.token);
    const theirs = await connect(peer.token);
    const changed = await request("/api/me/notify-default", { level: "all" }, "PUT");
    expect(changed).toEqual({ status: 200, body: { level: "all" } });
    await expect.poll(() => told(mine)).toEqual(["all"]);
    expect(told(theirs)).toEqual([]);
    expect(ready(await connect(owner.token)).notifyDefault).toBe("all");
    expect(ready(await connect(peer.token)).notifyDefault).toBe("mentions");
  });

  it("refuses a level it does not know", async () => {
    expect((await request("/api/me/notify-default", { level: "loud" }, "PUT")).status).toBe(400);
  });

  it("is left by a conversation given a level of its own, and taken up again on asking", async () => {
    const chosen = await prefs(general, { notifyLevel: "nothing" });
    expect(chosen.body.prefs).toMatchObject({ notifyLevel: "nothing", notifyChosen: true });
    const back = await prefs(general, { notifyChosen: false });
    expect(back.body.prefs).toMatchObject({ notifyChosen: false });
    // Muting or starring says nothing about the level.
    const starred = await prefs(general, { starred: true });
    expect(starred.body.prefs.notifyChosen).toBe(false);
  });

  it("counts a level other than mentions, set before there was a default, as chosen", async () => {
    await prefs(general, { notifyLevel: "all" });
    const made = await request("/api/channels", { name: "random", type: "public" });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    const random = made.body.channel.id as string;
    await prefs(random, { notifyLevel: "mentions" });
    await stop();
    // Back to v52, as a workspace from before the default would be.
    const db = new DatabaseSync(join(dataDir, "workspace.db"));
    db.exec("DROP TABLE channel_removals");
    db.exec("ALTER TABLE channel_members DROP COLUMN notify_chosen");
    db.exec("ALTER TABLE users DROP COLUMN notify_default");
    db.exec("PRAGMA user_version = 52");
    db.close();
    await start();
    const snapshot = ready(await connect(owner.token));
    expect(snapshot.notifyDefault).toBe("mentions");
    expect(prefsIn(snapshot, general)).toMatchObject({
      notifyLevel: "all",
      notifyChosen: true,
    });
    expect(prefsIn(snapshot, random)).toMatchObject({ notifyChosen: false });
  });
});

describe("what waits, for a device showing another workspace", () => {
  it("is nothing at first", async () => {
    expect(await summary()).toEqual({ mentions: 0, unread: false });
  });

  it("counts mentions as the badge does, and says something unread waits", async () => {
    await post(general, "nothing for the owner here", peer.token);
    expect(await summary()).toEqual({ mentions: 0, unread: true });
    await post(general, `<@${owner.id}> have a look`, peer.token);
    expect(await summary()).toEqual({ mentions: 1, unread: true });
    // The author has nothing waiting from it.
    expect((await summary(peer.token)).mentions).toBe(0);
  });

  it("leaves out a muted conversation, and one read since", async () => {
    await post(general, "news", peer.token);
    await prefs(general, { muted: true });
    expect((await summary()).unread).toBe(false);
    await prefs(general, { muted: false });
    expect((await summary()).unread).toBe(true);
    const seq = server!.store.channelLastSeqMap(owner.id)[general]!;
    await request(`/api/channels/${general}/read`, { seq });
    expect((await summary()).unread).toBe(false);
  });

  it("leaves out a DM with someone blocked", async () => {
    const dm = await request("/api/channels", { type: "dm", memberIds: [peer.id] });
    expect(dm.status, JSON.stringify(dm.body)).toBeLessThan(300);
    await post(dm.body.channel.id, "hi", peer.token);
    // A DM counts as a mention, as in Slack; only the unread rule is checked here.
    expect((await summary()).unread).toBe(true);
    await request(`/api/me/blocks/${peer.id}`, undefined, "PUT");
    const after = await summary();
    expect(after.unread).toBe(false);
  });

  it("is refused without a sign-in", async () => {
    expect((await request("/api/me/unread", undefined, "GET", "not-a-real-token")).status).toBe(
      401,
    );
  });
});
