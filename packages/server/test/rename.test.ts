import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";

/**
 * The host renaming a workspace while it runs: the desktop app's host dialog
 * does this through `setWorkspaceName`. On the network only its owner and
 * admins can, through Workspace settings (workspaceSettings.test.ts).
 */
describe("renaming a workspace while it runs", () => {
  let server: WorkspaceServer | undefined;
  let dataDir: string | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await server?.stop();
    server = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  async function start(workspaceName?: string) {
    dataDir ??= mkdtempSync(join(tmpdir(), "slackoss-rename-"));
    server = await createWorkspaceServer({
      dataDir,
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      logger: false,
      rateLimits: false,
      ...(workspaceName ? { workspaceName } : {}),
    });
  }

  const base = () => `http://127.0.0.1:${server!.port}`;

  async function register(handle: string): Promise<string> {
    const res = await fetch(`${base()}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
    });
    return ((await res.json()) as { token: string }).token;
  }

  async function serverInfoName(): Promise<string> {
    return ((await (await fetch(`${base()}/api/server-info`)).json()) as { workspaceName: string })
      .workspaceName;
  }

  /** A socket that says hello with `token`, or never signs in when there is none. */
  function socket(token?: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`);
    sockets.push(ws);
    const received: ServerToClient[] = [];
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    ws.on("message", (data) => received.push(JSON.parse(String(data)) as ServerToClient));
    const opened = new Promise<void>((resolve) => ws.on("open", () => resolve()));
    if (token)
      void opened.then(() =>
        ws.send(
          JSON.stringify({
            type: "hello",
            token,
            lastSeq: null,
            protocolVersion: PROTOCOL_VERSION,
          }),
        ),
      );
    const heard = (predicate: (m: ServerToClient) => boolean) =>
      expect.poll(() => received.some(predicate), { timeout: 3000 }).toBe(true);
    return { ws, received, opened, closed, heard };
  }

  const renamed = (name: string) => (m: ServerToClient) =>
    m.type === "ephemeral" &&
    m.event.type === "workspace.renamed" &&
    m.event.workspaceName === name;

  it("tells everyone signed in at once, and keeps the name for the next start", async () => {
    await start("Rocket Team");
    const owner = socket(await register("owner"));
    const member = socket(await register("member"));
    const stranger = socket();
    await owner.heard((m) => m.type === "ready");
    await member.heard((m) => m.type === "ready");
    await stranger.opened;

    server!.setWorkspaceName("  Blue Team ");
    await owner.heard(renamed("Blue Team"));
    await member.heard(renamed("Blue Team"));
    expect(await serverInfoName()).toBe("Blue Team");
    const later = socket(await register("later"));
    await later.heard((m) => m.type === "ready" && m.workspaceName === "Blue Team");
    // A socket that never signed in is told nothing, not even the name.
    expect(stranger.received).toEqual([]);

    // Started again without a name, it keeps the one it was given.
    await server!.stop();
    await start();
    expect(await serverInfoName()).toBe("Blue Team");
    expect(server!.store.getMeta("workspace_name")).toBe("Blue Team");
  });

  it("is not renamed by a socket message, nor by any route but the admins' own", async () => {
    await start("Rocket Team");
    const owner = socket(await register("owner"));
    await owner.heard((m) => m.type === "ready");
    // The event the server sends is not something a client may send back.
    owner.ws.send(JSON.stringify({ type: "workspace.renamed", workspaceName: "Taken Over" }));
    expect(await owner.closed).toBe(4000);
    for (const [method, path] of [
      ["PATCH", "/api/workspace"],
      ["POST", "/api/workspace/rename"],
    ] as const) {
      const res = await fetch(`${base()}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceName: "Taken Over" }),
      });
      expect(res.status).toBe(404);
    }
    expect(await serverInfoName()).toBe("Rocket Team");
  });

  it("refuses a name it would not start with, and keeps the one it has", async () => {
    await start("Rocket Team");
    const member = socket(await register("member"));
    await member.heard((m) => m.type === "ready");
    for (const bad of ["", "   ", "x".repeat(81), "Blue\nTeam", "Blue\u0000Team", 5, null]) {
      expect(() => server!.setWorkspaceName(bad as string)).toThrow(/1 to 80 characters/);
    }
    expect(await serverInfoName()).toBe("Rocket Team");
    expect(
      member.received.filter((m) => m.type === "ephemeral" && m.event.type === "workspace.renamed"),
    ).toEqual([]);
    // The longest name allowed is still allowed.
    server!.setWorkspaceName("x".repeat(80));
    expect(await serverInfoName()).toBe("x".repeat(80));

    const stopping = server!.stop();
    expect(() => server!.setWorkspaceName("Too Late")).toThrow(/stopping/);
    await stopping;
    server = undefined;
  });

  it("announces itself again on request, and does nothing once stopping or when announcing is off", async () => {
    await start("Rocket Team");
    // Announcing is off in these tests, so this must be a quiet no-op.
    expect(() => server!.reannounce()).not.toThrow();
    const stopping = server!.stop();
    expect(() => server!.reannounce()).not.toThrow();
    await stopping;
    server = undefined;
  });

  it("counts each person connected once, and says when that changes", async () => {
    await start("Rocket Team");
    let told = 0;
    const stop = server!.onConnectedChange(() => told++);
    expect(server!.connectedPeople()).toBe(0);

    const owner = await register("owner");
    const laptop = socket(owner);
    await laptop.heard((m) => m.type === "ready");
    await expect.poll(() => server!.connectedPeople()).toBe(1);
    expect(told).toBe(1);
    // A second device of the same person is the same person.
    const phone = socket(owner);
    await phone.heard((m) => m.type === "ready");
    const member = socket(await register("member"));
    await member.heard((m) => m.type === "ready");
    await expect.poll(() => server!.connectedPeople()).toBe(2);
    expect(told).toBe(2);
    // Nor does a socket that never signs in count.
    const stranger = socket();
    await stranger.opened;
    expect(server!.connectedPeople()).toBe(2);

    laptop.ws.close();
    await laptop.closed;
    await expect.poll(() => server!.connectedPeople()).toBe(2);
    phone.ws.close();
    await expect.poll(() => server!.connectedPeople()).toBe(1);
    expect(told).toBe(3);

    stop();
    member.ws.close();
    await expect.poll(() => server!.connectedPeople()).toBe(0);
    expect(told).toBe(3);
  });
});
