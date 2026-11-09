import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Who may manage a room, over HTTP, for every kind of person: the room's
 * creator, a manager, a workspace admin, the owner, a plain member and a
 * former member. The protocol's permission functions decide; this holds the
 * routes to them.
 */
type Person = { token: string; id: string };

let server: WorkspaceServer;
let base: string;
let owner: Person;
let admin: Person;
let creator: Person;
let manager: Person;
let member: Person;
let former: Person;
let target: Person;
let guest: Person;
let roomId: string;

async function request(path: string, token: string, method = "POST", body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}

async function register(handle: string): Promise<Person> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  const data = (await res.json()) as any;
  return { token: data.token, id: data.user.id };
}

const ok = async (call: Promise<{ status: number; data: unknown }>) => {
  const result = await call;
  expect(result.status, JSON.stringify(result.data)).toBe(200);
};

const invite = (roomId: string, who: Person, by = owner) =>
  request(`/api/channels/${roomId}/invite-member`, by.token, "POST", { userId: who.id });
const remove = (roomId: string, who: Person, by: Person) =>
  request(`/api/channels/${roomId}/members/${who.id}`, by.token, "DELETE");
const setManager = (roomId: string, who: Person, manager: boolean, by: Person) =>
  request(`/api/channels/${roomId}/managers/${who.id}`, by.token, "PATCH", { manager });

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  owner = await register("owner");
  admin = await register("admin");
  creator = await register("creator");
  manager = await register("manager");
  member = await register("member");
  former = await register("former");
  target = await register("target");
  guest = await register("guest");
  await ok(request(`/api/admin/users/${admin.id}`, owner.token, "PATCH", { role: "admin" }));

  const room = await request("/api/channels", creator.token, "POST", {
    type: "public",
    name: "project",
  });
  expect(room.status).toBe(201);
  roomId = room.data.channel.id;
  for (const who of [manager, member, former, target]) await ok(invite(roomId, who, creator));
  await ok(setManager(roomId, manager, true, creator));
  await ok(request(`/api/channels/${roomId}/leave`, former.token));
});

afterEach(async () => {
  await server.stop();
});

/** Each action, and how to undo it when it was allowed, so the next person starts from the same room. */
const actions: Record<
  string,
  { attempt: (by: Person) => Promise<{ status: number }>; undo: () => Promise<void> }
> = {
  "edit the room": {
    attempt: (by) => request(`/api/channels/${roomId}`, by.token, "PATCH", { topic: "Plans" }),
    undo: async () => {},
  },
  "invite someone": {
    attempt: (by) => invite(roomId, guest, by),
    undo: () => ok(remove(roomId, guest, owner)),
  },
  "make a member a manager": {
    attempt: (by) => setManager(roomId, target, true, by),
    undo: () => ok(setManager(roomId, target, false, owner)),
  },
  "remove a member": {
    attempt: (by) => remove(roomId, target, by),
    undo: () => ok(invite(roomId, target)),
  },
  "remove a manager": {
    attempt: (by) => remove(roomId, manager, by),
    undo: async () => {
      await ok(invite(roomId, manager));
      await ok(setManager(roomId, manager, true, owner));
    },
  },
};

/** Who may do each, in a public room. Admins and the owner need not be members. */
const allowed: Record<string, string[]> = {
  "edit the room": ["creator", "manager", "admin", "owner"],
  "invite someone": ["creator", "manager", "member", "admin", "owner"],
  "make a member a manager": ["creator", "admin", "owner"],
  "remove a member": ["creator", "manager", "admin", "owner"],
  "remove a manager": ["creator", "admin", "owner"],
};

describe("managing a public room", () => {
  it("allows each action to exactly the people who should have it", async () => {
    const people: Record<string, Person> = { creator, manager, member, admin, owner, former };
    const outcome: Record<string, string[]> = {};
    for (const [name, action] of Object.entries(actions)) {
      outcome[name] = [];
      for (const [who, person] of Object.entries(people)) {
        const { status } = await action.attempt(person);
        expect([200, 403], `${who}: ${name}`).toContain(status);
        if (status === 200) {
          outcome[name]!.push(who);
          await action.undo();
        }
      }
    }
    expect(outcome).toEqual(allowed);
  });

  it("lets only the owner remove an admin, and nobody remove the owner or themselves this way", async () => {
    await ok(invite(roomId, admin));
    await ok(invite(roomId, owner));
    expect((await remove(roomId, admin, creator)).status).toBe(403);
    expect((await remove(roomId, owner, admin)).status).toBe(403);
    expect((await remove(roomId, creator, creator)).status).toBe(403);
    expect((await remove(roomId, manager, manager)).status).toBe(403);
    await ok(remove(roomId, admin, owner));
  });

  it("protects the creator from managers, but not from administrators", async () => {
    expect((await remove(roomId, creator, manager)).status).toBe(403);
    expect((await setManager(roomId, creator, false, admin)).status).toBe(403);
    await ok(remove(roomId, creator, admin));
  });

  it("takes a creator's powers away when they leave, and gives none back to a former manager", async () => {
    await ok(request(`/api/channels/${roomId}/leave`, creator.token));
    expect(
      (await request(`/api/channels/${roomId}`, creator.token, "PATCH", { topic: "Mine" })).status,
    ).toBe(403);
    expect((await setManager(roomId, target, true, creator)).status).toBe(403);

    // A manager who leaves is no longer one, and does not become one by rejoining.
    await ok(request(`/api/channels/${roomId}/leave`, manager.token));
    await ok(request(`/api/channels/${roomId}/join`, manager.token));
    expect(
      (await request(`/api/channels/${roomId}`, manager.token, "PATCH", { topic: "Back" })).status,
    ).toBe(403);
    expect(server.store.channels.get(roomId)!.managerIds ?? []).not.toContain(manager.id);
  });

  it("makes only active members managers, never the owner, an admin or someone outside", async () => {
    expect((await setManager(roomId, owner, true, owner)).status).toBe(403);
    await ok(invite(roomId, admin));
    expect((await setManager(roomId, admin, true, owner)).status).toBe(403);
    // Someone not in the room has to be invited first. A public room takes in
    // everyone when it is made, so this one leaves it to be outside.
    await ok(request(`/api/channels/${roomId}/leave`, guest.token));
    const outside = await setManager(roomId, guest, true, creator);
    expect(outside.status).toBe(409);
    expect(outside.data.error).toBe("channel_membership_required");
    await ok(request(`/api/admin/users/${target.id}`, owner.token, "PATCH", { deactivated: true }));
    expect((await setManager(roomId, target, true, creator)).status).toBe(403);
  });
});

describe("managing a private room", () => {
  it("gives administrators and former members nothing, since they cannot see it", async () => {
    const room = await request("/api/channels", creator.token, "POST", {
      type: "private",
      name: "leads",
      memberIds: [manager.id, member.id, former.id, target.id],
    });
    const privateId = room.data.channel.id as string;
    await ok(setManager(privateId, manager, true, creator));
    await ok(request(`/api/channels/${privateId}/leave`, former.token));

    for (const outsider of [admin, owner, former]) {
      expect(
        (await request(`/api/channels/${privateId}`, outsider.token, "PATCH", { topic: "In" }))
          .status,
      ).toBe(404);
      expect((await remove(privateId, target, outsider)).status).toBe(404);
      expect((await invite(privateId, guest, outsider)).status).toBe(404);
    }
    // Inside it, the same rules hold as in a public room.
    await ok(request(`/api/channels/${privateId}`, manager.token, "PATCH", { topic: "In" }));
    expect((await setManager(privateId, target, true, manager)).status).toBe(403);
    expect((await remove(privateId, target, member)).status).toBe(403);
    await ok(remove(privateId, target, manager));
  });
});
