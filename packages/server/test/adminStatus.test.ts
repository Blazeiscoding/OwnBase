import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type WorkspaceStatus } from "@ownbase/protocol";
import { SCHEMA_VERSION } from "../src/db.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * How the server is running, for its owner and admins (OPS-10): the queues,
 * sizes and connections someone keeping a workspace needs, read without
 * opening the database, and nothing from anyone's conversations.
 */
let server: WorkspaceServer | undefined;
let directory: string;
let base: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-admin-status-"));
  server = await createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
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

async function call(token: string | null, path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function register(handle: string) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  return ((await response.json()) as { token: string }).token;
}

async function connect(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          token,
          lastSeq: null,
          protocolVersion: PROTOCOL_VERSION,
          syncVersion: 1,
        }),
      ),
    );
    ws.on("message", (data) => {
      if (String(data).startsWith('{"type":"ready"')) resolve();
    });
    ws.once("error", reject);
  });
}

describe("the workspace's operational status", () => {
  it("tells the owner the queues, sizes and connections, and nothing anyone wrote", async () => {
    const owner = await register("owner");
    const general = server!.store.getChannelByName("general")!.id;
    const secret = "the launch moves to Thursday";
    await call(owner, `/api/channels/${general}/messages`, "POST", { text: secret });
    await call(owner, `/api/channels/${general}/scheduled`, "POST", {
      text: `${secret}, again`,
      sendAt: Date.now() + 3_600_000,
    });
    await connect(owner);

    const { status, text } = await call(owner, "/api/admin/status");
    expect(status).toBe(200);
    const report = JSON.parse(text) as WorkspaceStatus;
    expect(report).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      deliveries: { waiting: 0, oldestWaitingAt: null, failed: 0 },
      scheduled: { queued: 1, held: 0, failed: 0 },
      retention: { enabled: false, lastSuccessAt: null, failures: 0 },
      connections: { sockets: 1, people: 1 },
      // Less than a minute in, there is no full minute to report.
      eventLoopDelayMs: null,
    });
    expect(report.database.bytes).toBeGreaterThan(0);
    expect(report.diskFreeBytes).toBeGreaterThan(0);
    expect(report.attachments).toEqual({
      bytes: 0,
      limitBytes: null,
      removal: { waiting: 0, retrying: 0, rejected: 0, oldestQueuedAt: null },
    });
    expect(text).not.toContain("Thursday");
    expect(text).not.toContain(owner);
  });

  it("is for the owner and admins only", async () => {
    await register("owner");
    const member = await register("member");
    expect((await call(member, "/api/admin/status")).status).toBe(403);
    expect((await call(null, "/api/admin/status")).status).toBe(401);
  });
});
