import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type Message, type ServerToClient } from "@ownbase/protocol";
import { openDb, openDbAtVersion, SCHEMA_VERSION } from "../src/db.js";
import { Store } from "../src/store.js";
import { ulid } from "../src/ids.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

const actions = [
  {
    actionId: "rsvp",
    blockId: "meeting",
    text: "Meeting RSVP",
    value: "attending",
    style: "default" as const,
    url: "https://example.invalid/meeting-details",
  },
];
let server: WorkspaceServer;
let base: string;
let token: string;
let owner: string;
let channel: string;
const sockets: WebSocket[] = [];

async function api(method: string, path: string, body?: unknown, auth = token) {
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

const database = () => (server.store as unknown as { db: DatabaseSync }).db;

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    retentionDays: 1,
  });
  base = `http://127.0.0.1:${server.port}`;
  const registered = await api("POST", "/api/auth/register", {
    handle: "owner",
    displayName: "Owner",
    password: "password123",
  });
  token = registered.body.token;
  owner = registered.body.user.id;
  channel = server.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.stop();
});

async function replay(after: number) {
  const socket = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(socket);
  const frames: ServerToClient[] = [];
  socket.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerToClient));
  socket.on("open", () =>
    socket.send(
      JSON.stringify({
        type: "hello",
        token,
        lastSeq: after,
        syncVersion: 1,
        protocolVersion: PROTOCOL_VERSION,
      }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "synced")).toBe(true);
  return frames.flatMap((f) =>
    f.type === "event" &&
    (f.envelope.event.type === "message.created" || f.envelope.event.type === "message.updated")
      ? [f.envelope.event.message]
      : [],
  );
}

describe("complete message content cleanup (N06/N07)", () => {
  it.each(["delete", "retention"])(
    "omits removed button content from stored rows and real replay after %s",
    async (operation) => {
      const created = await api("POST", "/api/apps", { name: "Meeting App" });
      const botToken = created.body.token;
      const after = server.store.currentSeq();
      const post = async (text: string) =>
        (
          await api(
            "POST",
            "/api/chat.postMessage",
            {
              channel,
              text,
              blocks: [
                {
                  type: "actions",
                  block_id: "meeting",
                  elements: [
                    {
                      type: "button",
                      action_id: "rsvp",
                      text: { type: "plain_text", text: "Meeting RSVP" },
                      value: "attending",
                      url: "https://example.invalid/meeting-details",
                    },
                  ],
                },
              ],
            },
            botToken,
          )
        ).body.message as Message;
      const removed = await post("The earlier meeting.");
      const live = await post("The next meeting.");
      if (operation === "delete") {
        expect((await api("DELETE", `/api/messages/${removed.id}`)).status).toBe(200);
        const row = database()
          .prepare("SELECT text, actions FROM messages WHERE id = ?")
          .get(removed.id);
        expect(row).toEqual({ text: "", actions: "[]" });
      } else {
        database()
          .prepare("UPDATE messages SET created_at = ? WHERE id = ?")
          .run(Date.now() - 2 * 86400_000, removed.id);
        expect(server.applyRetention()).toBe(1);
      }
      const replayed = await replay(after);
      expect(replayed.find((m) => m.id === removed.id)).toMatchObject({
        text: "",
        files: [],
        actions: [],
      });
      expect(replayed.find((m) => m.id === live.id)?.actions).toEqual(actions);
      expect(server.store.getMessage(live.id)?.actions).toEqual(actions);
      expect(
        (await api("GET", `/api/channels/${channel}/messages`)).body.messages.map(
          (m: Message) => m.id,
        ),
      ).toEqual([live.id]);
    },
  );

  it("strips superseded buttons while preserving the current message's actions", async () => {
    const message = server.store.createMessage({
      channelId: channel,
      userId: owner,
      text: "Earlier agenda",
      threadRootId: null,
      nonce: null,
      actions,
    });
    const before = server.store.appendEvent({ type: "message.created", message }, channel).seq - 1;
    server.store.transaction(() => {
      const edited = server.store.editMessage(message.id, "Updated agenda");
      server.store.appendEvent({ type: "message.updated", message: edited }, channel);
    });
    const versions = (await replay(before)).filter((m) => m.id === message.id);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ text: "", files: [], actions: [] });
    expect(versions[1]).toMatchObject({ text: "Updated agenda", actions });
  });

  it("keeps completion identity without retaining sent text or files across edit/delete/retention", async () => {
    const file = server.store.createFile({
      channelId: channel,
      userId: owner,
      name: "agenda.txt",
      mime: "text/plain",
      size: 10,
      width: null,
      height: null,
    });
    const body = {
      text: "The earlier agenda",
      fileIds: [file.id],
      nonce: "schedule-once",
      sendAt: Date.now() + 3600_000,
    };
    const path = `/api/channels/${channel}/scheduled`;
    const queued = await api("POST", path, body);
    expect(queued.status).toBe(201);
    const id = queued.body.scheduled.id;
    server.store.rescheduleMessage(id, Date.now() - 1);
    server.flushScheduled();
    const completed = server.store.getScheduled(id)!;
    expect(completed).toMatchObject({
      status: "sent",
      text: "",
      fileIds: [],
      messageId: expect.any(String),
    });
    expect(server.store.getMessage(completed.messageId!)?.files.map((f) => f.id)).toEqual([
      file.id,
    ]);
    const retried = await api("POST", path, body);
    expect(retried.status).toBe(200);
    expect(retried.body.scheduled.id).toBe(id);
    expect((await api("POST", path, { ...body, text: "Different" })).status).toBe(409);
    expect(
      (
        await api("PATCH", `/api/messages/${completed.messageId}`, {
          text: "The current agenda",
          expectedText: body.text,
        })
      ).status,
    ).toBe(200);
    expect((await api("DELETE", `/api/messages/${completed.messageId}`)).status).toBe(200);
    database()
      .prepare("UPDATE messages SET created_at = ? WHERE id = ?")
      .run(Date.now() - 2 * 86400_000, completed.messageId);
    expect(server.applyRetention()).toBe(1);
    server.store.pruneScheduled(Date.now() - 7 * 86400_000);
    expect(server.store.getScheduled(id)).toMatchObject({
      status: "sent",
      text: "",
      fileIds: [],
      messageId: null,
    });
    expect((await api("GET", "/api/scheduled")).body.scheduled).toEqual([]);
    expect((await api("POST", path, body)).status).toBe(200);
    expect(server.store.listMessages({ channelId: channel, limit: 10 })).toEqual([]);
  });

  it("upgrades old content copies without changing live buttons or outstanding work", () => {
    const directory = mkdtempSync(join(tmpdir(), "ownbase-content-upgrade-"));
    const path = join(directory, "workspace.db");
    let db: DatabaseSync | undefined;
    try {
      db = openDbAtVersion(path, 36);
      const store = new Store(db);
      const user = store.createUser({
        handle: "owner",
        displayName: "Owner",
        passwordHash: "unused",
        salt: "unused",
        role: "owner",
      });
      const room = store.createChannel({
        type: "public",
        name: "meetings",
        creatorId: user.id,
        memberIds: [user.id],
      });
      // Written and read as v36 did: the store's own insert names columns
      // added since, and its read joins tables added since (link previews),
      // neither of which a v36 workspace has.
      const asWritten = (id: string): Message => {
        const row = db!.prepare("SELECT * FROM messages WHERE id = ?").get(id) as {
          id: string;
          channel_id: string;
          user_id: string;
          text: string;
          created_at: number;
          edited_at: number | null;
          actions: string;
        };
        return {
          id: row.id,
          channelId: row.channel_id,
          userId: row.user_id,
          text: row.text,
          threadRootId: null,
          broadcast: false,
          seq: 0,
          createdAt: row.created_at,
          editedAt: row.edited_at,
          nonce: null,
          replyCount: 0,
          reactions: [],
          files: [],
          pinned: false,
          actions: JSON.parse(row.actions),
        };
      };
      const make = (text: string) => {
        const id = ulid();
        db!
          .prepare(
            `INSERT INTO messages (id, channel_id, user_id, text, thread_root_id, created_at, actions)
             VALUES (?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(id, room.id, user.id, text, Date.now(), JSON.stringify(actions));
        return asWritten(id);
      };
      const deleted = make("Removed");
      const live = make("Original");
      const purged = make("Expired");
      for (const message of [deleted, live, purged])
        store.appendEvent({ type: "message.created", message }, room.id);
      db.prepare("UPDATE messages SET text = '', deleted_at = 1 WHERE id = ?").run(deleted.id);
      db.prepare("DELETE FROM messages WHERE id = ?").run(purged.id);
      db.prepare("UPDATE messages SET text = 'Current', edited_at = 1 WHERE id = ?").run(live.id);
      const latest = store.appendEvent(
        { type: "message.updated", message: asWritten(live.id) },
        room.id,
      );
      // v36 already scrubbed old text/files, but retained their actions.
      db.prepare(
        "UPDATE events SET payload = json_set(payload, '$.message.text', '', '$.message.files', json('[]')) WHERE seq < ?",
      ).run(latest.seq);
      const sent = store.scheduleMessage({
        channelId: room.id,
        userId: user.id,
        text: "Old sent words",
        fileIds: [],
        threadRootId: null,
        sendAt: 1,
      });
      db.prepare(
        "UPDATE scheduled_messages SET status = 'sent', file_ids = '[\"old-file\"]' WHERE id = ?",
      ).run(sent.id);
      const outstanding = ["queued", "held", "failed"].map((status) => {
        const scheduled = store.scheduleMessage({
          channelId: room.id,
          userId: user.id,
          text: `${status} words`,
          fileIds: [],
          threadRootId: null,
          sendAt: 100,
        });
        db!
          .prepare("UPDATE scheduled_messages SET status = ? WHERE id = ?")
          .run(status, scheduled.id);
        return scheduled.id;
      });
      db.close();
      db = openDb(path);
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
      const upgraded = new Store(db);
      expect(db.prepare("SELECT actions FROM messages WHERE id = ?").get(deleted.id)).toEqual({
        actions: "[]",
      });
      expect(upgraded.getMessage(live.id)?.actions).toEqual(actions);
      const events = upgraded.eventsSince(0, user.id)!;
      const versions = events.flatMap(({ event }) =>
        event.type === "message.created" || event.type === "message.updated" ? [event.message] : [],
      );
      expect(
        versions
          .filter((m) => m.id !== live.id || m.text !== "Current")
          .every((m) => m.actions.length === 0),
      ).toBe(true);
      expect(versions.find((m) => m.id === live.id && m.text === "Current")?.actions).toEqual(
        actions,
      );
      expect(upgraded.getScheduled(sent.id)).toMatchObject({
        status: "sent",
        text: "",
        fileIds: [],
      });
      for (const id of outstanding) expect(upgraded.getScheduled(id)?.text).toMatch(/words$/);
      db.close();
      db = openDb(path);
      expect(new Store(db).getScheduled(sent.id)?.text).toBe("");
    } finally {
      db?.close();
      if (
        dirname(resolve(directory)) !== resolve(tmpdir()) ||
        !basename(directory).startsWith("ownbase-content-upgrade-")
      )
        throw new Error("unexpected test cleanup directory");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
