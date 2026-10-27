import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * A claim code the host gives (P7): OwnBase's hosting sends the owner a link
 * holding it, so the workspace must take that code, not make its own.
 */
const servers: WorkspaceServer[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function start(dataDir: string, claimCode?: string) {
  const server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    ...(claimCode ? { claimCode } : {}),
  });
  servers.push(server);
  return server;
}

/** Registers as someone reaching the server through a proxy, as hosting does. */
async function register(server: WorkspaceServer, handle: string, claimCode?: string) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify({
      handle,
      displayName: handle,
      password: "password123",
      ...(claimCode ? { claimCode } : {}),
    }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "ownbase-claim-"));
  folders.push(dir);
  return dir;
};

describe("a claim code the host gives", () => {
  it("is the one the workspace asks for", async () => {
    const server = await start(":memory:", "given-claim-code-0123456789");
    expect(server.claimCode).toBe("given-claim-code-0123456789");
    expect((await register(server, "stranger", "another-code-0123456789")).status).toBe(403);
    const owner = await register(server, "owner", "given-claim-code-0123456789");
    expect(owner.status).toBe(201);
    expect(owner.body.user.role).toBe("owner");
  });

  it("replaces the one before while nobody owns the workspace", async () => {
    const dir = folder();
    const made = await start(dir);
    const first = made.claimCode;
    expect(first).toMatch(/^[0-9a-f]{48}$/);
    await made.stop();
    servers.length = 0;

    const given = await start(dir, "the-host-sent-this-one-01");
    expect(given.claimCode).toBe("the-host-sent-this-one-01");
    expect((await register(given, "owner", first!)).status).toBe(403);
    expect((await register(given, "owner", "the-host-sent-this-one-01")).status).toBe(201);
  });

  it("means nothing once someone owns the workspace", async () => {
    const dir = folder();
    const server = await start(dir, "the-host-sent-this-one-01");
    expect((await register(server, "owner", "the-host-sent-this-one-01")).status).toBe(201);
    await server.stop();
    servers.length = 0;

    const again = await start(dir, "the-host-sent-this-one-01");
    expect(again.claimCode).toBeNull();
    expect(again.store.getMeta("claim_code")).toBe("");
  });
});
