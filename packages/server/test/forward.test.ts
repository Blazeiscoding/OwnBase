import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Forwarding a message (E1): a new message, with words of its own or none,
 * that carries another under it as a card. The sender must be able to read
 * the original. Its words, files and author show only where everyone who can
 * read the forward can read the original too: from a public channel, or from
 * the same conversation. Read afresh, so the card follows edits and deletion,
 * and the log's copies do too.
 */
let server: WorkspaceServer;
let base: string;
let root: string;
let owner: { token: string; id: string };
let peer: { token: string; id: string };
let outsider: { token: string; id: string };
let general: string;
const sockets: WebSocket[] = [];

async function request(path: string, auth: string, body?: unknown, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${auth}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

const send = (auth: string, channel: string, body: Record<string, unknown>) =>
  request(`/api/channels/${channel}/messages`, auth, body);

const post = async (auth: string, channel: string, body: Record<string, unknown>) => {
  const res = await send(auth, channel, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.message;
};

const register = async (handle: string) => {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  const created = (await res.json()) as any;
  return { token: created.token as string, id: created.user.id as string };
};

const channel = async (type: "public" | "private", name: string, memberIds: string[]) =>
  (await request("/api/channels", owner.token, { type, name, memberIds })).body.channel
    .id as string;

/** Everything the event log holds, as the raw text it is stored as. */
const logged = () => JSON.stringify(server.store.eventsSince(0, owner.id, 100_000) ?? []);

/** The log's copies of one message, oldest first. */
const loggedCopies = (id: string) =>
  (server.store.eventsSince(0, owner.id, 100_000) ?? []).flatMap(({ event }) =>
    (event.type === "message.created" || event.type === "message.updated") &&
    event.message.id === id
      ? [event.message]
      : [],
  );

/** One message as a reader of its conversation gets it now. */
const read = async (auth: string, channelId: string, id: string) =>
  (await request(`/api/channels/${channelId}/messages`, auth, undefined, "GET")).body.messages.find(
    (m: { id: string }) => m.id === id,
  );

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ownbase-forward-"));
  server = await createWorkspaceServer({
    dataDir: root,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  owner = await register("owner");
  peer = await register("peer");
  outsider = await register("outsider");
  general = server.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("forwarding a message", () => {
  it("carries a public original's words, files and author under the comment", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1, 2, 3])]), "plan.pdf");
    const uploaded = await fetch(`${base}/api/channels/${general}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${peer.token}` },
      body: form,
    });
    const { file } = (await uploaded.json()) as { file: { id: string } };
    const original = await post(peer.token, general, {
      text: "The launch plan",
      fileIds: [file.id],
    });
    const leads = await channel("private", "leads", [outsider.id]);

    const forward = await post(owner.token, leads, {
      text: "Worth a look",
      forwardFrom: original.id,
    });

    expect(forward.text).toBe("Worth a look");
    expect(forward.forwardedFrom).toEqual({
      id: original.id,
      channelId: general,
      userId: peer.id,
      text: "The launch plan",
      files: [expect.objectContaining({ id: file.id, name: "plan.pdf" })],
      createdAt: original.createdAt,
      deleted: false,
      hidden: false,
    });
    // Everyone reading the forward can open its file, as they can the original's.
    const download = await fetch(`${base}/api/files/${file.id}`, {
      headers: { authorization: `Bearer ${outsider.token}` },
    });
    expect(download.status).toBe(200);
    expect((await read(outsider.token, leads, forward.id)).forwardedFrom.text).toBe(
      "The launch plan",
    );
  });

  it("goes with no words of its own, and the server says it forwards", async () => {
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
    await expect
      .poll(() => frames.find((f) => f.type === "ready"))
      .toMatchObject({ forwards: true });

    const original = await post(peer.token, general, { text: "Lunch at noon" });
    const forward = await post(owner.token, general, { text: "", forwardFrom: original.id });
    expect(forward.forwardedFrom).toMatchObject({ id: original.id, text: "Lunch at noon" });
    // Without anything to forward, an empty message is still refused.
    expect((await send(owner.token, general, { text: "" })).status).toBe(400);
  });

  it("shows nothing of a private original forwarded elsewhere, and all of it within", async () => {
    const secret = await channel("private", "secret", [peer.id]);
    const original = await post(peer.token, secret, { text: "The salary bands" });

    const outside = await post(owner.token, general, { text: "FYI", forwardFrom: original.id });
    const hidden = {
      id: original.id,
      channelId: secret,
      userId: "",
      text: "",
      files: [],
      createdAt: 0,
      deleted: false,
      hidden: true,
    };
    expect(outside.forwardedFrom).toEqual(hidden);
    expect((await read(outsider.token, general, outside.id)).forwardedFrom).toEqual(hidden);
    // Nor does the log hold them for anyone reading #general.
    expect(loggedCopies(outside.id).map((m) => m.forwardedFrom)).toEqual([hidden]);

    const inside = await post(owner.token, secret, { text: "", forwardFrom: original.id });
    expect(inside.forwardedFrom).toMatchObject({ text: "The salary bands", hidden: false });
  });

  it("refuses what its sender cannot read, a deleted message, and one that is not there", async () => {
    const secret = await channel("private", "secret", [peer.id]);
    const original = await post(peer.token, secret, { text: "Only for us" });
    const refused = await send(outsider.token, general, {
      text: "look",
      forwardFrom: original.id,
    });
    expect(refused).toEqual({
      status: 404,
      body: expect.objectContaining({ error: "message_not_found" }),
    });

    const gone = await post(peer.token, general, { text: "Typo" });
    await request(`/api/messages/${gone.id}`, peer.token, undefined, "DELETE");
    expect((await send(owner.token, general, { text: "", forwardFrom: gone.id })).status).toBe(404);
    expect((await send(owner.token, general, { text: "", forwardFrom: "01NOPE" })).status).toBe(
      404,
    );
    expect(logged()).not.toContain('Only for us","files');
  });

  it("follows the original's edits and its deletion, in what it shows and in the log", async () => {
    const original = await post(peer.token, general, { text: "Meet at 3" });
    const forward = await post(owner.token, general, { text: "", forwardFrom: original.id });

    await request(`/api/messages/${original.id}`, peer.token, { text: "Meet at 4" }, "PATCH");
    expect((await read(owner.token, general, forward.id)).forwardedFrom.text).toBe("Meet at 4");
    expect(loggedCopies(forward.id).map((m) => m.forwardedFrom?.text)).toEqual(["Meet at 4"]);
    expect(logged()).not.toContain("Meet at 3");

    await request(`/api/messages/${original.id}`, peer.token, undefined, "DELETE");
    const deleted = {
      id: original.id,
      channelId: general,
      userId: "",
      text: "",
      files: [],
      createdAt: 0,
      deleted: true,
      hidden: false,
    };
    expect((await read(owner.token, general, forward.id)).forwardedFrom).toEqual(deleted);
    expect(loggedCopies(forward.id).map((m) => m.forwardedFrom)).toEqual([deleted]);
    expect(logged()).not.toContain("Meet at 4");
  });

  it("passes on the original when forwarding a forward with nothing of its own", async () => {
    const original = await post(peer.token, general, { text: "The original" });
    const bare = await post(owner.token, general, { text: "", forwardFrom: original.id });
    const again = await post(peer.token, general, { text: "", forwardFrom: bare.id });
    expect(again.forwardedFrom.id).toBe(original.id);

    const commented = await post(owner.token, general, {
      text: "My take",
      forwardFrom: original.id,
    });
    const onward = await post(peer.token, general, { text: "", forwardFrom: commented.id });
    expect(onward.forwardedFrom).toMatchObject({ id: commented.id, text: "My take" });
  });

  it("refuses to pass on a forward whose original its sender cannot read, or that is gone", async () => {
    const unavailable = {
      status: 409,
      body: expect.objectContaining({ error: "forward_unavailable" }),
    };
    const secret = await channel("private", "secret", [peer.id]);
    const hidden = await post(owner.token, general, {
      text: "",
      forwardFrom: (await post(peer.token, secret, { text: "Only for us" })).id,
    });
    expect(hidden.forwardedFrom.hidden).toBe(true);
    expect(await send(outsider.token, general, { text: "", forwardFrom: hidden.id })).toEqual(
      unavailable,
    );
    // Someone who can read the original there passes it on.
    const passed = await post(peer.token, secret, { text: "", forwardFrom: hidden.id });
    expect(passed.forwardedFrom).toMatchObject({ text: "Only for us", hidden: false });

    const typo = await post(peer.token, general, { text: "Typo" });
    const deleted = await post(owner.token, general, { text: "", forwardFrom: typo.id });
    await request(`/api/messages/${typo.id}`, peer.token, undefined, "DELETE");
    expect(await send(outsider.token, general, { text: "", forwardFrom: deleted.id })).toEqual(
      unavailable,
    );

    const old = await post(peer.token, general, { text: "Old news" });
    await new Promise((done) => setTimeout(done, 5));
    const purged = await post(owner.token, general, { text: "", forwardFrom: old.id });
    server.store.transaction(() => server.store.purgeMessagesBefore(old.createdAt + 1));
    expect(await send(outsider.token, general, { text: "", forwardFrom: purged.id })).toEqual(
      unavailable,
    );
  });

  it("says the original is gone once it goes with older history", async () => {
    const original = await post(peer.token, general, { text: "Old news" });
    await new Promise((done) => setTimeout(done, 5));
    const forward = await post(owner.token, general, { text: "", forwardFrom: original.id });
    server.store.transaction(() => server.store.purgeMessagesBefore(original.createdAt + 1));
    expect((await read(owner.token, general, forward.id)).forwardedFrom).toMatchObject({
      id: original.id,
      deleted: true,
      text: "",
    });
    expect(logged()).not.toContain("Old news");
  });
});
