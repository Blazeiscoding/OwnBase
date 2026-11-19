import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  APP_SCOPES,
  PROTOCOL_VERSION,
  type Message,
  type ServerToClient,
  type UserGroup,
} from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * User groups (J13): admins make them; mentioning one names each of its
 * people who is in the conversation and active, through the same mention
 * rows a person's mention writes, so counts, Activity and pushes follow.
 */
type Person = { token: string; user: { id: string } };
let server: WorkspaceServer;
let base: string;
let owner: Person;
let alice: Person;
let bob: Person;
let general: string;
const sockets: WebSocket[] = [];

async function request(path: string, token: string | null, body?: unknown, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as any };
}

async function register(handle: string): Promise<Person> {
  const made = await request("/api/auth/register", null, {
    handle,
    displayName: handle,
    password: "password123",
  });
  expect(made.status).toBe(201);
  return made.data;
}

async function joinAsGuest(): Promise<Person> {
  server.setAccessPolicy("guest_allowed");
  const joined = await request("/api/auth/guest", null, { displayName: "Visitor" });
  return joined.data;
}

async function connect(person: Person) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerToClient));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        type: "hello",
        token: person.token,
        lastSeq: null,
        protocolVersion: PROTOCOL_VERSION,
      }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  const settle = async () => {
    const from = frames.length;
    ws.send(JSON.stringify({ type: "ping" }));
    await expect.poll(() => frames.slice(from).some((f) => f.type === "pong")).toBe(true);
  };
  return { frames, settle };
}

const readyOf = (frames: ServerToClient[]) =>
  frames.find((f): f is Extract<ServerToClient, { type: "ready" }> => f.type === "ready")!;

async function makeGroup(handle: string, memberIds: string[], token = owner.token) {
  const made = await request("/api/admin/groups", token, { handle, name: handle, memberIds });
  expect(made.status).toBe(201);
  return made.data.group as UserGroup;
}

const mention = (group: UserGroup) => `<!subteam^${group.id}|@${group.handle}>`;

async function post(text: string, token = owner.token, channelId = general, extra = {}) {
  const sent = await request(`/api/channels/${channelId}/messages`, token, { text, ...extra });
  expect(sent.status).toBe(201);
  return sent.data.message as Message;
}

/** Mention rows naming someone, wherever they are. */
const rowsFor = (person: Person) =>
  (
    server.store.db
      .prepare("SELECT COUNT(*) AS n FROM message_mentions WHERE user_id = ?")
      .get(person.user.id) as { n: number }
  ).n;

const counts = (person: Person) => server.store.channels.unreadMentionCounts(person.user.id);

async function activity(person: Person, mode: "mentions" | "unread" = "mentions") {
  const listed = await request(`/api/activity?mode=${mode}`, person.token, undefined, "GET");
  expect(listed.status).toBe(200);
  return (listed.data.messages as Message[]).map((m) => m.id);
}

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
  alice = await register("alice");
  bob = await register("bob");
  general = server.store.channels.byName("general")!.id;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.stop();
});

describe("managing user groups", () => {
  it("is for admins: made, renamed, given people and deleted, each audited", async () => {
    expect(
      (await request("/api/admin/groups", alice.token, { handle: "design", name: "Design" }))
        .status,
    ).toBe(403);
    const group = await makeGroup("design", [alice.user.id]);
    expect(group).toMatchObject({ handle: "design", name: "design", description: "" });
    expect(group.memberIds).toEqual([alice.user.id]);

    const changed = await request(
      `/api/admin/groups/${group.id}`,
      owner.token,
      { handle: "designers", memberIds: [alice.user.id, bob.user.id, bob.user.id] },
      "PATCH",
    );
    expect(changed.status).toBe(200);
    expect(changed.data.group.handle).toBe("designers");
    expect([...changed.data.group.memberIds].sort()).toEqual([alice.user.id, bob.user.id].sort());
    expect(
      (await request(`/api/admin/groups/${group.id}`, alice.token, { name: "Mine" }, "PATCH"))
        .status,
    ).toBe(403);

    expect(
      (await request(`/api/admin/groups/${group.id}`, owner.token, undefined, "DELETE")).status,
    ).toBe(200);
    expect(server.store.groups.get(group.id)).toBeNull();
    expect(
      (await request(`/api/admin/groups/${group.id}`, owner.token, { name: "x" }, "PATCH")).status,
    ).toBe(404);

    const audit = await request("/api/admin/audit", owner.token, undefined, "GET");
    expect(
      (audit.data.entries as { action: string; details: Record<string, unknown> }[])
        .filter((e) => e.action.startsWith("group."))
        .map((e) => [e.action, e.details]),
    ).toEqual([
      ["group.deleted", { handle: "designers", members: 2 }],
      ["group.updated", { handle: "designers", previousHandle: "design", added: 1 }],
      ["group.created", { handle: "design", name: "design", members: 1 }],
    ]);
  });

  it("holds people only, not apps or accounts that do not exist", async () => {
    const app = await request("/api/apps", owner.token, { name: "Helper", scopes: [] });
    for (const id of ["nobody", app.data.botUser.id as string]) {
      const refused = await request("/api/admin/groups", owner.token, {
        handle: "design",
        name: "Design",
        memberIds: [id],
      });
      expect(refused.status, id).toBe(400);
      expect(refused.data.error).toBe("invalid_group_member");
    }
  });

  it("is told to members but not to guests, and a guest's snapshot holds none", async () => {
    const group = await makeGroup("design", [alice.user.id]);
    const guest = await joinAsGuest();
    const member = await connect(alice);
    const visitor = await connect(guest);
    expect(readyOf(member.frames).userGroups).toEqual([group]);
    expect(readyOf(visitor.frames).userGroups).toEqual([]);

    await request(`/api/admin/groups/${group.id}`, owner.token, { name: "Designers" }, "PATCH");
    await member.settle();
    await visitor.settle();
    const told = (frames: ServerToClient[]) =>
      frames.flatMap((f) =>
        f.type === "ephemeral" && f.event.type.startsWith("userGroup.") ? [f.event] : [],
      );
    expect(told(member.frames)).toEqual([
      { type: "userGroup.saved", group: { ...group, name: "Designers" } },
    ]);
    expect(told(visitor.frames)).toEqual([]);
  });
});

describe("one name space for people and groups", () => {
  it("refuses a group a person's handle, another group's, or a word for the whole room", async () => {
    await makeGroup("design", []);
    for (const handle of ["alice", "design", "here", "channel", "everyone"]) {
      const refused = await request("/api/admin/groups", owner.token, { handle, name: "X" });
      expect(refused.status, handle).toBe(409);
      expect(refused.data.error).toBe("handle_taken");
    }
    const other = await makeGroup("writers", []);
    const renamed = await request(
      `/api/admin/groups/${other.id}`,
      owner.token,
      { handle: "bob" },
      "PATCH",
    );
    expect(renamed.status).toBe(409);
    // Its own handle is not taken from itself.
    expect(
      (await request(`/api/admin/groups/${other.id}`, owner.token, { handle: "writers" }, "PATCH"))
        .status,
    ).toBe(200);
  });

  it("refuses a person a group's handle or a word for the whole room", async () => {
    await makeGroup("design", []);
    for (const handle of ["design", "here"]) {
      const refused = await request("/api/auth/register", null, {
        handle,
        displayName: "New",
        password: "password123",
      });
      expect(refused.status, handle).toBe(409);
      expect(refused.data.error).toBe("handle_taken");
    }
  });

  it("gives an app's bot user a handle no group has", async () => {
    await makeGroup("helper-bot", []);
    const made = await request("/api/apps", owner.token, { name: "Helper", scopes: APP_SCOPES });
    expect(made.status).toBe(201);
    expect(made.data.botUser.handle).toBe("helper-bot-2");
  });
});

describe("mentioning a user group", () => {
  it("names its people in the channel, with a count and in Activity, and nobody else", async () => {
    const plans = await request("/api/channels", owner.token, { type: "private", name: "plans" });
    const plansId = plans.data.channel.id as string;
    await request(`/api/channels/${plansId}/invite-member`, owner.token, {
      userId: alice.user.id,
    });
    const group = await makeGroup("design", [alice.user.id, bob.user.id]);

    const sent = await post(`Review please ${mention(group)}`, owner.token, plansId);
    expect(counts(alice)).toEqual({ [plansId]: 1 });
    // Bob is in the group but not in #plans: no row, and he is not added.
    expect(counts(bob)).toEqual({});
    expect(server.store.channels.isMember(plansId, bob.user.id)).toBe(false);
    expect(rowsFor(bob)).toBe(0);
    expect(await activity(alice)).toEqual([sent.id]);
    expect(await activity(bob)).toEqual([]);
  });

  it("names nobody deactivated", async () => {
    const group = await makeGroup("design", [alice.user.id, bob.user.id]);
    expect(
      (
        await request(
          `/api/admin/users/${bob.user.id}`,
          owner.token,
          { deactivated: true },
          "PATCH",
        )
      ).status,
    ).toBe(200);
    await post(`hi ${mention(group)}`);
    expect(counts(alice)).toEqual({ [general]: 1 });
    expect(rowsFor(bob)).toBe(0);
  });

  it("names nobody when a guest writes it", async () => {
    const group = await makeGroup("design", [alice.user.id]);
    const guest = await joinAsGuest();
    await request(`/api/channels/${general}/invite-member`, owner.token, {
      userId: server.store.people.list().find((u) => u.role === "guest")!.id,
    });
    await post(`hi ${mention(group)}`, guest.token);
    expect(counts(alice)).toEqual({});
  });

  it("follows an edit, and keeps counts when the group changes afterwards", async () => {
    const group = await makeGroup("design", [alice.user.id, bob.user.id]);
    const first = await post(`one ${mention(group)}`);
    const second = await post(`two ${mention(group)}`);
    expect(counts(alice)).toEqual({ [general]: 2 });

    const edited = await request(
      `/api/messages/${first.id}`,
      owner.token,
      { text: "one, nobody", expectedText: first.text },
      "PATCH",
    );
    expect(edited.status).toBe(200);
    expect(counts(alice)).toEqual({ [general]: 1 });

    await request(
      `/api/admin/groups/${group.id}`,
      owner.token,
      { memberIds: [alice.user.id] },
      "PATCH",
    );
    // Bob was named when it was sent; leaving the group later leaves that be.
    expect(counts(bob)).toEqual({ [general]: 1 });
    expect(await activity(bob)).toEqual([second.id]);
  });

  it("tells the people it names that their counts changed", async () => {
    const group = await makeGroup("design", [alice.user.id]);
    const socket = await connect(alice);
    await post(`hi ${mention(group)}`);
    await socket.settle();
    expect(
      socket.frames.flatMap((f) =>
        f.type === "ephemeral" && f.event.type === "mentions" ? [f.event.counts] : [],
      ),
    ).toEqual([{ [general]: 1 }]);
  });

  it("counts in a thread reply as a person's mention does there", async () => {
    const group = await makeGroup("design", [alice.user.id]);
    const root = await post("a thread");
    const reply = await post(`in here ${mention(group)}`, owner.token, general, {
      threadRootId: root.id,
    });
    const person = await post(`and <@${bob.user.id}>`, owner.token, general, {
      threadRootId: root.id,
    });
    expect(counts(alice)).toEqual({ [general]: 1 });
    expect(counts(bob)).toEqual({ [general]: 1 });
    // A reply in a thread Alice does not follow is in her unread list because it names her.
    expect(await activity(alice, "unread")).toContain(reply.id);
    expect(await activity(bob, "unread")).toContain(person.id);
  });

  it("follows the same rules in an app's message", async () => {
    const group = await makeGroup("design", [alice.user.id]);
    const made = await request("/api/apps", owner.token, { name: "Helper", scopes: APP_SCOPES });
    const posted = await request("/api/chat.postMessage", made.data.token, {
      channel: general,
      text: `Deploy done ${mention(group)}`,
    });
    expect(posted.data.ok).toBe(true);
    expect(counts(alice)).toEqual({ [general]: 1 });
  });

  it("is a mention for anyone who could write one without a label", async () => {
    const group = await makeGroup("design", [alice.user.id]);
    await post(`hi <!subteam^${group.id}>`);
    expect(counts(alice)).toEqual({ [general]: 1 });
  });
});
