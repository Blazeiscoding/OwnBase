import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import { openDb } from "../src/db.js";
import { Store } from "../src/store.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Someone removed from a channel by somebody else hears of it in Activity: a
 * note of who, which channel as it was named then, and when, kept until they
 * read it, and told to their open devices as it happens.
 */

describe("the store's notes of removals", () => {
  let db: DatabaseSync;
  let store: Store;
  beforeEach(() => {
    db = openDb(":memory:");
    store = new Store(db);
    db.exec(`
      INSERT INTO users (id, handle, display_name, password_hash, salt, created_at) VALUES
        ('U1', 'one', 'One', '', '', 0), ('U2', 'two', 'Two', '', '', 0);
      INSERT INTO channels (id, type, name, creator_id, created_at) VALUES
        ('C1', 'public', 'design', 'U1', 0), ('C2', 'private', 'plans', 'U1', 0),
        ('D1', 'dm', '', 'U1', 0);
    `);
  });
  afterEach(() => db.close());

  it("keeps the channel as it was named, newest first, until read", () => {
    const first = store.addChannelRemoval("U2", store.getChannel("C1")!, "U1")!;
    expect(first).toMatchObject({
      channelId: "C1",
      channelName: "design",
      channelType: "public",
      removedBy: "U1",
    });
    const second = store.addChannelRemoval("U2", store.getChannel("C2")!, "U1")!;
    db.prepare("UPDATE channel_removals SET created_at = created_at - 1000 WHERE id = ?").run(
      first.id,
    );
    // A rename since does not change what the note says.
    db.exec("UPDATE channels SET name = 'design-old' WHERE id = 'C1'");
    expect(store.channelRemovals("U2").map((r) => [r.id, r.channelName])).toEqual([
      [second.id, "plans"],
      [first.id, "design"],
    ]);
    expect(store.channelRemovals("U1")).toEqual([]);

    // Another account's notes are not theirs to read; one read twice is read once.
    expect(store.readChannelRemovals("U1", [first.id])).toEqual([]);
    expect(store.readChannelRemovals("U2", [first.id, first.id, "nope"])).toEqual([first.id]);
    expect(store.channelRemovals("U2").map((r) => r.id)).toEqual([second.id]);
  });

  it("leaves no note for a direct conversation", () => {
    expect(store.addChannelRemoval("U2", store.getChannel("D1")!, "U1")).toBeNull();
    expect(store.channelRemovals("U2")).toEqual([]);
  });

  it("outlives the channel it names", () => {
    store.addChannelRemoval("U2", store.getChannel("C2")!, "U1");
    db.exec("DELETE FROM channels WHERE id = 'C2'");
    expect(store.channelRemovals("U2").map((r) => r.channelName)).toEqual(["plans"]);
  });
});

describe("removal from a channel, over the API", () => {
  let server: WorkspaceServer | undefined;
  let dataDir: string;
  let base: string;
  let owner: { token: string; id: string };
  let peer: { token: string; id: string };
  const sockets: WebSocket[] = [];

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

  /** Removal events this socket was told, oldest first. */
  const told = (frames: ServerToClient[]) =>
    frames.flatMap((f) =>
      f.type === "ephemeral" &&
      (f.event.type === "channel.removal" || f.event.type === "channel.removals.read")
        ? [f.event]
        : [],
    );
  const snapshotRemovals = (frames: ServerToClient[]) =>
    (frames.find((f) => f.type === "ready") as any).channelRemovals;

  const channel = async (type: "public" | "private", name: string) => {
    const made = (await request("/api/channels", { type, name })).body.channel;
    if (type === "public") await request(`/api/channels/${made.id}/join`, {}, "POST", peer.token);
    else await request(`/api/channels/${made.id}/invite-member`, { userId: peer.id });
    return made as { id: string; name: string };
  };
  const remove = (channelId: string, userId = peer.id, auth = owner.token) =>
    request(`/api/channels/${channelId}/members/${userId}`, undefined, "DELETE", auth);

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "ownbase-removals-"));
    server = await createWorkspaceServer({ dataDir, host: "127.0.0.1", port: 0, mdns: false });
    base = `http://127.0.0.1:${server.port}`;
    const first = await request(
      "/api/auth/register",
      { handle: "owner", displayName: "Owner", password: "password123" },
      "POST",
      "",
    );
    owner = { token: first.body.token, id: first.body.user.id };
    const second = await request(
      "/api/auth/register",
      { handle: "peer", displayName: "Peer", password: "password123" },
      "POST",
      "",
    );
    peer = { token: second.body.token, id: second.body.user.id };
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await server?.stop();
    server = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("tells the removed person's devices who removed them, and only theirs", async () => {
    const design = await channel("public", "design");
    const theirs = await connect(peer.token);
    const mine = await connect(owner.token);
    expect(snapshotRemovals(theirs)).toEqual([]);

    expect((await remove(design.id)).status).toBe(200);
    await expect
      .poll(() => told(theirs))
      .toEqual([
        {
          type: "channel.removal",
          removal: {
            id: expect.any(String),
            channelId: design.id,
            channelName: "design",
            channelType: "public",
            removedBy: owner.id,
            createdAt: expect.any(Number),
          },
        },
      ]);
    expect(told(mine)).toEqual([]);

    // A device that connects later is handed it.
    const later = await connect(peer.token);
    expect(snapshotRemovals(later).map((r: any) => r.channelName)).toEqual(["design"]);
  });

  it("notes a private channel too, which they can no longer see", async () => {
    const plans = await channel("private", "plans");
    const theirs = await connect(peer.token);
    await remove(plans.id);
    await expect
      .poll(() => told(theirs).map((e) => e.type === "channel.removal" && e.removal.channelType))
      .toEqual(["private"]);
  });

  it("leaves no note for someone who left by themselves", async () => {
    const design = await channel("public", "design");
    const plans = await channel("private", "plans");
    const theirs = await connect(peer.token);
    await request(`/api/channels/${design.id}/leave`, {}, "POST", peer.token);
    await request(`/api/channels/${plans.id}/leave`, {}, "POST", peer.token);
    // Removing someone no longer there changes nothing, so says nothing.
    await remove(design.id);
    expect(server!.store.channelRemovals(peer.id)).toEqual([]);
    const again = await connect(peer.token);
    expect(snapshotRemovals(again)).toEqual([]);
    expect(told(theirs)).toEqual([]);
  });

  it("leaves no note when the removal is refused", async () => {
    const design = await channel("public", "design");
    // A member cannot remove the owner.
    expect((await remove(design.id, owner.id, peer.token)).status).toBe(403);
    expect(server!.store.channelRemovals(owner.id)).toEqual([]);
  });

  it("reads notes once, on every device, and only the reader's own", async () => {
    const design = await channel("public", "design");
    const plans = await channel("private", "plans");
    await remove(design.id);
    await remove(plans.id);
    const [newest, oldest] = server!.store.channelRemovals(peer.id);
    const phone = await connect(peer.token);
    const laptop = await connect(peer.token);

    // Not another account's to read.
    const stranger = await request("/api/activity/removals/read", { ids: [newest!.id] });
    expect(stranger).toEqual({ status: 200, body: { ids: [] } });

    const read = await request(
      "/api/activity/removals/read",
      { ids: [oldest!.id, "gone"] },
      "POST",
      peer.token,
    );
    expect(read).toEqual({ status: 200, body: { ids: [oldest!.id] } });
    for (const device of [phone, laptop])
      await expect
        .poll(() => told(device))
        .toEqual([{ type: "channel.removals.read", ids: [oldest!.id] }]);
    expect(server!.store.channelRemovals(peer.id).map((r) => r.id)).toEqual([newest!.id]);

    // Read again: nothing changes, and nobody is told.
    await request("/api/activity/removals/read", { ids: [oldest!.id] }, "POST", peer.token);
    expect(told(phone)).toHaveLength(1);

    expect(
      (await request("/api/activity/removals/read", { ids: [] }, "POST", peer.token)).status,
    ).toBe(400);
  });
});
