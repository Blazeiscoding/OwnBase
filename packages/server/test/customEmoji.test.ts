import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  CUSTOM_EMOJI_LIMIT,
  PROTOCOL_VERSION,
  type CustomEmoji,
  type ServerToClient,
} from "@ownbase/protocol";
import { DURABLE_EVENTS } from "../src/events/registry.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Custom emoji (J12): a picture under a name, checked from its own bytes,
 * added by members, removed by whoever added it or an admin, told to everyone
 * and usable as a reaction while it exists.
 */
let server: WorkspaceServer | undefined;
let dataDir: string;
let base: string;
let owner: { token: string; id: string };
let peer: { token: string; id: string };
const sockets: WebSocket[] = [];

async function request(
  path: string,
  body?: unknown,
  method = "POST",
  auth: string | null = owner.token,
  type = "application/json",
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body === undefined ? {} : { "content-type": type }),
    },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let json: any = {};
  try {
    json = bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
  } catch {
    // A picture, not JSON.
  }
  return { status: response.status, body: json, bytes, headers: response.headers };
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
const ephemeral = (frames: ServerToClient[], type: string) =>
  frames.flatMap((f) => (f.type === "ephemeral" && f.event.type === type ? [f.event] : []));

/** A real PNG of one colour. */
function png(width = 4, height = 4): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array(width).fill([200, 90, 60]).flat()),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A GIF's header and screen descriptor, which is all the server reads of one. */
function gif(width: number, height: number): Buffer {
  const head = Buffer.alloc(32);
  head.write("GIF89a", 0, "ascii");
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  head[31] = 0x3b;
  return head;
}

const add = (name: string, bytes = png(), type = "image/png", auth = owner.token) =>
  request(`/api/emoji?name=${encodeURIComponent(name)}`, bytes, "POST", auth, type);

async function joinAsGuest() {
  server!.setAccessPolicy("guest_allowed");
  const joined = await fetch(`${base}/api/auth/guest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Visitor" }),
  });
  return ((await joined.json()) as { token: string }).token;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-emoji-"));
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
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
  server = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("adding a custom emoji", () => {
  it("keeps a good picture, tells everyone, lists it and serves it", async () => {
    const theirs = await connect(peer.token);
    const picture = png(32, 32);
    const added = await add("party-parrot", picture, "image/png", peer.token);
    expect(added.status).toBe(201);
    const emoji = added.body.emoji as CustomEmoji;
    expect(emoji).toMatchObject({ name: "party-parrot", createdBy: peer.id });

    await expect
      .poll(() => ephemeral(theirs, "emoji.added"))
      .toEqual([{ type: "emoji.added", emoji }]);
    expect((await request("/api/emoji", undefined, "GET")).body.emoji).toEqual([emoji]);
    const later = await connect(owner.token);
    const ready = later.find((f) => f.type === "ready") as any;
    expect(ready.customEmoji).toEqual([emoji]);
    expect(ready.emojiAddingAdminsOnly).toBe(false);

    const served = await request(`/api/emoji/${emoji.id}/picture`, undefined, "GET");
    expect(served.status).toBe(200);
    expect(served.bytes.equals(picture)).toBe(true);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect((await request(`/api/emoji/${emoji.id}/picture`, undefined, "GET", null)).status).toBe(
      401,
    );

    const audit = server!.store.audit.list({ limit: 10 });
    expect(audit[0]).toMatchObject({
      action: "emoji.added",
      actorId: peer.id,
      targetType: "emoji",
      targetId: emoji.id,
      details: { name: "party-parrot", type: "image/png" },
    });
  });

  it("takes a GIF, so emoji can move", async () => {
    expect((await add("hello-wave", gif(64, 64), "image/gif")).status).toBe(201);
  });

  it("refuses a picture over the size cap", async () => {
    const big = Buffer.concat([png(), Buffer.alloc(256 * 1024)]);
    const refused = await add("big", big);
    expect(refused.status).toBe(413);
    expect(refused.body.error).toBe("emoji_too_large");
  });

  it("refuses a picture over 256 pixels a side", async () => {
    const refused = await add("wide", gif(300, 20), "image/gif");
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe("An emoji is at most 256 pixels on either side.");
  });

  it("refuses SVG, JPEG, and a file that is not what it says", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect((await add("drawn", svg, "image/svg+xml")).status).toBe(415);
    expect((await add("photo", png(), "image/jpeg")).status).toBe(415);
    const wrong = await add("liar", png(), "image/gif");
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toBe("That file says it is GIF but holds a PNG image.");
    expect((await request("/api/emoji", undefined, "GET")).body.emoji).toEqual([]);
  });

  it("refuses a name a standard emoji has, a taken one, and one that breaks the rule", async () => {
    const standard = await add("smile");
    expect(standard.status).toBe(409);
    expect(standard.body.error).toBe("emoji_name_taken");
    expect((await add("thumbsup")).status).toBe(409);
    expect((await add("ours")).status).toBe(201);
    expect((await add("ours")).body.error).toBe("emoji_name_taken");
    for (const name of ["Caps", "two words", "", "a".repeat(33), ":colons:"])
      expect((await add(name)).body.error, name).toBe("invalid_emoji_name");
  });

  it("refuses emoji number 1,001", async () => {
    const store = server!.store;
    store.transaction(() => {
      for (let i = 0; i < CUSTOM_EMOJI_LIMIT; i++)
        store.emoji.add(`e${i}`, { type: "image/png", bytes: png() }, owner.id);
    });
    const refused = await add("one-more");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("emoji_limit");
    expect(store.emoji.count()).toBe(CUSTOM_EMOJI_LIMIT);
  });

  it("is not for guests, who still see and use them", async () => {
    const guest = await joinAsGuest();
    expect((await add("visitor", png(), "image/png", guest)).status).toBe(403);
    const emoji = (await add("ours")).body.emoji as CustomEmoji;
    expect((await request("/api/emoji", undefined, "GET", guest)).body.emoji).toEqual([emoji]);
    expect((await request(`/api/emoji/${emoji.id}/picture`, undefined, "GET", guest)).status).toBe(
      200,
    );
  });

  it("can be kept to admins, which members are told", async () => {
    const theirs = await connect(peer.token);
    expect(
      (await request("/api/admin/workspace/emoji-adding", { adminsOnly: true }, "PUT", peer.token))
        .status,
    ).toBe(403);
    const set = await request("/api/admin/workspace/emoji-adding", { adminsOnly: true }, "PUT");
    expect(set.body).toEqual({ adminsOnly: true });
    await expect
      .poll(() => ephemeral(theirs, "workspace.emojiAdding"))
      .toEqual([{ type: "workspace.emojiAdding", adminsOnly: true }]);
    const refused = await add("mine", png(), "image/png", peer.token);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("emoji_adding_restricted");
    expect((await add("theirs")).status).toBe(201);
    expect(server!.store.audit.list({ limit: 10 }).map((e) => e.action)).toContain(
      "workspace.emoji_adding_changed",
    );
  });
});

describe("removing a custom emoji", () => {
  it("is for whoever added it and for admins, not for other members", async () => {
    const third = await register("third");
    const peers = (await add("peers", png(), "image/png", peer.token)).body.emoji as CustomEmoji;
    const refused = await request(`/api/emoji/${peers.id}`, undefined, "DELETE", third.token);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("not_your_emoji");

    const theirs = await connect(third.token);
    expect((await request(`/api/emoji/${peers.id}`, undefined, "DELETE", peer.token)).status).toBe(
      200,
    );
    await expect
      .poll(() => ephemeral(theirs, "emoji.removed"))
      .toEqual([{ type: "emoji.removed", id: peers.id, name: "peers" }]);
    expect((await request(`/api/emoji/${peers.id}/picture`, undefined, "GET")).status).toBe(404);

    const thirds = (await add("thirds", png(), "image/png", third.token)).body.emoji as CustomEmoji;
    expect((await request(`/api/emoji/${thirds.id}`, undefined, "DELETE")).status).toBe(200);
    expect(server!.store.audit.list({ limit: 10 })[0]).toMatchObject({
      action: "emoji.removed",
      actorId: owner.id,
      targetId: thirds.id,
      details: { name: "thirds" },
    });
  });

  it("stays with whoever added it once adding is kept to admins", async () => {
    const theirs = (await add("theirs", png(), "image/png", peer.token)).body.emoji as CustomEmoji;
    await request("/api/admin/workspace/emoji-adding", { adminsOnly: true }, "PUT");
    expect((await add("another", png(), "image/png", peer.token)).status).toBe(403);
    expect((await request(`/api/emoji/${theirs.id}`, undefined, "DELETE", peer.token)).status).toBe(
      200,
    );
  });

  it("gives a name added again a new picture address", async () => {
    const first = (await add("again")).body.emoji as CustomEmoji;
    await request(`/api/emoji/${first.id}`, undefined, "DELETE");
    const second = (await add("again", gif(8, 8), "image/gif")).body.emoji as CustomEmoji;
    expect(second.id).not.toBe(first.id);
  });
});

describe("a custom emoji as a reaction", () => {
  const react = (messageId: string, emoji: string, method = "PUT", auth = owner.token) =>
    request(
      `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      undefined,
      method,
      auth,
    );

  async function post(text: string) {
    const channel = server!.store.channels.byName("general")!;
    const sent = await request(`/api/channels/${channel.id}/messages`, { text, nonce: text });
    return sent.body.message.id as string;
  }

  it("is taken while the emoji exists, and refused when it does not", async () => {
    const messageId = await post("hello");
    expect((await react(messageId, ":our-parrot:")).body.error).toBe("unknown_emoji");
    await add("our-parrot");
    expect((await react(messageId, ":our-parrot:")).status).toBe(200);
    expect((await react(messageId, "👍")).status).toBe(200);
    const reactions = server!.store.messages.get(messageId)!.reactions;
    expect(reactions.map((r) => r.emoji).sort()).toEqual([":our-parrot:", "👍"].sort());
  });

  it("stays on its messages when the emoji is removed", async () => {
    const messageId = await post("hello again");
    const emoji = (await add("our-parrot")).body.emoji as CustomEmoji;
    await react(messageId, ":our-parrot:");
    await request(`/api/emoji/${emoji.id}`, undefined, "DELETE");
    expect(server!.store.messages.get(messageId)!.reactions.map((r) => r.emoji)).toEqual([
      ":our-parrot:",
    ]);
    // Taking it off still works, though the emoji is gone.
    expect((await react(messageId, ":our-parrot:", "DELETE")).status).toBe(200);
    expect(server!.store.messages.get(messageId)!.reactions).toEqual([]);
  });
});

describe("a message that uses a custom emoji", () => {
  it("is found by searching for the emoji's name", async () => {
    await add("party-parrot");
    const channel = server!.store.channels.byName("general")!;
    await request(`/api/channels/${channel.id}/messages`, {
      text: "ship it :party-parrot:",
      nonce: "search-1",
    });
    const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
    for (const q of ["party-parrot", ":party-parrot:", "parrot"]) {
      const found = await request(
        `/api/search?tz=${tz}&q=${encodeURIComponent(q)}`,
        undefined,
        "GET",
      );
      expect(
        found.body.messages.map((m: { text: string }) => m.text),
        q,
      ).toEqual(["ship it :party-parrot:"]);
    }
  });
});

describe("a custom emoji's reaction, as apps are told of it", () => {
  const event = (emoji: string) =>
    ({ channelId: "C1", messageId: "M1", emoji, userId: "U1" }) as const;

  it("is its name without colons, as Slack sends it; any other reaction is as it was", () => {
    const added = DURABLE_EVENTS["reaction.added"].app.slack({
      type: "reaction.added",
      ...event(":party-parrot:"),
    });
    const removed = DURABLE_EVENTS["reaction.removed"].app.slack({
      type: "reaction.removed",
      ...event(":party-parrot:"),
    });
    expect(added).toMatchObject({ type: "reaction_added", reaction: "party-parrot" });
    expect(removed).toMatchObject({ type: "reaction_removed", reaction: "party-parrot" });
    expect(
      DURABLE_EVENTS["reaction.added"].app.slack({ type: "reaction.added", ...event("🎉") }),
    ).toMatchObject({ reaction: "🎉" });
  });
});
