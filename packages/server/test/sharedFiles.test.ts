import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  fileKind,
  type ServerToClient,
  type SharedFile,
} from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * The file browser's list (E7): the files shared in conversations the reader
 * can read, newest first, by kind, sharer, conversation and name, paged.
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

async function upload(channelId: string, name: string, type = "", auth = owner.token) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type }), name);
  const uploaded = await fetch(`${base}/api/channels/${channelId}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth}` },
    body: form,
  });
  expect(uploaded.status, await uploaded.clone().text()).toBe(201);
  return ((await uploaded.json()) as { file: { id: string } }).file.id;
}

let nonce = 0;
/** Shares these files in one message, and gives the message. */
async function share(
  channelId: string,
  files: [name: string, type?: string][],
  auth = owner.token,
  extra: Record<string, unknown> = {},
) {
  const fileIds: string[] = [];
  for (const [name, type] of files) fileIds.push(await upload(channelId, name, type, auth));
  const sent = await request(
    `/api/channels/${channelId}/messages`,
    { text: "", nonce: `f-${++nonce}`, fileIds, ...extra },
    "POST",
    auth,
  );
  expect(sent.status, JSON.stringify(sent.body)).toBe(201);
  return sent.body.message as { id: string; files: { id: string }[] };
}

async function listed(query: Record<string, string> = {}, auth = owner.token) {
  const params = new URLSearchParams(query).toString();
  const answer = await request(`/api/files${params ? `?${params}` : ""}`, undefined, "GET", auth);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body as { files: SharedFile[]; nextCursor: string | null };
}
const names = async (query: Record<string, string> = {}, auth = owner.token) =>
  (await listed(query, auth)).files.map((f) => f.file.name);

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "slackoss-files-"));
  await start();
  owner = await register("owner");
  peer = await register("peer");
  general = server!.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
  server = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the file list", () => {
  it("lists shared files newest first, with the message that shared each", async () => {
    const first = await share(general, [["notes.txt", "text/plain"]]);
    const second = await share(
      general,
      [
        ["a.png", "image/png"],
        ["b.png", "image/png"],
      ],
      peer.token,
    );
    const page = await listed();
    // Newest first throughout: the newest message, and within one, its last file first.
    expect(page.files.map((f) => f.file.name)).toEqual(["b.png", "a.png", "notes.txt"]);
    expect(page.files[0]).toMatchObject({
      messageId: second.id,
      channelId: general,
      threadRootId: null,
      userId: peer.id,
      sharedAt: expect.any(Number),
      file: { id: second.files[1]!.id, mime: "image/png", size: 3 },
    });
    expect(page.files[2]!.messageId).toBe(first.id);
    expect(page.nextCursor).toBeNull();
  });

  it("pages without repeating or skipping, across one message's files too", async () => {
    for (let i = 0; i < 4; i++)
      await share(general, [
        [`m${i}-a.txt`, "text/plain"],
        [`m${i}-b.txt`, "text/plain"],
      ]);
    const all = await names();
    expect(all).toHaveLength(8);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listed({ limit: "3", ...(cursor ? { cursor } : {}) });
      expect(page.files.length).toBeLessThanOrEqual(3);
      seen.push(...page.files.map((f) => f.file.name));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all);
    // A cursor that is not one is refused.
    const bad = await request("/api/files?cursor=nope", undefined, "GET");
    expect(bad.status).toBe(400);
  });

  it("includes replies in threads, and says which thread", async () => {
    const root = (
      await request(`/api/channels/${general}/messages`, { text: "Designs", nonce: "root" })
    ).body.message;
    await share(general, [["mock.png", "image/png"]], peer.token, { threadRootId: root.id });
    expect((await listed()).files[0]).toMatchObject({
      file: { name: "mock.png" },
      threadRootId: root.id,
    });
  });

  it("leaves out files not yet sent, and those of deleted messages", async () => {
    await upload(general, "draft.txt", "text/plain");
    const gone = await share(general, [["old.txt", "text/plain"]]);
    await share(general, [["kept.txt", "text/plain"]]);
    expect((await request(`/api/messages/${gone.id}`, undefined, "DELETE")).status).toBe(200);
    expect(await names()).toEqual(["kept.txt"]);
  });
});

describe("who sees which files", () => {
  it("shows a private conversation's and a DM's files to their members only", async () => {
    const outsider = await register("outsider");
    const secret = (
      await request("/api/channels", { type: "private", name: "secret", memberIds: [peer.id] })
    ).body.channel.id as string;
    const dm = (await request("/api/channels", { type: "dm", memberIds: [peer.id] })).body.channel
      .id as string;
    await share(general, [["open.txt", "text/plain"]]);
    await share(secret, [["budget.xlsx"]]);
    await share(dm, [["between-us.txt", "text/plain"]], peer.token);

    expect(await names({}, owner.token)).toEqual(["between-us.txt", "budget.xlsx", "open.txt"]);
    expect(await names({}, peer.token)).toEqual(["between-us.txt", "budget.xlsx", "open.txt"]);
    expect(await names({}, outsider.token)).toEqual(["open.txt"]);
    // Asking for a conversation out of reach finds nothing there.
    expect(await names({ channelId: secret }, outsider.token)).toEqual([]);

    // Leaving a private conversation leaves its files behind.
    expect((await request(`/api/channels/${secret}/leave`, {}, "POST", peer.token)).status).toBe(
      200,
    );
    expect(await names({}, peer.token)).toEqual(["between-us.txt", "open.txt"]);
  });

  it("lets a guest list the public conversations' files and nothing else", async () => {
    server!.setAccessPolicy("guest_allowed");
    const joined = await fetch(`${base}/api/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Visitor" }),
    });
    const guest = (await joined.json()) as { token: string };
    const secret = (await request("/api/channels", { type: "private", name: "secret" })).body
      .channel.id as string;
    await share(general, [["open.txt", "text/plain"]]);
    await share(secret, [["closed.txt", "text/plain"]]);
    expect(await names({}, guest.token)).toEqual(["open.txt"]);
  });
});

describe("narrowing the list", () => {
  beforeEach(async () => {
    const design = (await request("/api/channels", { type: "public", name: "design" })).body.channel
      .id as string;
    await share(general, [
      ["photo.jpg", "image/jpeg"],
      // A picture whose name says PDF is a picture.
      ["scan.pdf", "image/png"],
    ]);
    await share(
      design,
      [
        ["brief.pdf", "application/pdf"],
        // Sent as anything at all, it is still known by its name's ending.
        ["budget.xlsx", "application/octet-stream"],
        ["deck.pptx"],
        ["README.md", "text/markdown"],
      ],
      peer.token,
    );
    await share(design, [
      ["clip.mp4", "video/mp4"],
      ["archive.zip", "application/zip"],
      ["100%_done_v2.txt", "text/plain"],
    ]);
  });

  it("by kind, agreeing with fileKind for every file", async () => {
    expect(await names({ kind: "image" })).toEqual(["scan.pdf", "photo.jpg"]);
    expect(await names({ kind: "document" })).toEqual([
      "100%_done_v2.txt",
      "README.md",
      "deck.pptx",
      "budget.xlsx",
      "brief.pdf",
    ]);
    expect(await names({ kind: "other" })).toEqual(["archive.zip", "clip.mp4"]);
    for (const shared of (await listed()).files)
      expect(
        await names({ kind: fileKind(shared.file.mime, shared.file.name) }),
        shared.file.name,
      ).toContain(shared.file.name);
    expect((await request("/api/files?kind=video", undefined, "GET")).status).toBe(400);
  });

  it("by who shared, by conversation, and together", async () => {
    const design = server!.store.getChannelByName("design")!.id;
    expect(await names({ userId: peer.id })).toEqual([
      "README.md",
      "deck.pptx",
      "budget.xlsx",
      "brief.pdf",
    ]);
    expect(await names({ channelId: general })).toEqual(["scan.pdf", "photo.jpg"]);
    expect(await names({ channelId: design, userId: owner.id, kind: "other" })).toEqual([
      "archive.zip",
      "clip.mp4",
    ]);
  });

  it("by every word in the name, ignoring case, with % and _ taken as they are", async () => {
    expect(await names({ q: "BUDGET" })).toEqual(["budget.xlsx"]);
    expect(await names({ q: "  b  pdf " })).toEqual(["brief.pdf"]);
    expect(await names({ q: "100%" })).toEqual(["100%_done_v2.txt"]);
    expect(await names({ q: "_done" })).toEqual(["100%_done_v2.txt"]);
    // Without escaping, "_" would match any one letter and "%" anything.
    expect(await names({ q: "%" })).toEqual(["100%_done_v2.txt"]);
    expect(await names({ q: "b_dget" })).toEqual([]);
    expect(await names({ q: "nothing-like-it" })).toEqual([]);
  });
});

describe("reading the list", () => {
  it("walks files newest first through their message index, not every message", async () => {
    await share(general, [["notes.txt", "text/plain"]]);
    const db = (server!.store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const prepare = db.prepare.bind(db);
    const plans: string[] = [];
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes("ORDER BY f.message_id DESC")) return statement;
      return {
        all: (...params: (string | number)[]) => {
          plans.push(
            (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
              .map((row) => row.detail)
              .join("; "),
          );
          return statement.all(...params);
        },
      };
    }) as typeof db.prepare;
    try {
      await listed({ kind: "document", q: "notes" });
      await listed({ channelId: general });
    } finally {
      db.prepare = prepare;
    }
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      // Files first, through the index, so a page stops once it is full.
      expect(plan).toMatch(/^SEARCH f USING INDEX idx_files_message/);
      expect(plan).not.toMatch(/SCAN m|TEMP B-TREE FOR ORDER BY/);
    }
  });
});

describe("the ready snapshot", () => {
  it("says the server lists shared files", async () => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    sockets.push(ws);
    const frames: ServerToClient[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerToClient));
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          token: owner.token,
          lastSeq: null,
          protocolVersion: PROTOCOL_VERSION,
        }),
      ),
    );
    await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
    expect(frames.find((f) => f.type === "ready")).toMatchObject({ sharedFiles: true });
  });
});
