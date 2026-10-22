import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  type Channel,
  type Message,
  type ReadySnapshot,
  type ServerToClient,
  type User,
} from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";

let server: WorkspaceServer;
let base: string;
let dataDir: string;

beforeAll(async () => {
  // A real directory (not :memory:) so file uploads are exercised too.
  dataDir = mkdtempSync(join(tmpdir(), "slackoss-test-"));
  server = await createWorkspaceServer({
    dataDir,
    port: 0,
    workspaceName: "Test Workspace",
    mdns: false,
    logger: process.env.TEST_LOG === "1",
    // One account drives this whole suite, at a rate no person types at.
    // Rationing has its own file, where it is the subject rather than a
    // background condition every other case has to work around.
    rateLimits: false,
    // A dropped device's place in a call goes at once here; huddleRejoin.test.ts
    // covers the grace it gets for coming back.
    huddleGraceMs: 0,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function api<T>(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as T };
}

function connectWs(token: string, lastSeq: number | null = null) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const received: ServerToClient[] = [];
  const waiters: ((msg: ServerToClient) => void)[] = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as ServerToClient;
    received.push(msg);
    waiters.splice(0).forEach((w) => w(msg));
  });
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", token, lastSeq, protocolVersion: PROTOCOL_VERSION }));
  });
  const next = (predicate: (m: ServerToClient) => boolean, timeoutMs = 3000) =>
    new Promise<ServerToClient>((resolvePromise, reject) => {
      const hit = received.find(predicate);
      if (hit) return resolvePromise(hit);
      const timer = setTimeout(() => reject(new Error("ws wait timeout")), timeoutMs);
      const check = (m: ServerToClient) => {
        if (predicate(m)) {
          clearTimeout(timer);
          resolvePromise(m);
        } else {
          waiters.push(check);
        }
      };
      waiters.push(check);
    });
  return { ws, received, next };
}

let aliceToken: string;
let alice: User;
let bobToken: string;
let bob: User;

describe("workspace server", () => {
  it("reports server info before setup", async () => {
    const { data } = await api<{ workspaceName: string; userCount: number; publicUrl?: string }>(
      "/api/server-info",
    );
    expect(data.workspaceName).toBe("Test Workspace");
    expect(data.userCount).toBe(0);
    // Nothing was configured, so clients build links on the address they use.
    expect(data).not.toHaveProperty("publicUrl");
  });

  it("makes the first registered user the owner and bootstraps #general", async () => {
    const { status, data } = await api<{ token: string; user: User }>("/api/auth/register", {
      body: { handle: "alice", displayName: "Alice", password: "password123" },
    });
    expect(status).toBe(201);
    expect(data.user.role).toBe("owner");
    aliceToken = data.token;
    alice = data.user;

    const channels = await api<{ channels: Channel[] }>("/api/channels", { token: aliceToken });
    expect(channels.data.channels.map((c) => c.name)).toContain("general");
  });

  it("lets a second user register and auto-join #general", async () => {
    const { status, data } = await api<{ token: string; user: User }>("/api/auth/register", {
      body: { handle: "bob", displayName: "Bob", password: "password123" },
    });
    expect(status).toBe(201);
    expect(data.user.role).toBe("member");
    bobToken = data.token;
    bob = data.user;
  });

  it("rejects bad logins and accepts good ones", async () => {
    const bad = await api("/api/auth/login", { body: { handle: "alice", password: "wrong-pass" } });
    expect(bad.status).toBe(401);
    const good = await api<{ token: string }>("/api/auth/login", {
      body: { handle: "alice", password: "password123" },
    });
    expect(good.status).toBe(200);
  });

  it("delivers messages over WS in realtime with nonce echo", async () => {
    const a = connectWs(aliceToken);
    const b = connectWs(bobToken);
    const readyA = (await a.next((m) => m.type === "ready")) as ReadySnapshot;
    await b.next((m) => m.type === "ready");
    const general = readyA.channels.find((c) => c.name === "general")!;

    const sent = await api<{ message: Message }>(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "hello <@" + bob.id + ">!", nonce: "n-1" },
    });
    expect(sent.status).toBe(201);
    expect(sent.data.message.seq).toBeGreaterThan(0);

    const evt = await b.next(
      (m) => m.type === "event" && m.envelope.event.type === "message.created",
    );
    if (evt.type !== "event" || evt.envelope.event.type !== "message.created") throw new Error();
    expect(evt.envelope.event.message.text).toContain("hello");
    expect(evt.envelope.event.message.nonce).toBe("n-1");
    expect(evt.envelope.seq).toBe(evt.envelope.event.message.seq);

    a.ws.close();
    b.ws.close();
  });

  it("replays missed events on reconnect", async () => {
    // Bob is offline; Alice keeps talking.
    const general = server.store.getChannelByName("general")!;
    await api(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "while you were away" },
    });

    const b = connectWs(bobToken, 1); // way behind: everything after seq 1 replays
    await b.next((m) => m.type === "ready");
    const replayed = await b.next(
      (m) =>
        m.type === "event" &&
        m.envelope.event.type === "message.created" &&
        m.envelope.event.message.text === "while you were away",
    );
    expect(replayed.type).toBe("event");
    b.ws.close();
  });

  it("tells the creator they are a member of a channel they just made", async () => {
    const a = connectWs(aliceToken);
    await a.next((m) => m.type === "ready");

    const created = await api<{ channel: Channel }>("/api/channels", {
      token: aliceToken,
      body: { type: "public", name: "logistics" },
    });
    expect(created.status).toBe(201);

    // Without this the channel never appears in the creator's sidebar.
    const joined = await a.next(
      (m) =>
        m.type === "event" &&
        m.envelope.event.type === "member.joined" &&
        m.envelope.event.channelId === created.data.channel.id &&
        m.envelope.event.userId === alice.id,
    );
    expect(joined.type).toBe("event");
    a.ws.close();
  });

  it("keeps private channels invisible to non-members", async () => {
    const created = await api<{ channel: Channel }>("/api/channels", {
      token: aliceToken,
      body: { type: "private", name: "secret-plans" },
    });
    expect(created.status).toBe(201);

    const bobView = await api<{ channels: Channel[] }>("/api/channels", { token: bobToken });
    expect(bobView.data.channels.map((c) => c.name)).not.toContain("secret-plans");

    const denied = await api(`/api/channels/${created.data.channel.id}/messages`, {
      token: bobToken,
    });
    expect(denied.status).toBe(404);
  });

  it("dedupes DMs on the same member pair", async () => {
    const dm1 = await api<{ channel: Channel }>("/api/channels", {
      token: aliceToken,
      body: { type: "dm", memberIds: [bob.id] },
    });
    const dm2 = await api<{ channel: Channel }>("/api/channels", {
      token: bobToken,
      body: { type: "dm", memberIds: [alice.id] },
    });
    expect(dm1.data.channel.id).toBe(dm2.data.channel.id);
    expect(dm1.data.channel.memberIds).toHaveLength(2);
  });

  it("supports threads, edits, deletes, and reactions", async () => {
    const general = server.store.getChannelByName("general")!;
    const root = await api<{ message: Message }>(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "thread root" },
    });
    const reply = await api<{ message: Message }>(`/api/channels/${general.id}/messages`, {
      token: bobToken,
      body: { text: "thread reply", threadRootId: root.data.message.id },
    });
    expect(reply.status).toBe(201);

    const history = await api<{ messages: Message[] }>(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
    });
    const rootInHistory = history.data.messages.find((m) => m.id === root.data.message.id)!;
    expect(rootInHistory.replyCount).toBe(1);
    // Replies don't appear in the top-level history.
    expect(history.data.messages.find((m) => m.id === reply.data.message.id)).toBeUndefined();

    const edited = await api<{ message: Message }>(`/api/messages/${root.data.message.id}`, {
      method: "PATCH",
      token: aliceToken,
      body: { text: "thread root (edited)" },
    });
    expect(edited.data.message.editedAt).not.toBeNull();

    const foreignEdit = await api(`/api/messages/${root.data.message.id}`, {
      method: "PATCH",
      token: bobToken,
      body: { text: "hijack" },
    });
    expect(foreignEdit.status).toBe(403);

    const react = await api(
      `/api/messages/${root.data.message.id}/reactions/${encodeURIComponent("👍")}`,
      { method: "PUT", token: bobToken },
    );
    expect(react.status).toBe(200);
    const afterReact = await api<{ messages: Message[] }>(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
    });
    const withReaction = afterReact.data.messages.find((m) => m.id === root.data.message.id)!;
    expect(withReaction.reactions).toEqual([{ emoji: "👍", userIds: [bob.id] }]);

    const del = await api(`/api/messages/${reply.data.message.id}`, {
      method: "DELETE",
      token: bobToken,
    });
    expect(del.status).toBe(200);
  });

  it("searches messages with FTS and respects channel access", async () => {
    const general = server.store.getChannelByName("general")!;
    await api(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "the quarterly zebra report is ready" },
    });
    const secret = server.store.getChannelByName("secret-plans")!;
    await api(`/api/channels/${secret.id}/messages`, {
      token: aliceToken,
      body: { text: "secret zebra heist" },
    });

    const bobSearch = await api<{ messages: Message[] }>("/api/search?q=zebra", {
      token: bobToken,
    });
    expect(bobSearch.data.messages).toHaveLength(1);
    expect(bobSearch.data.messages[0]!.text).toContain("quarterly");

    const aliceSearch = await api<{ messages: Message[] }>("/api/search?q=zebra", {
      token: aliceToken,
    });
    expect(aliceSearch.data.messages).toHaveLength(2);
  });

  it("finds a message by the name of its attachment, only where the reader can see it (IMP-02)", async () => {
    const attach = async (channelId: string, name: string, text: string) => {
      const form = new FormData();
      // Sent as anything: only the name says it is a spreadsheet.
      form.append("file", new Blob(["a,b\n1,2"], { type: "application/octet-stream" }), name);
      const upload = await fetch(`${base}/api/channels/${channelId}/files`, {
        method: "POST",
        headers: { authorization: `Bearer ${aliceToken}` },
        body: form,
      });
      const { file } = (await upload.json()) as { file: { id: string } };
      const sent = await api<{ message: Message }>(`/api/channels/${channelId}/messages`, {
        token: aliceToken,
        body: { text, fileIds: [file.id] },
      });
      return sent.data.message;
    };
    const general = server.store.getChannelByName("general")!;
    const secret = server.store.getChannelByName("secret-plans")!;
    const shared = await attach(general.id, "Q3 Budget.xlsx", "numbers for the quarter");
    await attach(secret.id, "Q3 budget final.xlsx", "the real numbers");
    const search = async (q: string, token: string) =>
      (
        await api<{ messages: Message[] }>(`/api/search?q=${encodeURIComponent(q)}`, { token })
      ).data.messages.map((m) => m.text);

    expect(await search("budget", bobToken)).toEqual(["numbers for the quarter"]);
    expect(await search("q3 BUDGET", aliceToken)).toEqual([
      "the real numbers",
      "numbers for the quarter",
    ]);
    expect(await search("type:spreadsheet", bobToken)).toEqual(["numbers for the quarter"]);
    expect(await search("budget type:pdf", aliceToken)).toEqual([]);

    // Deleted, it is found by nothing, its file's name included.
    const del = await api(`/api/messages/${shared.id}`, { method: "DELETE", token: aliceToken });
    expect(del.status).toBe(200);
    expect(await search("budget", bobToken)).toEqual([]);
  });

  it("uploads a file, attaches it to a message, and gates access by channel", async () => {
    const general = server.store.getChannelByName("general")!;

    // A 1x1 red PNG — real bytes, so the header parser has something to measure.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "red-dot.png");

    const uploadRes = await fetch(`${base}/api/channels/${general.id}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${aliceToken}` },
      body: form,
    });
    expect(uploadRes.status).toBe(201);
    const { file } = (await uploadRes.json()) as {
      file: { id: string; width: number; height: number; size: number };
    };
    expect(file.width).toBe(1);
    expect(file.height).toBe(1);
    expect(file.size).toBe(png.byteLength);

    const sent = await api<{ message: Message }>(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "", fileIds: [file.id] },
    });
    expect(sent.status).toBe(201);
    expect(sent.data.message.files).toHaveLength(1);
    expect(sent.data.message.files[0]!.name).toBe("red-dot.png");

    // Bob is in #general, so he can fetch the bytes.
    const download = await fetch(`${base}/api/files/${file.id}`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await download.arrayBuffer()).equals(png)).toBe(true);

    // Anonymous requests get nothing.
    expect((await fetch(`${base}/api/files/${file.id}`)).status).toBe(401);

    // Deleting the message removes the blob too.
    const del = await api(`/api/messages/${sent.data.message.id}`, {
      method: "DELETE",
      token: aliceToken,
    });
    expect(del.status).toBe(200);
    const afterDelete = await fetch(`${base}/api/files/${file.id}`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(afterDelete.status).toBe(404);
  });

  it("rejects an empty message with no attachments", async () => {
    const general = server.store.getChannelByName("general")!;
    const res = await api(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "   " },
    });
    expect(res.status).toBe(400);
  });

  it("keeps uploads out of channels the user cannot see", async () => {
    const secret = server.store.getChannelByName("secret-plans")!;
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("classified")], { type: "text/plain" }), "plan.txt");
    const res = await fetch(`${base}/api/channels/${secret.id}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${bobToken}` },
      body: form,
    });
    expect(res.status).toBe(404);
  });

  it("pins messages for the whole channel and saves them privately", async () => {
    const general = server.store.getChannelByName("general")!;
    const posted = await api<{ message: Message }>(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "read this before Friday" },
    });
    const messageId = posted.data.message.id;

    // Bob watches for the pin event, since pins are channel-wide.
    const bobWs = connectWs(bobToken);
    await bobWs.next((m) => m.type === "ready");

    expect(
      (await api(`/api/messages/${messageId}/pin`, { method: "PUT", token: aliceToken })).status,
    ).toBe(200);
    const pinEvent = await bobWs.next(
      (m) => m.type === "event" && m.envelope.event.type === "pin.added",
    );
    expect(pinEvent.type).toBe("event");

    const pins = await api<{ messages: Message[] }>(`/api/channels/${general.id}/pins`, {
      token: bobToken,
    });
    expect(pins.data.messages.map((m) => m.id)).toContain(messageId);
    expect(pins.data.messages.find((m) => m.id === messageId)!.pinned).toBe(true);

    // Saving is private: Alice saves, Bob's list stays empty.
    expect(
      (await api(`/api/messages/${messageId}/save`, { method: "PUT", token: aliceToken })).status,
    ).toBe(200);
    const aliceSaved = await api<{ messages: Message[] }>("/api/saved", { token: aliceToken });
    expect(aliceSaved.data.messages.map((m) => m.id)).toContain(messageId);
    const bobSaved = await api<{ messages: Message[] }>("/api/saved", { token: bobToken });
    expect(bobSaved.data.messages).toHaveLength(0);

    // Unpinning and unsaving both clear.
    await api(`/api/messages/${messageId}/pin`, { method: "DELETE", token: aliceToken });
    await api(`/api/messages/${messageId}/save`, { method: "DELETE", token: aliceToken });
    const afterPins = await api<{ messages: Message[] }>(`/api/channels/${general.id}/pins`, {
      token: aliceToken,
    });
    expect(afterPins.data.messages.map((m) => m.id)).not.toContain(messageId);
    const afterSaved = await api<{ messages: Message[] }>("/api/saved", { token: aliceToken });
    expect(afterSaved.data.messages).toHaveLength(0);

    bobWs.ws.close();
  });

  it("will not pin a message in a channel the user cannot see", async () => {
    const secret = server.store.getChannelByName("secret-plans")!;
    const posted = await api<{ message: Message }>(`/api/channels/${secret.id}/messages`, {
      token: aliceToken,
      body: { text: "eyes only" },
    });
    const res = await api(`/api/messages/${posted.data.message.id}/pin`, {
      method: "PUT",
      token: bobToken,
    });
    expect(res.status).toBe(404);
  });

  // Node's fetch ignores CORS, so browser-only breakage needs an explicit check:
  // the default allow-list omits PUT/PATCH/DELETE, which kills reactions,
  // edits, deletes, pins and saves in the real client.
  it("allows the mutating methods through CORS preflight", async () => {
    const res = await fetch(`${base}/api/messages/anything/pin`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization",
      },
    });
    const allowed = (res.headers.get("access-control-allow-methods") ?? "")
      .split(",")
      .map((m) => m.trim());
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(allowed).toContain(method);
    }
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("finds a word from its start while the last one is still being typed", async () => {
    const general = server.store.getChannelByName("general")!;
    await api(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "the quokkas arrived for the budget review" },
    });
    const find = async (q: string) =>
      (
        await api<{ messages: Message[] }>(`/api/search?q=${encodeURIComponent(q)}`, {
          token: aliceToken,
        })
      ).data.messages.filter((m) => m.text.includes("quokkas"));

    expect(await find("quok")).toHaveLength(1);
    expect(await find("budget rev")).toHaveLength(1);
    // Only the last word is a start; the words before it are whole.
    expect(await find("quok budget")).toHaveLength(0);
    // A last word with nothing to start a word from cannot break the query.
    expect(await find("quokkas .")).toHaveLength(1);
  });

  it("filters search with from:, in:, has: and date modifiers", async () => {
    const general = server.store.getChannelByName("general")!;
    await api(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
      body: { text: "alpaca sighting confirmed by me" },
    });
    await api(`/api/channels/${general.id}/messages`, {
      token: bobToken,
      body: { text: "alpaca link https://example.com/alpaca" },
    });

    const all = await api<{ messages: Message[] }>("/api/search?q=alpaca", { token: aliceToken });
    expect(all.data.messages).toHaveLength(2);

    const fromBob = await api<{ messages: Message[] }>(
      `/api/search?q=${encodeURIComponent("alpaca from:@bob")}`,
      { token: aliceToken },
    );
    expect(fromBob.data.messages).toHaveLength(1);
    expect(fromBob.data.messages[0]!.userId).toBe(bob.id);

    const withLink = await api<{ messages: Message[] }>(
      `/api/search?q=${encodeURIComponent("alpaca has:link")}`,
      { token: aliceToken },
    );
    expect(withLink.data.messages).toHaveLength(1);
    expect(withLink.data.messages[0]!.text).toContain("https://");

    const inGeneral = await api<{ messages: Message[] }>(
      `/api/search?q=${encodeURIComponent("alpaca in:#general")}`,
      { token: aliceToken },
    );
    expect(inGeneral.data.messages).toHaveLength(2);

    const elsewhere = await api<{ messages: Message[] }>(
      `/api/search?q=${encodeURIComponent("alpaca in:#nowhere")}`,
      { token: aliceToken },
    );
    expect(elsewhere.data.messages).toHaveLength(0);

    // Modifiers alone, with no free text, still search.
    const bobsPosts = await api<{ messages: Message[] }>(
      `/api/search?q=${encodeURIComponent("from:@bob in:#general")}`,
      { token: aliceToken },
    );
    expect(bobsPosts.data.messages.length).toBeGreaterThan(0);
    expect(bobsPosts.data.messages.every((m) => m.userId === bob.id)).toBe(true);

    // A future cutoff excludes everything written so far.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const laterOnly = await api<{ messages: Message[] }>(
      `/api/search?q=${encodeURIComponent(`alpaca after:${tomorrow}`)}`,
      { token: aliceToken },
    );
    expect(laterOnly.data.messages).toHaveLength(0);
  });

  it("keeps search modifiers inside the caller's visibility", async () => {
    const secret = server.store.getChannelByName("secret-plans")!;
    await api(`/api/channels/${secret.id}/messages`, {
      token: aliceToken,
      body: { text: "alpaca smuggling route" },
    });
    // Bob is not a member, so naming the channel must not leak it.
    const bobTry = await api<{ messages: Message[] }>(
      `/api/search?q=${encodeURIComponent("alpaca in:#secret-plans")}`,
      { token: bobToken },
    );
    expect(bobTry.data.messages).toHaveLength(0);
  });

  it("stores per-channel notification preferences privately", async () => {
    const general = server.store.getChannelByName("general")!;

    const res = await api<{ prefs: { notifyLevel: string; muted: boolean } }>(
      `/api/channels/${general.id}/prefs`,
      { method: "PATCH", token: aliceToken, body: { notifyLevel: "all", muted: true } },
    );
    expect(res.status).toBe(200);
    expect(res.data.prefs).toEqual({
      notifyLevel: "all",
      muted: true,
      starred: false,
      sectionId: null,
    });

    // Alice's choice is hers alone.
    expect(server.store.getChannelPrefs(general.id, bob.id)).toEqual({
      notifyLevel: "mentions",
      muted: false,
      starred: false,
      sectionId: null,
    });

    await api(`/api/channels/${general.id}/prefs`, {
      method: "PATCH",
      token: aliceToken,
      body: { muted: false },
    });
    // A partial update leaves the other field alone.
    expect(server.store.getChannelPrefs(general.id, alice.id)).toEqual({
      notifyLevel: "all",
      muted: false,
      starred: false,
      sectionId: null,
    });
  });

  it("defaults DMs to notifying on every message", async () => {
    const dm = await api<{ channel: Channel }>("/api/channels", {
      token: aliceToken,
      body: { type: "dm", memberIds: [bob.id] },
    });
    expect(server.store.getChannelPrefs(dm.data.channel.id, alice.id)?.notifyLevel).toBe("all");
  });

  it("snoozes notifications with Do Not Disturb", async () => {
    const until = Date.now() + 30 * 60_000;
    const res = await api<{ user: { dndUntil: number | null } }>("/api/me", {
      method: "PATCH",
      token: aliceToken,
      body: { dndUntil: until },
    });
    expect(res.data.user.dndUntil).toBe(until);

    const cleared = await api<{ user: { dndUntil: number | null } }>("/api/me", {
      method: "PATCH",
      token: aliceToken,
      body: { dndUntil: null },
    });
    expect(cleared.data.user.dndUntil).toBeNull();
  });

  it("loads a window of history around one message", async () => {
    const room = await api<{ channel: Channel }>("/api/channels", {
      token: aliceToken,
      body: { type: "public", name: "history" },
    });
    const channelId = room.data.channel.id;

    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const posted = await api<{ message: Message }>(`/api/channels/${channelId}/messages`, {
        token: aliceToken,
        body: { text: `message ${i}` },
      });
      ids.push(posted.data.message.id);
    }

    const middle = ids[15]!;
    const around = await api<{
      messages: Message[];
      hasMoreOlder: boolean;
      hasMoreNewer: boolean;
    }>(`/api/channels/${channelId}/messages/around/${middle}?limit=10`, { token: aliceToken });

    expect(around.status).toBe(200);
    // The target sits inside the window, with context on both sides.
    expect(around.data.messages.map((m) => m.id)).toContain(middle);
    expect(around.data.hasMoreOlder).toBe(true);
    expect(around.data.hasMoreNewer).toBe(true);
    // Newest-first, matching the plain history endpoint.
    const returned = around.data.messages.map((m) => m.id);
    expect([...returned].sort().reverse()).toEqual(returned);

    // A window on the very first message has nothing older.
    const atStart = await api<{ hasMoreOlder: boolean; hasMoreNewer: boolean }>(
      `/api/channels/${channelId}/messages/around/${ids[0]}?limit=10`,
      { token: aliceToken },
    );
    expect(atStart.data.hasMoreOlder).toBe(false);
    expect(atStart.data.hasMoreNewer).toBe(true);

    // Paging forward from the middle walks toward the tail.
    const after = await api<{ messages: Message[] }>(
      `/api/channels/${channelId}/messages/after/${middle}?limit=5`,
      { token: aliceToken },
    );
    expect(after.data.messages).toHaveLength(5);
    expect(after.data.messages.every((m) => m.id > middle)).toBe(true);
  });

  it("will not load history around a message in a hidden channel", async () => {
    const secret = server.store.getChannelByName("secret-plans")!;
    const posted = await api<{ message: Message }>(`/api/channels/${secret.id}/messages`, {
      token: aliceToken,
      body: { text: "still classified" },
    });
    const res = await api(`/api/channels/${secret.id}/messages/around/${posted.data.message.id}`, {
      token: bobToken,
    });
    expect(res.status).toBe(404);
  });

  it("queues a message and sends it when it comes due", async () => {
    const general = server.store.getChannelByName("general")!;

    // Two seconds out: long enough to observe queued, short enough to wait for.
    const sendAt = Date.now() + 2000;
    const queued = await api<{ scheduled: { id: string; sendAt: number } }>(
      `/api/channels/${general.id}/scheduled`,
      { token: aliceToken, body: { text: "sent from the future", sendAt } },
    );
    expect(queued.status).toBe(201);

    const listed = await api<{ scheduled: { id: string }[] }>("/api/scheduled", {
      token: aliceToken,
    });
    expect(listed.data.scheduled.map((s) => s.id)).toContain(queued.data.scheduled.id);

    // Nobody else sees another person's queue.
    const bobList = await api<{ scheduled: unknown[] }>("/api/scheduled", { token: bobToken });
    expect(bobList.data.scheduled).toHaveLength(0);

    // Not posted yet.
    const before = await api<{ messages: Message[] }>(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
    });
    expect(before.data.messages.some((m) => m.text === "sent from the future")).toBe(false);

    // The scheduler polls; drive it directly so the test does not idle.
    await new Promise((r) => setTimeout(r, 2100));
    server.flushScheduled();

    const after = await api<{ messages: Message[] }>(`/api/channels/${general.id}/messages`, {
      token: aliceToken,
    });
    expect(after.data.messages.some((m) => m.text === "sent from the future")).toBe(true);

    // And it is no longer queued.
    const emptied = await api<{ scheduled: unknown[] }>("/api/scheduled", { token: aliceToken });
    expect(emptied.data.scheduled).toHaveLength(0);
  });

  it("refuses a time in the past", async () => {
    const general = server.store.getChannelByName("general")!;
    const res = await api(`/api/channels/${general.id}/scheduled`, {
      token: aliceToken,
      body: { text: "too late", sendAt: Date.now() - 60_000 },
    });
    expect(res.status).toBe(400);
  });

  it("only lets the author cancel a scheduled message", async () => {
    const general = server.store.getChannelByName("general")!;
    const queued = await api<{ scheduled: { id: string } }>(
      `/api/channels/${general.id}/scheduled`,
      { token: aliceToken, body: { text: "mine alone", sendAt: Date.now() + 3_600_000 } },
    );
    const id = queued.data.scheduled.id;

    const bobTry = await api(`/api/scheduled/${id}`, { method: "DELETE", token: bobToken });
    expect(bobTry.status).toBe(404);

    const own = await api(`/api/scheduled/${id}`, { method: "DELETE", token: aliceToken });
    expect(own.status).toBe(200);

    // Cancelled means it never fires.
    server.flushScheduled();
    const still = await api<{ scheduled: unknown[] }>("/api/scheduled", { token: aliceToken });
    expect(still.data.scheduled).toHaveLength(0);
  });

  it("will not queue into a channel the user cannot see", async () => {
    const secret = server.store.getChannelByName("secret-plans")!;
    const res = await api(`/api/channels/${secret.id}/scheduled`, {
      token: bobToken,
      body: { text: "sneaky", sendAt: Date.now() + 60_000 },
    });
    expect(res.status).toBe(404);
  });

  it("tracks huddle participants and relays signalling between them", async () => {
    const general = server.store.getChannelByName("general")!;
    const a = connectWs(aliceToken);
    const b = connectWs(bobToken);
    await a.next((m) => m.type === "ready");
    await b.next((m) => m.type === "ready");

    a.ws.send(JSON.stringify({ type: "huddle.join", channelId: general.id }));
    // Bob is in the channel, so he learns a huddle started.
    const started = await b.next(
      (m) =>
        m.type === "ephemeral" &&
        m.event.type === "huddle.participants" &&
        m.event.userIds.length === 1,
    );
    expect(started.type).toBe("ephemeral");

    b.ws.send(JSON.stringify({ type: "huddle.join", channelId: general.id }));
    await a.next(
      (m) =>
        m.type === "ephemeral" &&
        m.event.type === "huddle.participants" &&
        m.event.userIds.length === 2,
    );
    expect(server.gateway.huddleParticipants(general.id).sort()).toEqual([alice.id, bob.id].sort());

    // An offer from Alice reaches Bob untouched.
    const offer = { kind: "offer", sdp: "v=0 fake-offer" };
    a.ws.send(
      JSON.stringify({
        type: "huddle.signal",
        channelId: general.id,
        to: bob.id,
        signal: offer,
      }),
    );
    const relayed = await b.next((m) => m.type === "ephemeral" && m.event.type === "huddle.signal");
    if (relayed.type !== "ephemeral" || relayed.event.type !== "huddle.signal") throw new Error();
    expect(relayed.event.from).toBe(alice.id);
    expect(relayed.event.signal).toEqual(offer);

    // Leaving empties the room.
    a.ws.send(JSON.stringify({ type: "huddle.leave", channelId: general.id }));
    await b.next(
      (m) =>
        m.type === "ephemeral" &&
        m.event.type === "huddle.participants" &&
        m.event.userIds.length === 1,
    );

    // And dropping the socket removes the last one, rather than leaving a ghost.
    b.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(server.gateway.huddleParticipants(general.id)).toEqual([]);
    a.ws.close();
  });

  it("will not relay huddle signals to someone outside the huddle", async () => {
    const general = server.store.getChannelByName("general")!;
    const a = connectWs(aliceToken);
    const b = connectWs(bobToken);
    await a.next((m) => m.type === "ready");
    await b.next((m) => m.type === "ready");

    // Only Alice joins; Bob is in the channel but not the call.
    a.ws.send(JSON.stringify({ type: "huddle.join", channelId: general.id }));
    await b.next((m) => m.type === "ephemeral" && m.event.type === "huddle.participants");

    a.ws.send(
      JSON.stringify({
        type: "huddle.signal",
        channelId: general.id,
        to: bob.id,
        signal: { kind: "offer", sdp: "should not arrive" },
      }),
    );
    await new Promise((r) => setTimeout(r, 250));
    const leaked = b.received.some(
      (m) => m.type === "ephemeral" && m.event.type === "huddle.signal",
    );
    expect(leaked).toBe(false);

    a.ws.close();
    b.ws.close();
  });

  it("keeps huddles in private channels invisible to outsiders", async () => {
    const secret = server.store.getChannelByName("secret-plans")!;
    const a = connectWs(aliceToken);
    const b = connectWs(bobToken);
    await a.next((m) => m.type === "ready");
    await b.next((m) => m.type === "ready");

    a.ws.send(JSON.stringify({ type: "huddle.join", channelId: secret.id }));
    await new Promise((r) => setTimeout(r, 250));
    const sawIt = b.received.some(
      (m) =>
        m.type === "ephemeral" &&
        m.event.type === "huddle.participants" &&
        m.event.channelId === secret.id,
    );
    expect(sawIt).toBe(false);

    // Bob cannot start one there either.
    b.ws.send(JSON.stringify({ type: "huddle.join", channelId: secret.id }));
    await new Promise((r) => setTimeout(r, 250));
    expect(server.gateway.huddleParticipants(secret.id)).toEqual([alice.id]);

    a.ws.close();
    b.ws.close();
  });

  it("posts through an incoming webhook shaped like Slack's", async () => {
    const general = server.store.getChannelByName("general")!;

    const created = await api<{ app: { id: string }; botUser: User; token: string }>("/api/apps", {
      token: aliceToken,
      body: { name: "Deploy Bot" },
    });
    expect(created.status).toBe(201);
    expect(created.data.botUser.isBot).toBe(true);
    expect(created.data.token).toMatch(/^xoxb-/);

    const hook = await api<{ url: string }>(`/api/apps/${created.data.app.id}/webhooks`, {
      token: aliceToken,
      body: { channelId: general.id },
    });
    expect(hook.status).toBe(201);

    // A plain Slack payload.
    const res = await fetch(`${base}${hook.data.url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "build 412 is green" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    const history = await api<{ messages: Message[] }>(`/api/channels/${general.id}/messages`, {
      token: bobToken,
    });
    const posted = history.data.messages.find((m) => m.text === "build 412 is green");
    expect(posted).toBeDefined();
    expect(posted!.userId).toBe(created.data.botUser.id);

    // Block Kit, with no top-level text, is flattened rather than rejected.
    const blocks = await fetch(`${base}${hook.data.url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        blocks: [
          { type: "header", text: { type: "plain_text", text: "Nightly" } },
          { type: "section", text: { type: "mrkdwn", text: "All suites passed." } },
          { type: "divider" },
          { type: "context", elements: [{ type: "mrkdwn", text: "in 4m12s" }] },
        ],
      }),
    });
    expect(blocks.status).toBe(200);
    const after = await api<{ messages: Message[] }>(`/api/channels/${general.id}/messages`, {
      token: bobToken,
    });
    const rendered = after.data.messages.find((m) => m.text.includes("All suites passed."));
    expect(rendered).toBeDefined();
    expect(rendered!.text).toContain("*Nightly*");
    expect(rendered!.text).toContain("in 4m12s");

    // The legacy form-encoded shape works too.
    const form = await fetch(`${base}${hook.data.url}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ payload: JSON.stringify({ text: "from a form post" }) }),
    });
    expect(form.status).toBe(200);

    // A bad secret gets nothing.
    const bad = await fetch(`${base}/hooks/not-a-real-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "should not appear" }),
    });
    expect(bad.status).toBe(404);
  });

  it("accepts Slack-compatible chat.postMessage from a bot token", async () => {
    const general = server.store.getChannelByName("general")!;
    const created = await api<{ app: { id: string }; botUser: User; token: string }>("/api/apps", {
      token: aliceToken,
      body: { name: "Status Bot" },
    });
    const botToken = created.data.token;

    // By channel name, the way most Slack code is written.
    const sent = await api<{ ok: boolean; ts: string; channel: string }>("/api/chat.postMessage", {
      token: botToken,
      body: { channel: "#general", text: "deploy finished" },
    });
    expect(sent.status).toBe(200);
    expect(sent.data.ok).toBe(true);
    expect(sent.data.channel).toBe(general.id);

    // And threaded onto that message using the returned ts.
    const reply = await api<{ ok: boolean }>("/api/chat.postMessage", {
      token: botToken,
      body: { channel: general.id, text: "…and the smoke tests passed", thread_ts: sent.data.ts },
    });
    expect(reply.data.ok).toBe(true);

    const thread = await api<{ messages: Message[] }>(
      `/api/channels/${general.id}/messages?threadRootId=${sent.data.ts}`,
      { token: aliceToken },
    );
    expect(thread.data.messages).toHaveLength(1);

    // Slack-shaped errors, not ours.
    const noAuth = await api<{ ok: boolean; error: string }>("/api/chat.postMessage", {
      body: { channel: "#general", text: "nope" },
    });
    // Slack answers a failed method with 200 and ok:false; see slackError.
    expect(noAuth.status).toBe(200);
    expect(noAuth.data).toEqual({ ok: false, error: "invalid_auth" });

    const noChannel = await api<{ error: string }>("/api/chat.postMessage", {
      token: botToken,
      body: { channel: "#nowhere", text: "nope" },
    });
    expect(noChannel.data.error).toBe("channel_not_found");

    // A session token is not a bot token.
    const wrongToken = await api<{ error: string }>("/api/chat.postMessage", {
      token: aliceToken,
      body: { channel: "#general", text: "nope" },
    });
    expect(wrongToken.data.error).toBe("invalid_auth");
  });

  it("keeps app management to admins, and revoking kills the webhook", async () => {
    const general = server.store.getChannelByName("general")!;
    const denied = await api("/api/apps", { token: bobToken, body: { name: "Bob's Bot" } });
    expect(denied.status).toBe(403);

    const created = await api<{ app: { id: string } }>("/api/apps", {
      token: aliceToken,
      body: { name: "Temp Bot" },
    });
    const hook = await api<{ url: string }>(`/api/apps/${created.data.app.id}/webhooks`, {
      token: aliceToken,
      body: { channelId: general.id },
    });

    const removed = await api(`/api/apps/${created.data.app.id}`, {
      method: "DELETE",
      token: aliceToken,
    });
    expect(removed.status).toBe(200);

    const afterDelete = await fetch(`${base}${hook.data.url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "should be dead" }),
    });
    expect(afterDelete.status).toBe(404);
  });

  it("marks channels read", async () => {
    const general = server.store.getChannelByName("general")!;
    const res = await api(`/api/channels/${general.id}/read`, {
      token: bobToken,
      body: { seq: 999 },
    });
    expect(res.status).toBe(200);
  });

  it("enforces invite-only registration when enabled", async () => {
    server.setInviteOnly(true);
    const noInvite = await api("/api/auth/register", {
      body: { handle: "carol", displayName: "Carol", password: "password123" },
    });
    expect(noInvite.status).toBe(403);

    const invite = await api<{ invite: { code: string } }>("/api/invites", {
      token: aliceToken,
      body: {},
    });
    const withInvite = await api("/api/auth/register", {
      body: {
        handle: "carol",
        displayName: "Carol",
        password: "password123",
        inviteCode: invite.data.invite.code,
      },
    });
    expect(withInvite.status).toBe(201);
    server.setInviteOnly(false);
  });
});
