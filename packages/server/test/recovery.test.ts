import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import { listAccounts, recoverAccount } from "../src/recover.js";

let server: WorkspaceServer | undefined;
let dataDir: string;
let base: string;
let ownerToken: string;
let peerToken: string;
let peerId: string;
const sockets: WebSocket[] = [];

async function api(path: string, token?: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function start() {
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    workspaceName: "Recovery",
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function stop() {
  await server?.stop();
  server = undefined;
}

/**
 * Opens a socket and collects what the server says. A refused socket is told so
 * before anything else; an accepted one may see presence traffic first, so the
 * caller looks for what it expects rather than assuming an order.
 */
async function connectFrames(token: string): Promise<ServerToClient[]> {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerToClient));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    ),
  );
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  return frames;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-recover-"));
  await start();
  const owner = await api("/api/auth/register", undefined, "POST", {
    handle: "owner",
    displayName: "Owner",
    password: "password123",
  });
  ownerToken = owner.body.token;
  const peer = await api("/api/auth/register", undefined, "POST", {
    handle: "peer",
    displayName: "Peer",
    password: "password123",
  });
  peerToken = peer.body.token;
  peerId = peer.body.user.id;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("password someone else chose", () => {
  it("closes the workspace to an account after an admin reset, until it picks its own", async () => {
    // Working normally beforehand.
    expect((await api("/api/channels", peerToken)).status).toBe(200);

    const reset = await api(`/api/admin/users/${peerId}/password`, ownerToken, "POST");
    const temporary = reset.body.temporaryPassword as string;
    expect(temporary).toBeTruthy();

    // The reset ended the old sessions, and the temporary one gets in but no further.
    expect((await api("/api/channels", peerToken)).status).toBe(401);
    const login = await api("/api/auth/login", undefined, "POST", {
      handle: "peer",
      password: temporary,
    });
    expect(login.body.mustChangePassword).toBe(true);
    const locked = login.body.token as string;

    const refused = await api("/api/channels", locked);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("password_change_required");
    // Reading the workspace over the socket has to be closed too: the refusal
    // comes before anything else, so no snapshot is ever sent.
    const refusedFrames = await connectFrames(locked);
    expect(refusedFrames[0]).toMatchObject({
      type: "error",
      code: "password_change_required",
    });
    expect(refusedFrames.some((f) => f.type === "ready")).toBe(false);

    const changed = await api("/api/auth/password", locked, "POST", {
      currentPassword: temporary,
      newPassword: "chosen-by-me",
    });
    expect(changed.status).toBe(200);
    expect((await api("/api/channels", locked)).status).toBe(200);
    const openFrames = await connectFrames(locked);
    await expect.poll(() => openFrames.some((f) => f.type === "ready")).toBe(true);

    // Signing in again is ordinary now.
    const after = await api("/api/auth/login", undefined, "POST", {
      handle: "peer",
      password: "chosen-by-me",
    });
    expect(after.body.mustChangePassword).toBe(false);
  });

  it("still lets a locked account sign itself out", async () => {
    const reset = await api(`/api/admin/users/${peerId}/password`, ownerToken, "POST");
    const login = await api("/api/auth/login", undefined, "POST", {
      handle: "peer",
      password: reset.body.temporaryPassword,
    });
    expect((await api("/api/auth/logout", login.body.token, "POST")).status).toBe(200);
  });
});

describe("host recovery", () => {
  it("lists the accounts it can recover without touching them", async () => {
    await stop();
    const accounts = listAccounts(dataDir);
    expect(accounts.map((a) => a.handle).sort()).toEqual(["owner", "peer"]);
    expect(accounts.find((a) => a.handle === "owner")).toMatchObject({
      role: "owner",
      deactivated: false,
      mustChangePassword: false,
    });
  });

  it("issues a temporary password for the owner, whom no admin can reset", async () => {
    // The API deliberately refuses this, which is why the host route exists.
    const ownerId = (
      await api("/api/auth/login", undefined, "POST", {
        handle: "owner",
        password: "password123",
      })
    ).body.user.id;
    expect((await api(`/api/admin/users/${ownerId}/password`, ownerToken, "POST")).status).toBe(
      400,
    );

    await stop();
    const result = await recoverAccount({ dataDir, handle: "owner" });
    expect(result.role).toBe("owner");
    expect(result.revokedSessions).toBeGreaterThan(0);

    await start();
    expect(
      (
        await api("/api/auth/login", undefined, "POST", {
          handle: "owner",
          password: "password123",
        })
      ).status,
    ).toBe(401);
    const login = await api("/api/auth/login", undefined, "POST", {
      handle: "owner",
      password: result.temporaryPassword,
    });
    expect(login.body.mustChangePassword).toBe(true);
    expect((await api("/api/channels", login.body.token)).status).toBe(403);
  });

  it("hands the workspace over when its owner is gone", async () => {
    await stop();
    const result = await recoverAccount({ dataDir, handle: "peer", makeOwner: true });
    expect(result.role).toBe("owner");

    const accounts = listAccounts(dataDir);
    expect(accounts.find((a) => a.handle === "peer")?.role).toBe("owner");
    // The previous owner steps down rather than out.
    expect(accounts.find((a) => a.handle === "owner")?.role).toBe("admin");
  });

  it("brings back a deactivated account rather than recovering it into a locked door", async () => {
    expect(
      (await api(`/api/admin/users/${peerId}`, ownerToken, "PATCH", { deactivated: true })).status,
    ).toBe(200);
    await stop();
    expect(listAccounts(dataDir).find((a) => a.handle === "peer")?.deactivated).toBe(true);

    const result = await recoverAccount({ dataDir, handle: "peer" });
    expect(listAccounts(dataDir).find((a) => a.handle === "peer")?.deactivated).toBe(false);

    await start();
    const login = await api("/api/auth/login", undefined, "POST", {
      handle: "peer",
      password: result.temporaryPassword,
    });
    expect(login.body.mustChangePassword).toBe(true);
  });

  it("refuses a handle that is not there, and a directory that is not a workspace", async () => {
    await stop();
    await expect(recoverAccount({ dataDir, handle: "nobody" })).rejects.toThrow(/No account/);
    const empty = mkdtempSync(join(tmpdir(), "ownbase-empty-"));
    try {
      expect(() => listAccounts(empty)).toThrow(/No workspace found/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
