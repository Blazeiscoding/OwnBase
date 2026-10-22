import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  SIDEBAR_SECTIONS_MAX,
  type ServerToClient,
  type SidebarSection,
} from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Sidebar sections (E8): one account's own, named, in its order, holding
 * conversations it moves in, kept on the server and told to its devices.
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
/** The section lists this socket was told, oldest first. */
const told = (frames: ServerToClient[]) =>
  frames.flatMap((f) =>
    f.type === "ephemeral" && f.event.type === "sidebar.sections" ? [f.event.sections] : [],
  );
const prefsTold = (frames: ServerToClient[]) =>
  frames.flatMap((f) => (f.type === "ephemeral" && f.event.type === "prefs" ? [f.event] : []));

const create = async (name: string, auth = owner.token) =>
  request("/api/sidebar-sections", { name }, "POST", auth);
const made = async (name: string, auth = owner.token) => {
  const answer = await create(name, auth);
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.section as SidebarSection;
};
const prefs = (channelId: string, patch: Record<string, unknown>, auth = owner.token) =>
  request(`/api/channels/${channelId}/prefs`, patch, "PATCH", auth);
const names = (sections: SidebarSection[]) => sections.map((s) => s.name);

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "slackoss-sections-"));
  await start();
  owner = await register("owner");
  peer = await register("peer");
  general = server!.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the section list", () => {
  it("starts empty, and says so in the snapshot", async () => {
    expect(ready(await connect(owner.token)).sidebarSections).toEqual([]);
  });

  it("adds each new section last, named as typed once trimmed, told to the account alone", async () => {
    const mine = await connect(owner.token);
    const theirs = await connect(peer.token);
    const first = await made("  Projects  ");
    expect(first).toEqual({ id: expect.any(String), name: "Projects" });
    const second = await create("Clients");
    expect(second.status).toBe(201);
    expect(names(second.body.sections)).toEqual(["Projects", "Clients"]);
    await expect.poll(() => told(mine).length).toBe(2);
    expect(names(told(mine).at(-1)!)).toEqual(["Projects", "Clients"]);
    expect(told(theirs)).toEqual([]);
    expect(ready(await connect(peer.token)).sidebarSections).toEqual([]);
  });

  it("needs a name of 1 to 80 characters without control characters", async () => {
    expect((await create("   ")).status).toBe(400);
    expect((await create("a".repeat(81))).status).toBe(400);
    expect((await create("Line\nbreak")).status).toBe(400);
    expect((await create("a".repeat(80))).status).toBe(201);
  });

  it(`keeps at most ${SIDEBAR_SECTIONS_MAX}`, async () => {
    for (let i = 0; i < SIDEBAR_SECTIONS_MAX; i++)
      server!.store.createSidebarSection(owner.id, `Section ${i}`);
    const refused = await create("One more");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("too_many_sections");
  });

  it("renames and reorders only the account's own", async () => {
    const mine = await connect(owner.token);
    const a = await made("Alpha");
    const b = await made("Beta");
    const c = await made("Gamma");

    const renamed = await request(`/api/sidebar-sections/${b.id}`, { name: "Bravo" }, "PATCH");
    expect(renamed.status).toBe(200);
    expect(names(renamed.body.sections)).toEqual(["Alpha", "Bravo", "Gamma"]);
    expect(
      (await request(`/api/sidebar-sections/${b.id}`, { name: "Mine now" }, "PATCH", peer.token))
        .status,
    ).toBe(404);

    const ordered = await request(
      "/api/sidebar-sections/order",
      { ids: [c.id, a.id, b.id] },
      "PUT",
    );
    expect(ordered.status).toBe(200);
    expect(names(ordered.body.sections)).toEqual(["Gamma", "Alpha", "Bravo"]);
    await expect.poll(() => names(told(mine).at(-1) ?? [])).toEqual(["Gamma", "Alpha", "Bravo"]);
    // Not every one, one twice, or someone else's: the list has changed meanwhile.
    for (const ids of [
      [c.id, a.id],
      [c.id, a.id, a.id],
      [c.id, a.id, "S_OTHER"],
    ])
      expect((await request("/api/sidebar-sections/order", { ids }, "PUT")).status).toBe(409);
    expect(
      (await request("/api/sidebar-sections/order", { ids: [c.id, a.id, b.id] }, "PUT", peer.token))
        .status,
    ).toBe(409);
  });

  it("is kept across a restart, in its order", async () => {
    const a = await made("Alpha");
    const b = await made("Beta");
    await request("/api/sidebar-sections/order", { ids: [b.id, a.id] }, "PUT");
    await prefs(general, { sectionId: a.id });
    await stop();
    await start();
    const snapshot = ready(await connect(owner.token));
    expect(names(snapshot.sidebarSections)).toEqual(["Beta", "Alpha"]);
    expect(
      snapshot.memberships.find((m: { channelId: string }) => m.channelId === general).prefs
        .sectionId,
    ).toBe(a.id);
  });
});

describe("a conversation in a section", () => {
  it("is moved in with its prefs, out of Starred, and out again by a star", async () => {
    const mine = await connect(owner.token);
    const work = await made("Work");
    expect((await prefs(general, { starred: true })).body.prefs.starred).toBe(true);

    const moved = await prefs(general, { sectionId: work.id });
    expect(moved.status).toBe(200);
    // One place each: a section takes its star.
    expect(moved.body.prefs).toMatchObject({ sectionId: work.id, starred: false });
    await expect
      .poll(() => prefsTold(mine).at(-1))
      .toMatchObject({ channelId: general, prefs: { sectionId: work.id } });

    // And a star takes it out of its section.
    const starred = await prefs(general, { starred: true });
    expect(starred.body.prefs).toMatchObject({ starred: true, sectionId: null });
    // Taken out without a star, it goes back to Channels.
    await prefs(general, { sectionId: work.id });
    expect((await prefs(general, { sectionId: null })).body.prefs).toMatchObject({
      sectionId: null,
      starred: false,
    });
  });

  it("can only go into the account's own section", async () => {
    const theirs = await made("Theirs", peer.token);
    const refused = await prefs(general, { sectionId: theirs.id });
    expect(refused.status).toBe(404);
    expect(refused.body.error).toBe("section_not_found");
    expect((await prefs(general, { sectionId: "S_MISSING" })).status).toBe(404);
  });

  it("goes back where it was when its section is deleted, and devices are told", async () => {
    const mine = await connect(owner.token);
    const work = await made("Work");
    const keep = await made("Keep");
    const design = (await request("/api/channels", { type: "public", name: "design" })).body.channel
      .id as string;
    await prefs(general, { sectionId: work.id });
    await prefs(design, { sectionId: keep.id });

    expect(
      (await request(`/api/sidebar-sections/${work.id}`, undefined, "DELETE", peer.token)).status,
    ).toBe(404);
    const deleted = await request(`/api/sidebar-sections/${work.id}`, undefined, "DELETE");
    expect(deleted.status).toBe(200);
    expect(names(deleted.body.sections)).toEqual(["Keep"]);
    await expect
      .poll(() => prefsTold(mine).at(-1))
      .toMatchObject({ channelId: general, prefs: { sectionId: null } });
    await expect.poll(() => names(told(mine).at(-1) ?? [])).toEqual(["Keep"]);
    expect(server!.store.getChannelPrefs(general, owner.id)!.sectionId).toBeNull();
    // The other section keeps its own.
    expect(server!.store.getChannelPrefs(design, owner.id)!.sectionId).toBe(keep.id);
    expect((await request(`/api/sidebar-sections/${work.id}`, undefined, "DELETE")).status).toBe(
      404,
    );
  });

  it("loses its place when the account leaves, and comes back without one", async () => {
    const design = (
      await request("/api/channels", { type: "public", name: "design" }, "POST", peer.token)
    ).body.channel.id as string;
    await request(`/api/channels/${design}/join`, {});
    const work = await made("Work");
    await prefs(design, { sectionId: work.id });
    expect((await request(`/api/channels/${design}/leave`, {})).status).toBe(200);
    await request(`/api/channels/${design}/join`, {});
    expect(server!.store.getChannelPrefs(design, owner.id)!.sectionId).toBeNull();
  });
});

describe("a guest", () => {
  it("keeps sections too, as they keep stars", async () => {
    server!.setAccessPolicy("guest_allowed");
    const joined = await fetch(`${base}/api/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Visitor" }),
    });
    const guest = (await joined.json()) as { token: string };
    const section = await made("Reading", guest.token);
    await request(`/api/channels/${general}/join`, {}, "POST", guest.token);
    const moved = await prefs(general, { sectionId: section.id }, guest.token);
    expect(moved.status).toBe(200);
    expect(moved.body.prefs.sectionId).toBe(section.id);
  });
});
