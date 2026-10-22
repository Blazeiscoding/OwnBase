import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  type ChannelPrefs,
  type ReadySnapshot,
  type ServerToClient,
} from "@slackoss/protocol";
import { openDb, openDbAtVersion } from "../src/db.js";
import { Store } from "../src/store.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * A starred conversation (UX-20): one member's own choice, kept with their
 * membership beside muting, and told to their other devices only.
 */
const servers: WorkspaceServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of servers.splice(0)) await server.stop();
});

async function start() {
  const server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (path: string, token: string, body?: unknown, method = "POST") => {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const register = async (handle: string) => {
    const response = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
    });
    const created = (await response.json()) as any;
    return { token: created.token as string, id: created.user.id as string };
  };
  const star = (channelId: string, token: string, body: unknown) =>
    call(`/api/channels/${channelId}/prefs`, token, body, "PATCH");
  return { server, base, call, register, star };
}

/** A socket signed in as the token's account, with every frame it hears. */
async function listen(base: string, token: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerToClient));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  return frames;
}

const ready = (frames: ServerToClient[]) =>
  frames.find((f): f is ReadySnapshot => f.type === "ready")!;
const prefsHeard = (frames: ServerToClient[], channelId: string): ChannelPrefs[] =>
  frames.flatMap((f) =>
    f.type === "ephemeral" && f.event.type === "prefs" && f.event.channelId === channelId
      ? [f.event.prefs]
      : [],
  );

describe("a starred conversation", () => {
  let ctx: Awaited<ReturnType<typeof start>>;
  let owner: { token: string; id: string };
  let peer: { token: string; id: string };
  let general: string;

  beforeEach(async () => {
    ctx = await start();
    owner = await ctx.register("owner");
    peer = await ctx.register("peer");
    const { body } = await ctx.call("/api/channels", owner.token, undefined, "GET");
    general = (body.channels as { id: string; name: string }[]).find(
      (c) => c.name === "general",
    )!.id;
  });

  it("is kept for the account that starred it, and nobody else", async () => {
    const starred = await ctx.star(general, owner.token, { starred: true });
    expect(starred.status).toBe(200);
    expect(starred.body.prefs).toEqual({
      notifyLevel: "mentions",
      muted: false,
      starred: true,
      sectionId: null,
    });
    expect(ctx.server.store.getChannelPrefs(general, owner.id)?.starred).toBe(true);
    expect(ctx.server.store.getChannelPrefs(general, peer.id)?.starred).toBe(false);

    // Each account's snapshot carries its own, and says this server keeps stars.
    const mine = ready(await listen(ctx.base, owner.token));
    expect(mine.stars).toBe(true);
    expect(mine.memberships.find((m) => m.channelId === general)?.prefs.starred).toBe(true);
    const theirs = ready(await listen(ctx.base, peer.token));
    expect(theirs.memberships.find((m) => m.channelId === general)?.prefs.starred).toBe(false);
  });

  it("leaves the other choices alone, and they leave it alone", async () => {
    await ctx.star(general, owner.token, { starred: true });
    const muted = await ctx.star(general, owner.token, { muted: true });
    expect(muted.body.prefs).toEqual({
      notifyLevel: "mentions",
      muted: true,
      starred: true,
      sectionId: null,
    });
    const unstarred = await ctx.star(general, owner.token, { starred: false });
    expect(unstarred.body.prefs).toEqual({
      notifyLevel: "mentions",
      muted: true,
      starred: false,
      sectionId: null,
    });
  });

  it("reaches the account's other devices, and not other members", async () => {
    const laptop = await listen(ctx.base, owner.token);
    const phone = await listen(ctx.base, owner.token);
    const someoneElse = await listen(ctx.base, peer.token);

    await ctx.star(general, owner.token, { starred: true });
    await expect.poll(() => prefsHeard(laptop, general).at(-1)?.starred).toBe(true);
    await expect.poll(() => prefsHeard(phone, general).at(-1)?.starred).toBe(true);
    await ctx.star(general, owner.token, { starred: false });
    await expect.poll(() => prefsHeard(phone, general).at(-1)?.starred).toBe(false);
    expect(prefsHeard(someoneElse, general)).toEqual([]);
  });

  it("stars a direct message too", async () => {
    const { body } = await ctx.call("/api/channels", owner.token, {
      type: "dm",
      memberIds: [peer.id],
    });
    const dm = body.channel.id as string;
    expect((await ctx.star(dm, owner.token, { starred: true })).body.prefs.starred).toBe(true);
    expect(ctx.server.store.getChannelPrefs(dm, peer.id)?.starred).toBe(false);
  });

  it("refuses what is not a yes or no, and a conversation the account is not in", async () => {
    const bad = await ctx.star(general, owner.token, { starred: "yes" });
    expect(bad.status).toBe(400);
    expect(ctx.server.store.getChannelPrefs(general, owner.id)?.starred).toBe(false);

    const { body } = await ctx.call("/api/channels", owner.token, {
      name: "plans",
      type: "private",
    });
    const hidden = await ctx.star(body.channel.id, peer.token, { starred: true });
    expect(hidden.status).toBeGreaterThanOrEqual(400);
    expect(ctx.server.store.getChannelPrefs(body.channel.id, peer.id)).toBeNull();

    // A public channel can still be looked into after leaving; starring needs
    // being in it.
    const { body: open } = await ctx.call("/api/channels", owner.token, {
      name: "lobby",
      type: "public",
    });
    await ctx.call(`/api/channels/${open.channel.id}/leave`, peer.token);
    const looking = await ctx.star(open.channel.id, peer.token, { starred: true });
    expect(looking.status).toBe(400);
    expect(looking.body.error).toBe("not_a_member");
  });

  it("goes with leaving, so joining again starts unstarred", async () => {
    const { body } = await ctx.call("/api/channels", owner.token, {
      name: "side-project",
      type: "public",
    });
    const channel = body.channel.id as string;
    await ctx.call(`/api/channels/${channel}/join`, peer.token);
    await ctx.star(channel, peer.token, { starred: true });
    await ctx.call(`/api/channels/${channel}/leave`, peer.token);
    expect(ctx.server.store.getChannelPrefs(channel, peer.id)).toBeNull();
    await ctx.call(`/api/channels/${channel}/join`, peer.token);
    expect(ctx.server.store.getChannelPrefs(channel, peer.id)?.starred).toBe(false);
  });

  it("stays through archiving, so a channel brought back is starred again", async () => {
    await ctx.star(general, peer.token, { starred: true });
    await ctx.call(`/api/channels/${general}`, owner.token, { archived: true }, "PATCH");
    expect(ctx.server.store.getChannelPrefs(general, peer.id)?.starred).toBe(true);
    await ctx.call(`/api/channels/${general}`, owner.token, { archived: false }, "PATCH");
    const snapshot = ready(await listen(ctx.base, peer.token));
    expect(snapshot.memberships.find((m) => m.channelId === general)?.prefs.starred).toBe(true);
  });
});

describe("upgrading a workspace to stars (v40)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tandem-stars-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps every member's choices and stars nothing", () => {
    const file = join(dir, "workspace.db");
    const older = openDbAtVersion(file, 39);
    older.exec(`
      INSERT INTO users (id, handle, display_name, password_hash, salt, created_at)
        VALUES ('U1', 'owner', 'Owner', '', '', 0), ('U2', 'peer', 'Peer', '', '', 0);
      INSERT INTO channels (id, type, name, creator_id, created_at)
        VALUES ('C1', 'public', 'general', 'U1', 0);
      INSERT INTO channel_members (channel_id, user_id, joined_at, notify_level, muted)
        VALUES ('C1', 'U1', 0, 'all', 1), ('C1', 'U2', 0, 'mentions', 0);
    `);
    older.close();

    const db = openDb(file, undefined, { backupBeforeUpgrade: false });
    try {
      const store = new Store(db);
      expect(store.getChannelPrefs("C1", "U1")).toEqual({
        notifyLevel: "all",
        muted: true,
        starred: false,
        sectionId: null,
      });
      expect(store.memberships("U2")[0]?.prefs).toEqual({
        notifyLevel: "mentions",
        muted: false,
        starred: false,
        sectionId: null,
      });
      expect(store.setChannelPrefs("C1", "U2", { starred: true })?.starred).toBe(true);
      expect(store.getChannelPrefs("C1", "U1")?.starred).toBe(false);
    } finally {
      db.close();
    }
  });
});
