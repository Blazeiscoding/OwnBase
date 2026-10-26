import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient, type User } from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * A status that clears itself (UX-61): set with an end, the server clears it
 * at that time and says so to everyone, as if its owner had cleared it.
 */
const servers: WorkspaceServer[] = [];
const sockets: WebSocket[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of servers.splice(0)) await server.stop();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function start(dataDir = ":memory:") {
  const server = await createWorkspaceServer({ dataDir, host: "127.0.0.1", port: 0, mdns: false });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (path: string, token: string, body?: unknown, method = "POST") => {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const register = async (handle: string) => {
    const response = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
    });
    const created = (await response.json()) as any;
    return { token: created.token as string, id: created.user.id as string };
  };
  return { server, base, call, register };
}

async function listen(base: string, token: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerToClient));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  return frames;
}

const updates = (frames: ServerToClient[], userId: string): User[] =>
  frames.flatMap((f) =>
    f.type === "event" &&
    f.envelope.event.type === "user.updated" &&
    f.envelope.event.user.id === userId
      ? [f.envelope.event.user]
      : [],
  );

describe("a status that clears itself", () => {
  it("is cleared at its time, and everyone hears so", async () => {
    const { base, call, register } = await start();
    const owner = await register("owner");
    const peer = await register("peer");
    const heard = await listen(base, peer.token);

    const ends = Date.now() + 400;
    const set = await call(
      "/api/me",
      owner.token,
      {
        statusEmoji: "💬",
        statusText: "In a meeting",
        statusExpiresAt: ends,
      },
      "PATCH",
    );
    expect(set.status).toBe(200);
    expect(set.body.user).toMatchObject({ statusText: "In a meeting", statusExpiresAt: ends });

    await expect
      .poll(() => updates(heard, owner.id).at(-1), { timeout: 3_000 })
      .toMatchObject({ statusText: "", statusEmoji: "" });
    expect(updates(heard, owner.id).at(-1)).not.toHaveProperty("statusExpiresAt");
    const me = await call("/api/me", owner.token, undefined, "GET");
    expect(me.body.user).toMatchObject({ statusText: "", statusEmoji: "" });
    expect(me.body.user).not.toHaveProperty("statusExpiresAt");
  });

  it("keeps a status set without an end, which drops an earlier one's", async () => {
    const { call, register } = await start();
    const owner = await register("owner");
    await call(
      "/api/me",
      owner.token,
      {
        statusText: "In a meeting",
        statusExpiresAt: Date.now() + 300,
      },
      "PATCH",
    );
    const again = await call("/api/me", owner.token, { statusText: "Heads down" }, "PATCH");
    expect(again.body.user).not.toHaveProperty("statusExpiresAt");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const me = await call("/api/me", owner.token, undefined, "GET");
    expect(me.body.user.statusText).toBe("Heads down");
  });

  it("keeps its end when only the name changes", async () => {
    const { call, register } = await start();
    const owner = await register("owner");
    const ends = Date.now() + 60_000;
    await call(
      "/api/me",
      owner.token,
      { statusText: "Out for lunch", statusExpiresAt: ends },
      "PATCH",
    );
    const renamed = await call("/api/me", owner.token, { displayName: "Owner Two" }, "PATCH");
    expect(renamed.body.user).toMatchObject({ statusText: "Out for lunch", statusExpiresAt: ends });
  });

  it("clears at once an end that has already passed", async () => {
    const { call, register } = await start();
    const owner = await register("owner");
    await call(
      "/api/me",
      owner.token,
      {
        statusText: "Off sick",
        statusExpiresAt: Date.now() - 1_000,
      },
      "PATCH",
    );
    await expect
      .poll(async () => (await call("/api/me", owner.token, undefined, "GET")).body.user.statusText)
      .toBe("");
  });

  it("clears as the server starts a status that ended while it was stopped", async () => {
    const folder = mkdtempSync(join(tmpdir(), "ownbase-status-"));
    folders.push(folder);
    const first = await start(folder);
    const owner = await first.register("owner");
    await first.call(
      "/api/me",
      owner.token,
      {
        statusText: "On holiday",
        statusExpiresAt: Date.now() + 300,
      },
      "PATCH",
    );
    await first.server.stop();
    servers.splice(servers.indexOf(first.server), 1);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const second = await start(folder);
    await expect
      .poll(
        async () =>
          (await second.call("/api/me", owner.token, undefined, "GET")).body.user.statusText,
      )
      .toBe("");
  });
});
