import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, UNSPACED_RANGES, type ServerToClient } from "@ownbase/protocol";
import { UNSPACED_RANGES as INDEX_UNSPACED } from "../src/search/words.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Keyword alerts (K11): each account's list, kept and told to its own
 * devices, and Activity's Mentions finding messages that hold one.
 */
let server: WorkspaceServer | undefined;
let dataDir: string;
let base: string;
let owner: { token: string; id: string };
let peer: { token: string; id: string };
let general: string;
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
const told = (frames: ServerToClient[]) =>
  frames.flatMap((f) =>
    f.type === "ephemeral" && f.event.type === "keywords" ? [f.event.keywords] : [],
  );

const setKeywords = (keywords: string[], auth = owner.token) =>
  request("/api/me/keywords", { keywords }, "PUT", auth);
const post = async (channelId: string, text: string, auth = peer.token, extra = {}) => {
  const sent = await request(
    `/api/channels/${channelId}/messages`,
    { text, nonce: `${Math.random()}`, ...extra },
    "POST",
    auth,
  );
  expect(sent.status, JSON.stringify(sent.body)).toBe(201);
  return sent.body.message as { id: string; text: string };
};
const mentions = async (auth = owner.token, cursor?: string, limit = 30) =>
  (
    await request(
      `/api/activity?mode=mentions&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
      undefined,
      "GET",
      auth,
    )
  ).body as { messages: { id: string; text: string }[]; nextCursor: string | null };
const texts = async (auth = owner.token) => (await mentions(auth)).messages.map((m) => m.text);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-keywords-"));
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  owner = await register("owner");
  peer = await register("peer");
  general = server.store.channels.byName("general")!.id;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
  server = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("an account's keywords", () => {
  it("start empty, and are kept in the order given, tidied, without repeats", async () => {
    expect(ready(await connect(owner.token)).keywords).toEqual([]);
    const saved = await setKeywords(["  release  notes ", "Launch", "launch", "RELEASE NOTES", ""]);
    expect(saved).toEqual({ status: 200, body: { keywords: ["release notes", "Launch"] } });
    expect((await request("/api/me/keywords", undefined, "GET")).body).toEqual({
      keywords: ["release notes", "Launch"],
    });
    expect(ready(await connect(owner.token)).keywords).toEqual(["release notes", "Launch"]);
    // Someone else's are their own.
    expect(ready(await connect(peer.token)).keywords).toEqual([]);
  });

  it("are told to this account's own devices only", async () => {
    const mine = await connect(owner.token);
    const theirs = await connect(peer.token);
    await setKeywords(["release"]);
    await expect.poll(() => told(mine)).toEqual([["release"]]);
    expect(told(theirs)).toEqual([]);
  });

  it("refuses a keyword with no letters or numbers, more than 20, or one too long", async () => {
    const symbols = await setKeywords(["release", "?!"]);
    expect(symbols.status).toBe(400);
    expect(symbols.body.error).toBe("keyword_without_words");
    expect((await setKeywords(Array.from({ length: 21 }, (_, i) => `word${i}`))).status).toBe(400);
    expect((await setKeywords(["a".repeat(51)])).status).toBe(400);
    expect((await request("/api/me/keywords", undefined, "GET")).body.keywords).toEqual([]);
  });

  it("splits text without spaces between words as the search index does", () => {
    expect(UNSPACED_RANGES).toEqual(INDEX_UNSPACED);
  });
});

describe("Activity's Mentions", () => {
  it("lists messages with a keyword sent since it was added, beside mentions", async () => {
    await post(general, "the release went out before you asked");
    await tick();
    await setKeywords(["release"]);
    await tick();
    await post(general, `<@${owner.id}> have a look`);
    await post(general, "The Release is out");
    await post(general, "released, and nothing else");
    await post(general, "release from me", owner.token);
    expect(await texts()).toEqual(["The Release is out", `<@${owner.id}> have a look`]);
    // Nobody else's keywords, nobody else's list.
    expect(await texts(peer.token)).toEqual([]);
  });

  it("goes on finding a keyword kept when the list is saved again", async () => {
    await setKeywords(["release"]);
    await tick();
    await post(general, "release one");
    const added = server!.store.people.keywordsAdded(owner.id)[0]!.addedAt;
    await setKeywords(["launch", "Réléase"]);
    expect(server!.store.people.keywordsAdded(owner.id)).toEqual([
      { keyword: "launch", addedAt: expect.any(Number) },
      { keyword: "Réléase", addedAt: added },
    ]);
    await post(general, "launch two");
    expect(await texts()).toEqual(["launch two", "release one"]);
  });

  it("leaves out a muted conversation, a muted thread and a blocked sender", async () => {
    await setKeywords(["release"]);
    await tick();
    const root = await post(general, "thread about the release");
    await request(`/api/messages/${root.id}/mute`, { muted: true }, "PUT");
    await post(general, "release in the thread", peer.token, { threadRootId: root.id });
    const random = (
      await request("/api/channels", { name: "random", type: "public" }, "POST", peer.token)
    ).body.channel.id as string;
    await request(`/api/channels/${random}/join`, {}, "POST");
    await request(`/api/channels/${random}/prefs`, { muted: true }, "PATCH");
    await post(random, "release in a muted channel");
    expect(await texts()).toEqual(["thread about the release"]);
    await request(`/api/me/blocks/${peer.id}`, undefined, "PUT");
    expect(await texts()).toEqual([]);
  });

  it("pages through keyword hits and mentions together, newest first", async () => {
    await setKeywords(["release"]);
    await tick();
    const sent: string[] = [];
    for (let i = 0; i < 5; i++) {
      sent.push((await post(general, i % 2 ? `release ${i}` : `<@${owner.id}> ${i}`)).text);
    }
    const first = await mentions(owner.token, undefined, 3);
    expect(first.messages.map((m) => m.text)).toEqual(sent.slice(2).reverse());
    const second = await mentions(owner.token, first.nextCursor!, 3);
    expect(second.messages.map((m) => m.text)).toEqual(sent.slice(0, 2).reverse());
    expect(second.nextCursor).toBeNull();
  });
});
