import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageUsage } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

let server: WorkspaceServer | undefined;
let dataDir: string;
let base: string;
let token: string;
let channelId: string;

const MAX_FILE = 1024 * 1024;

async function start(maxStorageBytes?: number, abandonedUploadTtlMs?: number) {
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    maxFileSize: MAX_FILE,
    maxStorageBytes,
    abandonedUploadTtlMs,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function stop() {
  await server?.stop();
  server = undefined;
}

/** Registers on first start, signs in again after a restart. */
async function signIn() {
  const existing = server!.store.getUserAuthByHandle("owner");
  const res = await fetch(`${base}/api/auth/${existing ? "login" : "register"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      handle: "owner",
      password: "password123",
      ...(existing ? {} : { displayName: "Owner" }),
    }),
  });
  const body = (await res.json()) as any;
  token = body.token;
  channelId = server!.store.getChannelByName("general")!.id;
}

/** Uploads `bytes` of filler and reports what the server made of it. */
async function upload(bytes: number, name = `blob-${bytes}.bin`) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes).fill(7)]), name);
  const res = await fetch(`${base}/api/channels/${channelId}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function usage(): Promise<StorageUsage> {
  const res = await fetch(`${base}/api/storage`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as StorageUsage;
}

const blobsOnDisk = () => readdirSync(join(dataDir, "files"));

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-storage-"));
});

afterEach(async () => {
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("workspace storage quota", () => {
  it("reports what is used, allowed and left", async () => {
    await start(400 * 1024);
    await signIn();
    expect(await usage()).toEqual({
      usedBytes: 0,
      limitBytes: 400 * 1024,
      availableBytes: 400 * 1024,
      maxFileBytes: MAX_FILE,
    });

    expect((await upload(100 * 1024)).status).toBe(201);
    const after = await usage();
    expect(after.usedBytes).toBe(100 * 1024);
    expect(after.availableBytes).toBe(300 * 1024);
  });

  it("is unlimited unless the host sets a limit", async () => {
    await start();
    await signIn();
    const reported = await usage();
    expect(reported.limitBytes).toBeNull();
    expect(reported.availableBytes).toBeNull();
    expect((await upload(200 * 1024)).status).toBe(201);
    expect((await usage()).usedBytes).toBe(200 * 1024);
  });

  it("refuses an upload that would not fit, and keeps nothing behind", async () => {
    await start(150 * 1024);
    await signIn();
    expect((await upload(100 * 1024)).status).toBe(201);
    const before = await usage();

    const refused = await upload(100 * 1024);
    expect(refused.status).toBe(507);
    expect(refused.body.error).toBe("storage_quota_exceeded");

    // The refused attempt leaves neither a blob nor a reservation behind, so
    // what still fits still fits.
    expect(blobsOnDisk()).toHaveLength(1);
    expect((await usage()).usedBytes).toBe(before.usedBytes);
    expect((await upload(40 * 1024)).status).toBe(201);
  });

  it("frees the space back when the attachment is deleted", async () => {
    await start(200 * 1024);
    await signIn();
    const uploaded = await upload(150 * 1024);
    expect(uploaded.status).toBe(201);
    // Filling it leaves no room for another.
    expect((await upload(100 * 1024)).status).toBe(507);

    const posted = await fetch(`${base}/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "with a file", nonce: "n1", fileIds: [uploaded.body.file.id] }),
    });
    expect(posted.status).toBe(201);
    const message = ((await posted.json()) as any).message;

    await fetch(`${base}/api/messages/${message.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    await expect.poll(async () => (await usage()).usedBytes).toBe(0);
    expect((await upload(100 * 1024)).status).toBe(201);
  });

  it("counts what is already on disk when the server restarts", async () => {
    await start(300 * 1024);
    await signIn();
    expect((await upload(120 * 1024)).status).toBe(201);
    await stop();

    await start(300 * 1024);
    await signIn();
    expect((await usage()).usedBytes).toBe(120 * 1024);
    // The restart did not forget it, so the remaining room is the remaining room.
    expect((await upload(200 * 1024)).status).toBe(507);
    expect((await upload(150 * 1024)).status).toBe(201);
  });

  it("never lets concurrent uploads take more room than there is", async () => {
    await start(250 * 1024);
    await signIn();
    // Either alone fits; together they do not. Reserving as the bytes arrive is
    // what stops both from being waved through on the same free space. Which of
    // them loses is not defined — both may, since they reach the wall together
    // holding part of it each — so the guarantees are that the limit holds and
    // that whatever is refused leaves nothing behind.
    const results = await Promise.all([upload(200 * 1024, "a.bin"), upload(200 * 1024, "b.bin")]);
    expect(results.filter((r) => r.status === 201).length).toBeLessThan(2);
    for (const refused of results.filter((r) => r.status !== 201)) {
      expect(refused.status).toBe(507);
    }

    const after = await usage();
    expect(after.usedBytes).toBeLessThanOrEqual(250 * 1024);
    expect(after.usedBytes).toBe(blobsOnDisk().length * 200 * 1024);

    // Whatever happened, the workspace is left usable rather than wedged: a
    // retry is judged on the room actually left, not on the failed attempts.
    const retry = await upload(200 * 1024, "c.bin");
    expect(retry.status).toBe(after.availableBytes! >= 200 * 1024 ? 201 : 507);
  });

  it("gives back the space an oversized file used before it was cut off", async () => {
    await start(4 * 1024 * 1024);
    await signIn();
    const rejected = await upload(2 * 1024 * 1024);
    expect(rejected.status).toBe(413);
    expect(blobsOnDisk()).toHaveLength(0);
    expect((await usage()).usedBytes).toBe(0);

    // The workspace is not quietly poorer for the attempt.
    expect((await upload(900 * 1024)).status).toBe(201);
  }, 30_000);

  it("keeps refusing when a limit is lowered below what is already stored", async () => {
    await start(500 * 1024);
    await signIn();
    expect((await upload(300 * 1024)).status).toBe(201);
    await stop();

    await start(100 * 1024);
    await signIn();
    const reported = await usage();
    expect(reported.usedBytes).toBe(300 * 1024);
    // Over the line rather than negative: there is no room, not minus room.
    expect(reported.availableBytes).toBe(0);
    expect((await upload(1024)).status).toBe(507);
  });

  it("refuses a limit that is not a size", async () => {
    await expect(
      createWorkspaceServer({
        dataDir,
        host: "127.0.0.1",
        port: 0,
        mdns: false,
        maxStorageBytes: -1,
      }),
    ).rejects.toThrow(/non-negative/);
    await expect(
      createWorkspaceServer({
        dataDir,
        host: "127.0.0.1",
        port: 0,
        mdns: false,
        maxStorageBytes: 1.5,
      }),
    ).rejects.toThrow(/safe integer/);
  });
});

describe("abandoned uploads", () => {
  /** Ages an upload past the sweep line without waiting for real time. */
  function backdate(fileId: string, msAgo: number) {
    server!.store.transaction(() => {
      (
        server!.store as unknown as {
          db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } };
        }
      ).db
        .prepare("UPDATE files SET created_at = ? WHERE id = ?")
        .run(Date.now() - msAgo, fileId);
    });
  }

  it("frees an upload nobody ever sent, and its space with it", async () => {
    await start(400 * 1024, 3600_000);
    await signIn();
    const uploaded = await upload(150 * 1024);
    expect(uploaded.status).toBe(201);
    const id = uploaded.body.file.id as string;

    // Still fresh: someone may be about to send it.
    expect(server!.expireAbandonedUploads()).toBe(0);
    expect((await usage()).usedBytes).toBe(150 * 1024);

    backdate(id, 2 * 3600_000);
    expect(server!.expireAbandonedUploads()).toBe(1);
    await server!.flushFileDeletions();

    expect(blobsOnDisk()).toHaveLength(0);
    expect((await usage()).usedBytes).toBe(0);
    expect(server!.store.getFile(id)).toBeNull();
  });

  it("leaves an upload that was actually sent alone", async () => {
    await start(400 * 1024, 3600_000);
    await signIn();
    const uploaded = await upload(100 * 1024);
    const id = uploaded.body.file.id as string;
    const posted = await fetch(`${base}/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "sent", nonce: "n1", fileIds: [id] }),
    });
    expect(posted.status).toBe(201);

    backdate(id, 90 * 24 * 3600_000);
    expect(server!.expireAbandonedUploads()).toBe(0);
    await server!.flushFileDeletions();
    expect(blobsOnDisk()).toEqual([id]);
  });

  it("keeps attachments a scheduled message is still waiting to send", async () => {
    await start(400 * 1024, 3600_000);
    await signIn();
    const uploaded = await upload(100 * 1024);
    const id = uploaded.body.file.id as string;

    // Scheduled well beyond the sweep line: its files are old by the time it sends.
    const scheduled = await fetch(`${base}/api/channels/${channelId}/scheduled`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        text: "later",
        sendAt: Date.now() + 7 * 24 * 3600_000,
        fileIds: [id],
        nonce: "later-1",
      }),
    });
    expect(scheduled.status).toBe(201);

    backdate(id, 30 * 24 * 3600_000);
    expect(server!.expireAbandonedUploads()).toBe(0);
    await server!.flushFileDeletions();
    expect(blobsOnDisk()).toEqual([id]);
    expect((await usage()).usedBytes).toBe(100 * 1024);
  });

  it("does nothing at all when the scheduled queue cannot be read", async () => {
    await start(400 * 1024, 3600_000);
    await signIn();
    const uploaded = await upload(100 * 1024);
    const id = uploaded.body.file.id as string;
    backdate(id, 30 * 24 * 3600_000);

    const db = (
      server!.store as unknown as {
        db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } };
      }
    ).db;
    db.prepare(
      `INSERT INTO scheduled_messages (id, channel_id, user_id, text, thread_root_id, file_ids, send_at, created_at)
       VALUES ('01BROKENBROKENBROKENBROKEN', ?, ?, 'x', NULL, 'not json', ?, ?)`,
    ).run(
      channelId,
      server!.store.getUserAuthByHandle("owner")!.id,
      Date.now() + 60_000,
      Date.now(),
    );

    // An unreadable row means some unknown files are spoken for. Guessing would
    // delete someone's attachment, so the sweep declines to run.
    expect(server!.expireAbandonedUploads()).toBe(0);
    await server!.flushFileDeletions();
    expect(blobsOnDisk()).toEqual([id]);
  });

  it("reclaims a blob left behind by a crash between writing and recording it", async () => {
    await start(400 * 1024);
    await signIn();
    expect((await upload(50 * 1024)).status).toBe(201);
    await stop();

    // Exactly what a process killed mid-upload leaves: bytes on disk that no
    // row accounts for, counting against the cap with nothing to delete them.
    const stray = "01STRAYSTRAYSTRAYSTRAYSTRA";
    writeFileSync(join(dataDir, "files", stray), new Uint8Array(120 * 1024));

    await start(400 * 1024);
    await signIn();
    await server!.flushFileDeletions();
    expect(blobsOnDisk()).toHaveLength(1);
    expect(blobsOnDisk()).not.toContain(stray);
    // Its bytes came back too, rather than being charged to the workspace forever.
    expect((await usage()).usedBytes).toBe(50 * 1024);
  });

  it("refuses an expiry window that would sweep uploads as they land", async () => {
    await expect(
      createWorkspaceServer({
        dataDir,
        host: "127.0.0.1",
        port: 0,
        mdns: false,
        abandonedUploadTtlMs: 0,
      }),
    ).rejects.toThrow(/positive/);
  });
});
