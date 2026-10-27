import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, openDbAtVersion } from "../src/db.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * A scheduled message keeps what it was accepted with: its files, which
 * nothing else can take while it waits, and whether a reply is also shown in
 * the channel.
 */
let server: WorkspaceServer | undefined;
let dataDir: string;
let base: string;
let token: string;
let channelId: string;

async function start() {
  server = await createWorkspaceServer({ dataDir, host: "127.0.0.1", port: 0, mdns: false });
  base = `http://127.0.0.1:${server.port}`;
  const existing = server.store.getUserAuthByHandle("owner");
  const res = await fetch(`${base}/api/auth/${existing ? "login" : "register"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      handle: "owner",
      password: "password123",
      ...(existing ? {} : { displayName: "Owner" }),
    }),
  });
  token = ((await res.json()) as { token: string }).token;
  channelId = server.store.getChannelByName("general")!.id;
}

async function request(path: string, body?: unknown, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function upload(name = "plan.txt"): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob(["the plan"]), name);
  const res = await fetch(`${base}/api/channels/${channelId}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { file: { id: string } }).file.id;
}

const schedule = (body: Record<string, unknown>) =>
  request(`/api/channels/${channelId}/scheduled`, { sendAt: Date.now() + 3_600_000, ...body });
const send = (body: Record<string, unknown>) =>
  request(`/api/channels/${channelId}/messages`, body);
/** Brings a queued row forward instead of idling the test until it is due. */
const deliverNow = (id: string) => {
  server!.store.rescheduleMessage(id, Date.now() - 1000);
  server!.flushScheduled();
  return server!.store.getScheduled(id)!;
};

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-scheduled-files-"));
  await start();
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("a file waiting in a scheduled message", () => {
  it("cannot be sent now by an ordinary message, and is delivered with its schedule", async () => {
    const file = await upload();
    const queued = await schedule({ text: "Later, with the plan", fileIds: [file] });
    expect(queued.status).toBe(201);

    const now = await send({ text: "Now, with the same plan", fileIds: [file] });
    expect(now.status).toBe(409);
    expect(now.body.error).toBe("attachments_scheduled");

    const delivered = deliverNow(queued.body.scheduled.id);
    expect(delivered.status).toBe("sent");
    const message = server!.store.getMessage(delivered.messageId!)!;
    expect(message.files.map((f) => f.id)).toEqual([file]);
  });

  it("cannot be named by a second schedule, or twice by one", async () => {
    const file = await upload();
    expect((await schedule({ text: "First", fileIds: [file] })).status).toBe(201);
    const second = await schedule({ text: "Second", fileIds: [file] });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("attachments_scheduled");

    const other = await upload("other.txt");
    const twice = await schedule({ text: "Twice", fileIds: [other, other] });
    expect(twice.status).toBe(400);
    expect(twice.body.error).toBe("invalid_attachments");
    // Neither refusal left a claim behind.
    expect((await send({ text: "Free", fileIds: [other] })).status).toBe(201);
  });

  it("is free again once its schedule is cancelled", async () => {
    const file = await upload();
    const queued = await schedule({ text: "Maybe later", fileIds: [file] });
    await request(`/api/scheduled/${queued.body.scheduled.id}`, undefined, "DELETE");
    expect((await send({ text: "Now instead", fileIds: [file] })).status).toBe(201);
  });

  it("stays held by a failed schedule, which can still be retried", async () => {
    const root = (await send({ text: "Root" })).body.message;
    const file = await upload();
    const queued = await schedule({ text: "Reply", threadRootId: root.id, fileIds: [file] });
    await request(`/api/messages/${root.id}`, undefined, "DELETE");
    expect(deliverNow(queued.body.scheduled.id).status).toBe("failed");
    // Discarding it is the author's choice; until then the file is still promised.
    expect((await send({ text: "Taken", fileIds: [file] })).status).toBe(409);
  });

  it("is still held after the server restarts", async () => {
    const file = await upload();
    const queued = await schedule({ text: "Across a restart", fileIds: [file] });
    await server!.stop();
    await start();
    expect((await send({ text: "After restart", fileIds: [file] })).status).toBe(409);
    expect(deliverNow(queued.body.scheduled.id).status).toBe("sent");
  });

  it("is not swept away as an abandoned upload", async () => {
    const file = await upload();
    await schedule({ text: "Later", fileIds: [file] });
    expect(server!.store.abandonedFileIds(Date.now() + 1000)).not.toContain(file);
  });
});

describe("a scheduled reply also sent to the channel", () => {
  it("is shown in the channel when delivered, and says so while it waits", async () => {
    const root = (await send({ text: "Root" })).body.message;
    const queued = await schedule({
      text: "For everyone",
      threadRootId: root.id,
      alsoSendToChannel: true,
    });
    expect(queued.body.scheduled).toMatchObject({ threadRootId: root.id, broadcast: true });
    expect((await request("/api/scheduled", undefined, "GET")).body.scheduled[0].broadcast).toBe(
      true,
    );

    const delivered = deliverNow(queued.body.scheduled.id);
    const message = server!.store.getMessage(delivered.messageId!)!;
    expect(message).toMatchObject({ threadRootId: root.id, broadcast: true });
    const timeline = server!.store.listMessages({ channelId, limit: 50 });
    expect(timeline.map((m) => m.text)).toContain("For everyone");
  });

  it("stays in its thread when the choice was not made, and ignores it off a thread", async () => {
    const root = (await send({ text: "Root" })).body.message;
    const quiet = await schedule({ text: "Just the thread", threadRootId: root.id });
    const loose = await schedule({ text: "Not a reply", alsoSendToChannel: true });
    expect(quiet.body.scheduled.broadcast).toBe(false);
    expect(loose.body.scheduled.broadcast).toBe(false);
    deliverNow(quiet.body.scheduled.id);
    const timeline = server!.store.listMessages({ channelId, limit: 50 });
    expect(timeline.map((m) => m.text)).not.toContain("Just the thread");
  });

  it("is part of the request's identity, so a retry cannot change where it lands", async () => {
    const root = (await send({ text: "Root" })).body.message;
    const body = {
      text: "Once",
      threadRootId: root.id,
      nonce: "sched-1",
      sendAt: Date.now() + 3_600_000,
    };
    expect((await schedule({ ...body, alsoSendToChannel: true })).status).toBe(201);
    expect((await schedule({ ...body, alsoSendToChannel: true })).status).toBe(200);
    const changed = await schedule(body);
    expect(changed.status).toBe(409);
    expect(changed.body.error).toBe("nonce_conflict");
  });
});

describe("upgrading a workspace with messages already scheduled", () => {
  it("gives each waiting message its files, the first to have named one keeping it", async () => {
    await server!.stop();
    server = undefined;
    const file = join(dataDir, "old.db");
    // v25 is the last schema before files were held by key.
    const old = openDbAtVersion(file, 25);
    old.exec(`
      INSERT INTO users (id, handle, display_name, password_hash, salt, created_at)
        VALUES ('U1', 'owner', 'Owner', 'x', 'y', 0);
      INSERT INTO channels (id, type, name, creator_id, created_at) VALUES ('C1', 'public', 'general', 'U1', 0);
      INSERT INTO files (id, channel_id, user_id, name, mime, size, created_at)
        VALUES ('F1', 'C1', 'U1', 'a.txt', 'text/plain', 1, 0),
               ('F2', 'C1', 'U1', 'b.txt', 'text/plain', 1, 0);
      INSERT INTO scheduled_messages (id, channel_id, user_id, text, file_ids, send_at, created_at, status)
        VALUES ('S1', 'C1', 'U1', 'first', '["F1"]', 10, 1, 'queued'),
               ('S2', 'C1', 'U1', 'second', '["F1","F2"]', 10, 2, 'held'),
               ('S3', 'C1', 'U1', 'broken', 'not json', 10, 3, 'queued'),
               ('S4', 'C1', 'U1', 'done', '["F2"]', 10, 0, 'sent');
    `);
    old.close();

    const db = openDb(file, undefined, { backupBeforeUpgrade: false });
    try {
      const held = db
        .prepare("SELECT file_id, scheduled_id FROM scheduled_files ORDER BY file_id")
        .all();
      expect(held).toEqual([
        { file_id: "F1", scheduled_id: "S1" },
        { file_id: "F2", scheduled_id: "S2" },
      ]);
      const broadcast = db.prepare("SELECT DISTINCT broadcast FROM scheduled_messages").all();
      expect(broadcast).toEqual([{ broadcast: 0 }]);
    } finally {
      db.close();
    }
  });
});
