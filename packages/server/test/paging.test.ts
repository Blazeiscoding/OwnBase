import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Paging Saved, Pinned and Activity: every item exactly once when several
 * share a timestamp at a page boundary, and nothing from a room someone lost
 * between one page and the next.
 */
type Person = { token: string; id: string };

let server: WorkspaceServer;
let base: string;
let owner: Person;
let member: Person;
let general: string;

async function request(path: string, token: string, method = "GET", body?: unknown) {
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

const post = async (channelId: string, by: Person, text: string) =>
  (await request(`/api/channels/${channelId}/messages`, by.token, "POST", { text })).data
    .message as { id: string; text: string };

/** Follows `nextCursor` to the end, and returns every page's texts. */
async function everyPage(path: string, token: string, limit: number) {
  const pages: string[][] = [];
  let cursor: string | null = null;
  do {
    const query = `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const { status, data } = await request(`${path}?${query}`, token);
    expect(status).toBe(200);
    pages.push(data.messages.map((m: { text: string }) => m.text));
    cursor = data.nextCursor;
  } while (cursor && pages.length < 20);
  return pages;
}

/** Holds the clock still, so every save or pin in `during` gets the same time. */
async function atOneInstant<T>(during: () => Promise<T>): Promise<T> {
  const instant = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(instant);
  try {
    return await during();
  } finally {
    clock.mockRestore();
  }
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
  member = await register("member");
  general = server.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.stop();
});

describe("paging with tied timestamps", () => {
  it("lists every saved message once when they were all saved in the same millisecond", async () => {
    const posted: { id: string; text: string }[] = [];
    for (let i = 1; i <= 5; i++) posted.push(await post(general, owner, `Saved ${i}`));
    await atOneInstant(async () => {
      for (const message of posted)
        await request(`/api/messages/${message.id}/save`, member.token, "PUT");
    });

    const pages = await everyPage("/api/saved", member.token, 2);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    // With the time tied, the message ID decides, newest first.
    expect(pages.flat()).toEqual(
      [...posted].sort((a, b) => (a.id < b.id ? 1 : -1)).map((m) => m.text),
    );
  });

  it("lists every pin once when they were all pinned in the same millisecond", async () => {
    const posted: { id: string; text: string }[] = [];
    for (let i = 1; i <= 5; i++) posted.push(await post(general, owner, `Pinned ${i}`));
    await atOneInstant(async () => {
      for (const message of posted)
        await request(`/api/messages/${message.id}/pin`, owner.token, "PUT");
    });

    const pages = await everyPage(`/api/channels/${general}/pins`, member.token, 2);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(new Set(pages.flat()).size).toBe(5);
    expect(pages.flat().sort()).toEqual(posted.map((m) => m.text).sort());
  });

  it("says how many pins there are in all, on any page, without deleted messages", async () => {
    const posted: { id: string; text: string }[] = [];
    for (let i = 1; i <= 3; i++) posted.push(await post(general, owner, `Counted ${i}`));
    for (const message of posted)
      await request(`/api/messages/${message.id}/pin`, owner.token, "PUT");
    await request(`/api/messages/${posted[0]!.id}`, owner.token, "DELETE");

    const first = await request(`/api/channels/${general}/pins?limit=1`, member.token);
    expect(first.data.messages).toHaveLength(1);
    expect(first.data.total).toBe(2);
    const second = await request(
      `/api/channels/${general}/pins?limit=1&cursor=${encodeURIComponent(first.data.nextCursor)}`,
      member.token,
    );
    expect(second.data.total).toBe(2);
  });

  it("carries on from a cursor whose message was deleted after the page was read", async () => {
    const posted: { id: string; text: string }[] = [];
    for (let i = 1; i <= 4; i++) posted.push(await post(general, owner, `Kept ${i}`));
    await atOneInstant(async () => {
      for (const message of posted)
        await request(`/api/messages/${message.id}/save`, member.token, "PUT");
    });
    const first = await request("/api/saved?limit=2", member.token);
    const boundary = first.data.messages.at(-1).id as string;
    expect((await request(`/api/messages/${boundary}`, owner.token, "DELETE")).status).toBe(200);

    const second = await request(
      `/api/saved?limit=2&cursor=${encodeURIComponent(first.data.nextCursor)}`,
      member.token,
    );
    const seen = [...first.data.messages, ...second.data.messages].map((m: { id: string }) => m.id);
    expect(new Set(seen).size).toBe(4);
    expect(second.data.nextCursor).toBeNull();
  });
});

describe("paging after losing a room", () => {
  let room: string;
  beforeEach(async () => {
    room = (
      await request("/api/channels", owner.token, "POST", {
        type: "private",
        name: "leads",
        memberIds: [member.id],
      })
    ).data.channel.id;
  });

  it("drops a private room's saved messages from the pages after its member was removed", async () => {
    // Saved alternately, oldest first, so both rooms sit on both sides of the boundary.
    for (const [i, channel] of [general, room, general, room].entries()) {
      const message = await post(channel, owner, `${channel === room ? "Room" : "General"} ${i}`);
      await request(`/api/messages/${message.id}/save`, member.token, "PUT");
      await new Promise((r) => setTimeout(r, 2));
    }
    const first = await request("/api/saved?limit=2", member.token);
    expect(first.data.messages.map((m: { text: string }) => m.text)).toEqual([
      "Room 3",
      "General 2",
    ]);

    await request(`/api/channels/${room}/members/${member.id}`, owner.token, "DELETE");
    const second = await request(
      `/api/saved?limit=2&cursor=${encodeURIComponent(first.data.nextCursor)}`,
      member.token,
    );
    expect(second.data.messages.map((m: { text: string }) => m.text)).toEqual(["General 0"]);
    expect(second.data.nextCursor).toBeNull();
  });

  it("refuses the next page of a private room's pins to someone no longer in it", async () => {
    for (let i = 1; i <= 3; i++) {
      const message = await post(room, owner, `Pin ${i}`);
      await request(`/api/messages/${message.id}/pin`, owner.token, "PUT");
    }
    const first = await request(`/api/channels/${room}/pins?limit=2`, member.token);
    expect(first.data.nextCursor).not.toBeNull();
    await request(`/api/channels/${room}/leave`, member.token, "POST");
    const second = await request(
      `/api/channels/${room}/pins?limit=2&cursor=${encodeURIComponent(first.data.nextCursor)}`,
      member.token,
    );
    expect(second.status).toBe(404);
  });

  it("leaves a room's mentions out of Activity's next page once its member leaves", async () => {
    for (const [i, channel] of [room, general, room, general].entries()) {
      await post(channel, owner, `<@${member.id}> ${channel === room ? "room" : "general"} ${i}`);
    }
    const first = await request("/api/activity?mode=mentions&limit=2", member.token);
    expect(first.data.messages.map((m: { text: string }) => m.text)).toEqual([
      `<@${member.id}> general 3`,
      `<@${member.id}> room 2`,
    ]);
    await request(`/api/channels/${room}/leave`, member.token, "POST");
    const second = await request(
      `/api/activity?mode=mentions&limit=2&cursor=${first.data.nextCursor}`,
      member.token,
    );
    expect(second.data.messages.map((m: { text: string }) => m.text)).toEqual([
      `<@${member.id}> general 1`,
    ]);
    expect(second.data.nextCursor).toBeNull();
  });
});
