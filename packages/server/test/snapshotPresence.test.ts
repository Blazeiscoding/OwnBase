import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * A handshake's presence names who is online, and leaves everyone else out
 * (OPT-13): clients read a missing account as offline, and listing every
 * account cost a second read of all of them on each connect.
 */
let server: WorkspaceServer | undefined;
let directory: string;
let base: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-snapshot-presence-"));
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

async function register(handle: string) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  const { token, user } = (await response.json()) as { token: string; user: { id: string } };
  return { token, id: user.id };
}

async function ready(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`);
  sockets.push(ws);
  return new Promise<Extract<ServerToClient, { type: "ready" }>>((resolve, reject) => {
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
      const frame = JSON.parse(String(data)) as ServerToClient;
      if (frame.type === "ready") resolve(frame);
    });
    ws.once("error", reject);
  });
}

describe("presence in a handshake", () => {
  it("names who is online, the reader included, and leaves out everyone else", async () => {
    const ana = await register("ana");
    const ben = await register("ben");
    await register("cai");

    expect((await ready(ana.token)).presence).toEqual({ [ana.id]: "online" });
    const snapshot = await ready(ben.token);
    expect(snapshot.presence).toEqual({ [ana.id]: "online", [ben.id]: "online" });
    // The accounts are all still there to be shown, as offline.
    expect(snapshot.users.map((u) => u.handle).sort()).toEqual(["ana", "ben", "cai"]);
  });
});
