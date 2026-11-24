import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import { SearchStore } from "../src/search/store.js";

/**
 * Activity's Reactions tab (K13): other people's reactions to your messages,
 * one entry per message and emoji, new until seen, told to your devices as
 * they come.
 */
describe("reactions to your messages, over the API", () => {
  let server: WorkspaceServer | undefined;
  let dataDir: string;
  let base: string;
  type Person = { token: string; id: string };
  let maya: Person;
  let sam: Person;
  let priya: Person;
  const sockets: WebSocket[] = [];

  async function request(auth: string, path: string, body?: unknown, method = "POST") {
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

  async function register(handle: string): Promise<Person> {
    const made = await request(
      "",
      "/api/auth/register",
      { handle, displayName: handle[0]!.toUpperCase() + handle.slice(1), password: "password123" },
      "POST",
    );
    return { token: made.body.token, id: made.body.user.id };
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
  const told = (frames: ServerToClient[]) =>
    frames.flatMap((f) =>
      f.type === "ephemeral" &&
      (f.event.type === "reactions.changed" || f.event.type === "reactions.seen")
        ? [f.event]
        : [],
    );

  async function channel(name: string, type: "public" | "private" = "public") {
    const made = (await request(maya.token, "/api/channels", { type, name })).body.channel;
    for (const who of [sam, priya])
      if (type === "public") await request(who.token, `/api/channels/${made.id}/join`, {});
      else await request(maya.token, `/api/channels/${made.id}/invite-member`, { userId: who.id });
    return made.id as string;
  }
  async function say(who: Person, channelId: string, text: string) {
    const sent = await request(who.token, `/api/channels/${channelId}/messages`, { text });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    return sent.body.message.id as string;
  }
  const react = (who: Person, messageId: string, emoji: string, method = "PUT") =>
    request(
      who.token,
      `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      undefined,
      method,
    );
  const list = async (who: Person, query = "") => {
    const got = await request(who.token, `/api/activity/reactions${query}`, undefined, "GET");
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    return got.body as {
      reactions: {
        message: { id: string; text: string };
        emoji: string;
        userIds: string[];
        count: number;
        at: number;
      }[];
      nextCursor: string | null;
      seenAt: number;
      unseen: number;
    };
  };
  const brief = (page: Awaited<ReturnType<typeof list>>) =>
    page.reactions.map((r) => [r.message.text, r.emoji, r.userIds, r.count]);

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "ownbase-reaction-activity-"));
    server = await createWorkspaceServer({ dataDir, host: "127.0.0.1", port: 0, mdns: false });
    base = `http://127.0.0.1:${server.port}`;
    maya = await register("maya");
    sam = await register("sam");
    priya = await register("priya");
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await server?.stop();
    server = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("lists others' reactions to my messages, grouped per message and emoji, newest first", async () => {
    const design = await channel("design");
    const first = await say(maya, design, "First draft");
    const second = await say(maya, design, "Second draft");
    const samsOwn = await say(sam, design, "Sam's note");
    await react(sam, first, "🎉");
    await react(priya, first, "🎉");
    await react(maya, first, "🎉"); // my own never shows
    await react(sam, second, "👀");
    await react(maya, samsOwn, "👍");

    expect(brief(await list(maya))).toEqual([
      ["Second draft", "👀", [sam.id], 1],
      ["First draft", "🎉", [priya.id, sam.id], 2],
    ]);
    // Sam's list has my reaction to his message, not his own to mine.
    expect(brief(await list(sam))).toEqual([["Sam's note", "👍", [maya.id], 1]]);
  });

  it("drops a reaction taken back, and the entry with its last one", async () => {
    const design = await channel("design");
    const draft = await say(maya, design, "Draft");
    await react(sam, draft, "🎉");
    await react(priya, draft, "🎉");
    await react(sam, draft, "🎉", "DELETE");
    expect(brief(await list(maya))).toEqual([["Draft", "🎉", [priya.id], 1]]);
    await react(priya, draft, "🎉", "DELETE");
    expect((await list(maya)).reactions).toEqual([]);
  });

  it("leaves out conversations I am no longer in, removed messages and people I blocked", async () => {
    const design = await channel("design");
    const plans = await channel("plans", "private");
    const kept = await say(maya, design, "Kept");
    const left = await say(maya, plans, "In plans");
    const removed = await say(maya, design, "Removed");
    await react(sam, kept, "🎉");
    await react(sam, left, "🎉");
    await react(sam, removed, "🎉");
    await react(priya, kept, "👀");
    await request(maya.token, `/api/channels/${plans}/leave`, {});
    await request(maya.token, `/api/messages/${removed}`, undefined, "DELETE");
    await request(maya.token, `/api/me/blocks/${priya.id}`, undefined, "PUT");
    expect(brief(await list(maya))).toEqual([["Kept", "🎉", [sam.id], 1]]);
  });

  it("is new until seen, on every device, and tells them as it comes", async () => {
    const design = await channel("design");
    const draft = await say(maya, design, "Draft");
    const phone = await connect(maya.token);
    expect(ready(phone)).toMatchObject({ unseenReactions: 0 });
    const samSees = await connect(sam.token);

    await react(sam, draft, "🎉");
    await expect.poll(() => told(phone)).toEqual([{ type: "reactions.changed", unseen: 1 }]);
    expect(told(samSees)).toEqual([]);
    const page = await list(maya);
    expect(page.unseen).toBe(1);
    expect(page.reactions[0]!.at).toBeGreaterThan(page.seenAt);

    // A second emoji on the same message is an entry of its own.
    await react(priya, draft, "👀");
    await expect.poll(() => told(phone).at(-1)).toEqual({ type: "reactions.changed", unseen: 2 });

    const newest = (await list(maya)).reactions[0]!.at;
    const seen = await request(maya.token, "/api/activity/reactions/seen", { upTo: newest });
    expect(seen.body).toEqual({ seenAt: newest, unseen: 0 });
    await expect
      .poll(() => told(phone).at(-1))
      .toEqual({ type: "reactions.seen", seenAt: newest, unseen: 0 });
    // A mark never moves back.
    await request(maya.token, "/api/activity/reactions/seen", { upTo: 1 });
    expect((await list(maya)).seenAt).toBe(newest);
    const later = await connect(maya.token);
    expect(ready(later)).toMatchObject({ reactionsSeenAt: newest, unseenReactions: 0 });

    // My own reaction tells me nothing.
    const before = told(phone).length;
    await react(maya, draft, "🔥");
    await say(maya, design, "Something else");
    expect(told(phone)).toHaveLength(before);
    const after = await list(maya);
    expect(after.unseen).toBe(0);
    expect(after.reactions.map((r) => r.emoji)).toEqual(["👀", "🎉"]);
  });

  it("reads a page at a time, with a cursor it can follow", async () => {
    const design = await channel("design");
    const drafts: string[] = [];
    for (let i = 0; i < 5; i++) drafts.push(await say(maya, design, `Draft ${i}`));
    for (const id of drafts) await react(sam, id, "🎉");
    const one = await list(maya, "?limit=2");
    expect(one.reactions.map((r) => r.message.text)).toEqual(["Draft 4", "Draft 3"]);
    const two = await list(maya, `?limit=2&cursor=${encodeURIComponent(one.nextCursor!)}`);
    expect(two.reactions.map((r) => r.message.text)).toEqual(["Draft 2", "Draft 1"]);
    const three = await list(maya, `?limit=2&cursor=${encodeURIComponent(two.nextCursor!)}`);
    expect(three.reactions.map((r) => r.message.text)).toEqual(["Draft 0"]);
    expect(three.nextCursor).toBeNull();
    const bad = await request(maya.token, "/api/activity/reactions?cursor=nope", undefined, "GET");
    expect(bad.status).toBe(400);
  });

  it("reads no further back than its window, so a busy channel cannot flood it", async () => {
    const design = await channel("design");
    const old = await say(maya, design, "Old");
    const recent = await say(maya, design, "Recent");
    await react(sam, old, "🎉");
    await react(priya, recent, "👀");
    const window = SearchStore.REACTIONS_WINDOW;
    SearchStore.REACTIONS_WINDOW = 1;
    try {
      expect(brief(await list(maya))).toEqual([["Recent", "👀", [priya.id], 1]]);
    } finally {
      SearchStore.REACTIONS_WINDOW = window;
    }
  });
});
