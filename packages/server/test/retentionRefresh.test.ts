import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * What connected readers hear when retention removes old conversation
 * (RECHECK-09). A pass tells each reader of a conversation it touched which
 * threads went, in one event per conversation, and sends fresh mention
 * counts to whoever is connected there, rather than leaving a count or a
 * cached message that the server no longer has.
 */
const DAY = 24 * 3600_000;

let server: WorkspaceServer | undefined;
let directory: string;
let base: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-retention-refresh-"));
  server = await createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    retentionDays: 1,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await server?.stop();
  server = undefined;
  rmSync(directory, { recursive: true, force: true });
});

async function call(token: string, path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as any;
}

async function register(handle: string) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  const { token, user } = (await response.json()) as { token: string; user: { id: string } };
  return { token, id: user.id };
}

/** A reader's socket, and every frame it has had since its snapshot. */
async function connect(token: string, lastSeq: number | null = null) {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`);
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  const ready = await new Promise<Extract<ServerToClient, { type: "ready" }>>((resolve, reject) => {
    ws.once("open", () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          token,
          lastSeq,
          protocolVersion: PROTOCOL_VERSION,
          syncVersion: 1,
        }),
      ),
    );
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as ServerToClient;
      if (frame.type === "ready") resolve(frame);
      else frames.push(frame);
    });
    ws.once("error", reject);
  });
  const events = (type: string) =>
    frames.flatMap((f) => {
      const event = f.type === "event" ? f.envelope.event : f.type === "ephemeral" ? f.event : null;
      return event?.type === type ? [event as any] : [];
    });
  return { ws, ready, frames, events };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/** Makes every message old enough to go, as a day passing would. */
function age() {
  const db = new DatabaseSync(join(directory, "workspace.db"));
  try {
    db.exec(`UPDATE messages SET created_at = created_at - ${2 * DAY}`);
  } finally {
    db.close();
  }
}

describe("retention and the people connected", () => {
  it("sends a reader their mention count afresh, and which threads went", async () => {
    const owner = await register("owner");
    const reader = await register("reader");
    const general = server!.store.getChannelByName("general")!.id;
    await call(reader.token, `/api/channels/${general}/join`, "POST");
    const live = await connect(reader.token);
    const { message } = await call(owner.token, `/api/channels/${general}/messages`, "POST", {
      text: `<@${reader.id}> an old question`,
    });
    await call(owner.token, `/api/channels/${general}/messages`, "POST", {
      text: "a reply",
      threadRootId: message.id,
    });
    await settle();
    expect(live.events("mentions").at(-1)?.counts).toEqual({ [general]: 1 });

    age();
    expect(server!.applyRetention()).toBe(2);
    await settle();
    // The count the server now has, where it used to stay at 1 until a reconnect.
    expect(server!.store.unreadMentionCounts(reader.id)).toEqual({});
    expect(live.events("mentions").at(-1)?.counts).toEqual({});
    // And one event naming the thread, not one per message.
    expect(live.events("history.removed")).toEqual([
      { type: "history.removed", channelId: general, rootIds: [message.id] },
    ]);
  });

  it("tells only those who can read the conversation", async () => {
    const owner = await register("owner");
    const outsider = await register("outsider");
    const { channel } = await call(owner.token, "/api/channels", "POST", {
      type: "private",
      name: "plans",
    });
    const { channel: dm } = await call(owner.token, "/api/channels", "POST", {
      type: "dm",
      memberIds: [outsider.id],
    });
    const third = await register("third");
    await call(owner.token, `/api/channels/${channel.id}/messages`, "POST", { text: "private" });
    await call(owner.token, `/api/channels/${dm.id}/messages`, "POST", { text: "between two" });
    const insider = await connect(owner.token);
    const outside = await connect(outsider.token);
    const stranger = await connect(third.token);

    age();
    server!.applyRetention();
    await settle();
    expect(
      insider
        .events("history.removed")
        .map((e) => e.channelId)
        .sort(),
    ).toEqual([channel.id, dm.id].sort());
    expect(outside.events("history.removed").map((e) => e.channelId)).toEqual([dm.id]);
    expect(stranger.events("history.removed")).toEqual([]);
  });

  it("sends one event per conversation per pass, however many messages went", async () => {
    const owner = await register("owner");
    const general = server!.store.getChannelByName("general")!.id;
    const { channel: other } = await call(owner.token, "/api/channels", "POST", {
      type: "public",
      name: "other",
    });
    for (let i = 0; i < 30; i++) {
      await call(owner.token, `/api/channels/${i % 2 ? general : other.id}/messages`, "POST", {
        text: `old ${i}`,
      });
    }
    const live = await connect(owner.token);
    age();
    expect(server!.applyRetention()).toBe(30);
    await settle();
    const removed = live.events("history.removed");
    expect(removed).toHaveLength(2);
    expect(removed.flatMap((e) => e.rootIds)).toHaveLength(30);
    // A pass with nothing left to remove says nothing.
    expect(server!.applyRetention()).toBe(0);
    await settle();
    expect(live.events("history.removed")).toHaveLength(2);
  });

  it("is heard by a reader who was away, when they catch up", async () => {
    const owner = await register("owner");
    const general = server!.store.getChannelByName("general")!.id;
    const { message } = await call(owner.token, `/api/channels/${general}/messages`, "POST", {
      text: "said before the reader left",
    });
    const before = await connect(owner.token);
    const seq = before.ready.seq;
    before.ws.close();

    age();
    server!.applyRetention();
    const back = await connect(owner.token, seq);
    await settle();
    expect(back.ready.replayFrom).toBe(seq);
    expect(back.events("history.removed")).toEqual([
      { type: "history.removed", channelId: general, rootIds: [message.id] },
    ]);
  });
});
