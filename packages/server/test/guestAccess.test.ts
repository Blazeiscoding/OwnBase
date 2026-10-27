import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import {
  createWorkspaceServer,
  GUEST_ROUTES,
  GUEST_SESSION_TTL_MS,
  type WorkspaceServer,
} from "../src/server.js";
import { hashToken } from "../src/auth.js";

/**
 * Joining as a guest: allowed only while the host says so, with a display name
 * alone; a guest reads and takes part in public channels and nothing else,
 * for a day, and may keep its identity as an account.
 */
type Person = { token: string; user: { id: string; handle: string; role: string } };
let server: WorkspaceServer | undefined;
let base = "";
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
  server = undefined;
});

async function start(opts: { inviteOnly?: boolean; accessPolicy?: "guest_allowed" } = {}) {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
    ...opts,
  });
  base = `http://127.0.0.1:${server.port}`;
  return server;
}

async function call(method: string, path: string, token?: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: (text ? JSON.parse(text) : {}) as any };
}

async function register(handle: string): Promise<Person> {
  const { status, data } = await call("POST", "/api/auth/register", undefined, {
    handle,
    displayName: handle,
    password: "password123",
  });
  expect(status).toBe(201);
  return data;
}

async function joinAsGuest(displayName = "Visitor"): Promise<Person> {
  const { status, data } = await call("POST", "/api/auth/guest", undefined, { displayName });
  expect(status, JSON.stringify(data)).toBe(201);
  return data;
}

async function serverInfo() {
  return (await call("GET", "/api/server-info")).data as {
    accessPolicy?: string;
    requiresInvite: boolean;
  };
}

/** A workspace with an owner, guests allowed, and its #general. */
async function guestWorkspace() {
  await start();
  const owner = await register("owner");
  server!.setAccessPolicy("guest_allowed");
  const { channels } = (await call("GET", "/api/channels", owner.token)).data;
  const general = channels.find((c: { name: string }) => c.name === "general").id as string;
  return { owner, general };
}

async function connect(token: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  let closed: number | null = null;
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerToClient));
  ws.on("close", (code) => (closed = code));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        type: "hello",
        token,
        lastSeq: null,
        syncVersion: 1,
        protocolVersion: PROTOCOL_VERSION,
      }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  return { frames, closed: () => closed };
}

describe("who may join", () => {
  it("keeps an existing workspace's rule: invites on stay invite-only, off stays accounts", async () => {
    await start({ inviteOnly: true });
    expect((await serverInfo()).accessPolicy).toBe("invite_only");
    await server!.stop();
    await start();
    expect((await serverInfo()).accessPolicy).toBe("account_required");
  });

  it("starts with the rule it is given, which outranks invites alone", async () => {
    await start({ inviteOnly: true, accessPolicy: "guest_allowed" });
    expect(await serverInfo()).toMatchObject({ accessPolicy: "guest_allowed" });
    await expect(
      createWorkspaceServer({
        dataDir: ":memory:",
        port: 0,
        mdns: false,
        logger: false,
        accessPolicy: "everyone" as never,
      }),
    ).rejects.toThrow(/accessPolicy must be one of/);
  });

  it("lets no guest in until the host allows guests, nor before there is an owner", async () => {
    await start();
    server!.setAccessPolicy("guest_allowed");
    const unclaimed = await call("POST", "/api/auth/guest", undefined, { displayName: "Early" });
    expect([unclaimed.status, unclaimed.data.error]).toEqual([403, "workspace_unclaimed"]);
    await register("owner");
    server!.setAccessPolicy("account_required");
    const refused = await call("POST", "/api/auth/guest", undefined, { displayName: "Visitor" });
    expect([refused.status, refused.data.error]).toEqual([403, "guest_access_off"]);
    server!.setAccessPolicy("guest_allowed");
    expect((await serverInfo()).accessPolicy).toBe("guest_allowed");
    expect((await joinAsGuest()).user.role).toBe("guest");
  });

  it("keeps accounts open alongside guests, and invites off never lets guests in", async () => {
    await start({ inviteOnly: true });
    await register("owner");
    server!.setInviteOnly(false);
    expect((await serverInfo()).accessPolicy).toBe("account_required");
    server!.setAccessPolicy("guest_allowed");
    expect((await serverInfo()).requiresInvite).toBe(false);
    await register("member");
    // A host that knows only about invites, turning them off again, keeps guests.
    server!.setInviteOnly(false);
    expect((await serverInfo()).accessPolicy).toBe("guest_allowed");
    server!.setInviteOnly(true);
    expect(await serverInfo()).toMatchObject({ accessPolicy: "invite_only", requiresInvite: true });
  });
});

describe("a guest", () => {
  it("joins with a display name, lands in #general, and talks there", async () => {
    const { owner, general } = await guestWorkspace();
    const guest = await joinAsGuest("Visiting Vic");
    expect(guest.user).toMatchObject({ role: "guest", displayName: "Visiting Vic" });
    const sent = await call("POST", `/api/channels/${general}/messages`, guest.token, {
      text: "hello from a guest",
    });
    expect(sent.status).toBe(201);
    const read = await call("GET", `/api/channels/${general}/messages`, owner.token);
    expect(read.data.messages.map((m: { text: string }) => m.text)).toContain("hello from a guest");
    const reacted = await call(
      "PUT",
      `/api/messages/${sent.data.message.id}/reactions/${encodeURIComponent("👍")}`,
      guest.token,
    );
    expect(reacted.status).toBe(200);
  });

  it("never sees a private channel or a DM, even asking for one directly", async () => {
    const { owner, general } = await guestWorkspace();
    const member = await register("member");
    const room = (
      await call("POST", "/api/channels", owner.token, {
        type: "private",
        name: "secret",
        memberIds: [member.user.id],
      })
    ).data.channel;
    await call("POST", `/api/channels/${room.id}/messages`, owner.token, { text: "quietzebra" });
    const dm = (
      await call("POST", "/api/channels", owner.token, { type: "dm", memberIds: [member.user.id] })
    ).data.channel;
    await call("POST", `/api/channels/${dm.id}/messages`, owner.token, { text: "quietzebra dm" });
    const guest = await joinAsGuest();

    const listed = (await call("GET", "/api/channels", guest.token)).data.channels;
    expect(listed.map((c: { id: string }) => c.id)).toEqual([general]);
    for (const id of [room.id, dm.id]) {
      const read = await call("GET", `/api/channels/${id}/messages`, guest.token);
      expect(read.status).toBe(404);
    }
    const found = await call("GET", "/api/search?q=quietzebra", guest.token);
    expect([found.status, found.data.messages]).toEqual([200, []]);
    // Where the owner, who can read both, finds them.
    const theirs = await call("GET", "/api/search?q=quietzebra", owner.token);
    expect(theirs.data.messages).toHaveLength(2);
    const socket = await connect(guest.token);
    const snapshot = JSON.stringify(socket.frames);
    expect(snapshot).not.toContain(room.id);
    expect(snapshot).not.toContain(dm.id);
  });

  it("cannot be put in a private channel or a DM by anyone else", async () => {
    const { owner } = await guestWorkspace();
    const guest = await joinAsGuest();
    const dm = await call("POST", "/api/channels", owner.token, {
      type: "dm",
      memberIds: [guest.user.id],
    });
    expect([dm.status, dm.data.error]).toEqual([403, "guest_restricted"]);
    const room = await call("POST", "/api/channels", owner.token, {
      type: "private",
      name: "secret",
      memberIds: [guest.user.id],
    });
    expect([room.status, room.data.error]).toEqual([403, "guest_restricted"]);
    const made = (
      await call("POST", "/api/channels", owner.token, { type: "private", name: "inner" })
    ).data.channel;
    const invited = await call("POST", `/api/channels/${made.id}/invite-member`, owner.token, {
      userId: guest.user.id,
    });
    expect([invited.status, invited.data.error]).toEqual([403, "guest_restricted"]);
    const befriended = await call("POST", `/api/friends/${guest.user.id}`, owner.token);
    expect([befriended.status, befriended.data.error]).toEqual([403, "guest_restricted"]);
  });

  it("is refused everything outside public channels, through the API directly", async () => {
    const { general } = await guestWorkspace();
    const guest = await joinAsGuest();
    for (const [method, path, body] of [
      ["POST", "/api/channels", { type: "public", name: "guestroom" }],
      ["POST", "/api/channels", { type: "dm", memberIds: [] }],
      ["POST", "/api/invites", {}],
      ["POST", `/api/channels/${general}/scheduled`, { text: "later", sendAt: Date.now() + 1e6 }],
      ["POST", `/api/channels/${general}/commands`, { command: "shrug", text: "" }],
      ["POST", "/api/apps", { name: "bot" }],
      ["POST", "/api/auth/password", { currentPassword: "x", newPassword: "password123" }],
      ["GET", "/api/auth/sessions", undefined],
      ["PATCH", `/api/channels/${general}`, { topic: "mine now" }],
    ] as const) {
      const refused = await call(method, path, guest.token, body);
      expect([path, refused.status, refused.data.error]).toEqual([path, 403, "guest_not_allowed"]);
    }
  });

  it("cannot sign in with a password, and the admin cannot make one a member", async () => {
    const { owner } = await guestWorkspace();
    const guest = await joinAsGuest();
    const login = await call("POST", "/api/auth/login", undefined, {
      handle: guest.user.handle,
      password: "",
    });
    expect(login.status).toBe(400);
    const guessed = await call("POST", "/api/auth/login", undefined, {
      handle: guest.user.handle,
      password: "anything",
    });
    expect(guessed.status).toBe(401);
    const promoted = await call("PATCH", `/api/admin/users/${guest.user.id}`, owner.token, {
      role: "member",
    });
    expect([promoted.status, promoted.data.error]).toEqual([400, "guest_account"]);
    const reset = await call("POST", `/api/admin/users/${guest.user.id}/password`, owner.token);
    expect([reset.status, reset.data.error]).toEqual([400, "guest_account"]);
    // Removing a guest is ordinary moderation.
    const removed = await call("PATCH", `/api/admin/users/${guest.user.id}`, owner.token, {
      deactivated: true,
    });
    expect(removed.status).toBe(200);
    expect((await call("GET", "/api/me", guest.token)).status).toBe(401);
  });

  it("has a day, not a sliding month, however much it is used", async () => {
    await guestWorkspace();
    const guest = await joinAsGuest();
    const expiry = () => server!.store.listSessions(guest.user.id)[0]!;
    const before = expiry();
    expect(before.expiresAt - before.createdAt).toBe(GUEST_SESSION_TTL_MS);
    await new Promise((r) => setTimeout(r, 5));
    expect((await call("GET", "/api/me", guest.token)).status).toBe(200);
    expect(expiry()).toMatchObject({ expiresAt: before.expiresAt });
    expect(expiry().lastSeenAt).toBeGreaterThan(before.lastSeenAt);
    // Past the day it is over.
    const { db } = server!.store as unknown as { db: import("node:sqlite").DatabaseSync };
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(
      Date.now() - 1,
      hashToken(guest.token),
    );
    expect((await call("GET", "/api/me", guest.token)).status).toBe(401);
  });

  it("is signed out at once, sockets too, when the host stops allowing guests", async () => {
    const { owner, general } = await guestWorkspace();
    const guest = await joinAsGuest();
    const socket = await connect(guest.token);
    server!.setAccessPolicy("account_required");
    expect((await call("GET", "/api/me", guest.token)).status).toBe(401);
    await expect.poll(socket.closed).not.toBeNull();
    // Accounts carry on, and what the guest wrote stays.
    expect((await call("GET", `/api/channels/${general}/messages`, owner.token)).status).toBe(200);
  });

  it("keeps its identity, messages and rooms by creating an account", async () => {
    const { owner, general } = await guestWorkspace();
    const guest = await joinAsGuest("Vic");
    const sent = (
      await call("POST", `/api/channels/${general}/messages`, guest.token, { text: "mine" })
    ).data.message;
    const taken = await call("POST", "/api/auth/guest/account", guest.token, {
      handle: "owner",
      password: "password123",
    });
    expect([taken.status, taken.data.error]).toEqual([409, "handle_taken"]);
    const made = await call("POST", "/api/auth/guest/account", guest.token, {
      handle: "vic",
      password: "password123",
    });
    expect(made.status).toBe(200);
    expect(made.data.user).toMatchObject({ id: guest.user.id, handle: "vic", role: "member" });
    expect((await call("GET", "/api/me", guest.token)).status).toBe(401);
    const login = await call("POST", "/api/auth/login", undefined, {
      handle: "vic",
      password: "password123",
    });
    expect(login.data.user.id).toBe(guest.user.id);
    const messages = (await call("GET", `/api/channels/${general}/messages`, owner.token)).data
      .messages as { id: string; userId: string }[];
    expect(messages.find((m) => m.id === sent.id)?.userId).toBe(guest.user.id);
    // Now an ordinary member: it can open a DM.
    const dm = await call("POST", "/api/channels", made.data.token, {
      type: "dm",
      memberIds: [owner.user.id],
    });
    expect(dm.status).toBe(201);
  });
});

describe("the routes open to guests", () => {
  it("each name a route the server has", () => {
    const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const routes = new Set(
      [...source.matchAll(/app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*"([^"]+)"/g)].map(
        ([, method, url]) => `${method!.toUpperCase()} ${url}`,
      ),
    );
    expect([...GUEST_ROUTES].filter((route) => !routes.has(route))).toEqual([]);
  });
});
