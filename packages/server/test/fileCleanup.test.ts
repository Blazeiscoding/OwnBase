import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import { hashToken } from "../src/auth.js";

let server: WorkspaceServer;
let directory: string;
let base: string;
let token: string;
let channelId: string;
async function start() {
  server = await createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
  });
  base = `http://127.0.0.1:${server.port}`;
}
async function request(path: string, method: string, body?: unknown) {
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
async function attachedMessage() {
  const form = new FormData();
  form.append("file", new Blob(["original attachment"]), "test.txt");
  const uploaded = await fetch(`${base}/api/channels/${channelId}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const { file } = (await uploaded.json()) as { file: { id: string } };
  const { body } = await request(`/api/channels/${channelId}/messages`, "POST", {
    text: "with attachment",
    fileIds: [file.id],
  });
  return { message: body.message, fileId: file.id, path: join(directory, "files", file.id) };
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-cleanup-"));
  await start();
  token = (
    await request("/api/auth/register", "POST", {
      handle: "owner",
      displayName: "Owner",
      password: "password123",
    })
  ).body.token;
  channelId = server.store.getChannelByName("general")!.id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await server.stop();
  rmSync(directory, { recursive: true, force: true });
});

describe("committed file cleanup", () => {
  it("keeps the message, metadata and blob when deletion rolls back", async () => {
    const item = await attachedMessage();
    vi.spyOn(server.store, "appendEvent").mockImplementationOnce(() => {
      throw new Error("event write failed");
    });
    expect((await request(`/api/messages/${item.message.id}`, "DELETE")).status).toBe(500);
    expect(server.store.getMessage(item.message.id)!.files[0]!.id).toBe(item.fileId);
    expect(readFileSync(item.path, "utf8")).toBe("original attachment");
    expect(server.store.pendingFileDeletions()).toEqual([]);
    expect((await request(`/api/messages/${item.message.id}`, "DELETE")).status).toBe(200);
    expect(existsSync(item.path)).toBe(false);
    expect(server.store.pendingFileDeletions()).toEqual([]);
  });

  it("retains failed cleanup across restart and removes the blob on retry", async () => {
    const item = await attachedMessage();
    // An empty directory makes unlink fail on every platform, like an unavailable blob.
    rmSync(item.path);
    mkdirSync(item.path);
    expect((await request(`/api/messages/${item.message.id}`, "DELETE")).status).toBe(200);
    expect(server.store.getMessage(item.message.id)).toBeNull();
    expect(server.store.pendingFileDeletions()).toEqual([item.fileId]);
    await server.stop();
    await start();
    // Its wait after failing outlasts the restart: it is not tried again yet.
    expect(server.store.dueFileDeletions(Date.now(), 100)).toEqual([]);
    expect(server.store.fileDeletionCounts()).toMatchObject({ waiting: 0, retrying: 1 });
    rmdirSync(item.path);
    writeFileSync(item.path, "original attachment");
    await server.flushFileDeletions(Date.now() + 3_600_000);
    expect(existsSync(item.path)).toBe(false);
    expect(server.store.pendingFileDeletions()).toEqual([]);
  });

  describe("removing many, some of which fail (REV-02)", () => {
    const ulid = (n: number) => `01K${String(n).padStart(23, "0")}`;
    async function uploaded(name: string) {
      const form = new FormData();
      form.append("file", new Blob([`bytes of ${name}`]), name);
      const response = await fetch(`${base}/api/channels/${channelId}/files`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
      });
      return ((await response.json()) as { file: { id: string } }).file.id;
    }
    /** Deletes an upload's row and queues its blob, as removing its message does. */
    function forget(id: string) {
      server.store.transaction(() => {
        server.store.deleteFiles([id]);
        server.store.queueFileDeletions([id]);
      });
    }
    const status = async () => (await request("/api/admin/status", "GET")).body.attachments;

    it("does not let a hundred that fail hold back the next, and frees its bytes", async () => {
      // Directories where files should be make every removal fail, on every platform.
      const failing = Array.from({ length: 100 }, (_, n) => `00${String(n).padStart(24, "0")}`);
      for (const id of failing) mkdirSync(join(directory, "files", id));
      server.store.queueFileDeletions(failing);
      const healthy = await uploaded("healthy.txt");
      const counted = (await status()).bytes;
      expect(counted).toBeGreaterThan(0);
      forget(healthy);

      await server.flushFileDeletions();
      await expect.poll(() => existsSync(join(directory, "files", healthy))).toBe(false);
      const after = await status();
      expect(after.bytes).toBe(counted - "bytes of healthy.txt".length);
      expect(after.removal).toMatchObject({ waiting: 0, retrying: 100, rejected: 0 });

      // A restart keeps them waiting, not first in line again.
      await server.stop();
      await start();
      expect(server.store.dueFileDeletions(Date.now(), 100)).toEqual([]);
      expect((await status()).removal).toMatchObject({ waiting: 0, retrying: 100 });
    });

    it("sets aside a name the server never gives a file, and says so", async () => {
      server.store.queueFileDeletions(["../outside"]);
      await server.flushFileDeletions(Date.now() + 86_400_000);
      expect(server.store.pendingFileDeletions()).toEqual(["../outside"]);
      expect(server.store.dueFileDeletions(Date.now() + 86_400_000, 100)).toEqual([]);
      expect((await status()).removal).toMatchObject({ rejected: 1, waiting: 0, retrying: 0 });
    });

    it("drains a thousand removals page after page, without waiting for the timer", async () => {
      const ids = Array.from({ length: 1_000 }, (_, n) => ulid(n));
      for (const id of ids) writeFileSync(join(directory, "files", id), "x");
      server.store.queueFileDeletions(ids);
      await server.flushFileDeletions();
      // The timer comes every fifteen seconds; the pages follow each other at once.
      await expect
        .poll(() => server.store.pendingFileDeletions().length, { timeout: 5_000 })
        .toBe(0);
      expect(readdirSync(join(directory, "files")).filter((name) => ids.includes(name))).toEqual(
        [],
      );
    });
  });

  it("rejects an upload whose session was revoked while its body streamed", async () => {
    const req = httpRequest(`${base}/api/channels/${channelId}/files`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "multipart/form-data; boundary=upload-test",
      },
    });
    const result = new Promise<number>((resolve, reject) => {
      req.on("response", (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode!));
      });
      req.on("error", reject);
    });
    // Attach rejection handling immediately if setup fails before awaiting the response.
    void result.catch(() => {});
    try {
      req.write(
        '--upload-test\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nfirst bytes',
      );
      await expect.poll(() => readdirSync(join(directory, "files")).length).toBe(1);
      server.store.deleteSession(hashToken(token));
      req.end("\r\n--upload-test--\r\n");
      expect(await result).toBe(401);
      expect(readdirSync(join(directory, "files"))).toEqual([]);
    } finally {
      req.destroy();
    }
  });
});
