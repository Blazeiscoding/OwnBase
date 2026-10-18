import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  type AccessPolicy,
  type AuditEntry,
  type ReadySnapshot,
  type ServerToClient,
} from "@slackoss/protocol";
import { keptSettingsNotes } from "../src/config.js";
import {
  createWorkspaceServer,
  type WorkspaceChange,
  type WorkspaceServer,
} from "../src/server.js";

/**
 * Workspace settings (UX-60): the owner and admins rename the workspace and
 * choose who may join, by the same rules as the host, and a start never puts
 * back an older choice over theirs.
 */
type Person = { token: string; user: { id: string; handle: string; role: string } };
let server: WorkspaceServer | undefined;
let dataDir: string | undefined;
let base = "";
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
  server = undefined;
  const folder = dataDir;
  dataDir = undefined;
  if (folder) rmSync(folder, { recursive: true, force: true });
});

async function start(
  opts: { workspaceName?: string; inviteOnly?: boolean; accessPolicy?: AccessPolicy } = {},
) {
  dataDir ??= mkdtempSync(join(tmpdir(), "slackoss-workspace-settings-"));
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
    ...opts,
  });
  base = `http://127.0.0.1:${server.port}`;
  return server;
}

async function call(method: string, path: string, token?: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: (text ? JSON.parse(text) : {}) as any };
}

async function register(handle: string): Promise<Person> {
  const { status, data } = await call("POST", "/api/auth/register", undefined, {
    handle,
    displayName: handle,
    password: "password123",
  });
  expect(status, JSON.stringify(data)).toBe(201);
  return data;
}

/** An owner, an admin and a member, in a workspace that lets guests in too. */
async function workspace(opts: Parameters<typeof start>[0] = {}) {
  await start(opts);
  const owner = await register("owner");
  const admin = await register("admin");
  const member = await register("member");
  expect(
    (await call("PATCH", `/api/admin/users/${admin.user.id}`, owner.token, { role: "admin" }))
      .status,
  ).toBe(200);
  return { owner, admin, member };
}

async function joinAsGuest(displayName = "Visitor"): Promise<Person> {
  const { status, data } = await call("POST", "/api/auth/guest", undefined, { displayName });
  expect(status, JSON.stringify(data)).toBe(201);
  return data;
}

const rename = (token: string | undefined, name: unknown) =>
  call("PUT", "/api/admin/workspace/name", token, { name });
const choose = (token: string | undefined, accessPolicy: unknown) =>
  call("PUT", "/api/admin/workspace/access-policy", token, { accessPolicy });

async function connect(token: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  let closed: number | null = null;
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerToClient));
  ws.on("close", (code) => (closed = code));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  const heard = (
    predicate: (event: Extract<ServerToClient, { type: "ephemeral" }>["event"]) => boolean,
  ) =>
    expect
      .poll(() => frames.some((f) => f.type === "ephemeral" && predicate(f.event)), {
        timeout: 3000,
      })
      .toBe(true);
  return {
    frames,
    closed: () => closed,
    ready: () => frames.find((f): f is ReadySnapshot => f.type === "ready")!,
    heard,
  };
}

async function audit(token: string): Promise<AuditEntry[]> {
  const { status, data } = await call("GET", "/api/admin/audit?limit=200", token);
  expect(status).toBe(200);
  return data.entries;
}

describe("renaming the workspace and choosing who may join", () => {
  it("is for the owner and admins; a member and a guest are refused", async () => {
    const { owner, admin, member } = await workspace();
    server!.setAccessPolicy("guest_allowed");
    const guest = await joinAsGuest();

    expect(await rename(owner.token, " Blue Team ")).toEqual({
      status: 200,
      data: { workspaceName: "Blue Team" },
    });
    expect(await rename(admin.token, "Green Team")).toEqual({
      status: 200,
      data: { workspaceName: "Green Team" },
    });
    expect(await choose(admin.token, "account_required")).toEqual({
      status: 200,
      data: { accessPolicy: "account_required" },
    });
    expect(await choose(owner.token, "invite_only")).toEqual({
      status: 200,
      data: { accessPolicy: "invite_only" },
    });

    for (const refused of [
      await rename(member.token, "Taken Over"),
      await choose(member.token, "guest_allowed"),
    ])
      expect([refused.status, refused.data.error]).toEqual([403, "admin_only"]);
    // The guest was signed out when guests stopped being allowed; a new one
    // cannot join now. Let one in again to ask as a guest.
    expect((await call("GET", "/api/me", guest.token)).status).toBe(401);
    server!.setAccessPolicy("guest_allowed");
    const another = await joinAsGuest("Second");
    for (const refused of [
      await rename(another.token, "Taken Over"),
      await choose(another.token, "account_required"),
    ])
      expect(refused.status).toBe(403);
    for (const refused of [
      await rename(undefined, "Nobody"),
      await choose(undefined, "invite_only"),
    ])
      expect(refused.status).toBe(401);

    expect(server!.workspaceName()).toBe("Green Team");
    expect(server!.accessPolicy()).toBe("guest_allowed");
    expect((await call("GET", "/api/server-info")).data).toMatchObject({
      workspaceName: "Green Team",
      accessPolicy: "guest_allowed",
    });
  });

  it("refuses a name or a rule it would not start with, and keeps what it has", async () => {
    const { owner } = await workspace({ workspaceName: "Rocket Team" });
    for (const bad of ["", "   ", "x".repeat(81), "Blue\nTeam", "Blue\u0000Team", 5, null]) {
      const refused = await rename(owner.token, bad);
      expect([refused.status, refused.data.error], JSON.stringify(bad)).toEqual([
        400,
        "invalid_request",
      ]);
    }
    for (const bad of ["everyone", "", null, 1, ["guest_allowed"]]) {
      const refused = await choose(owner.token, bad);
      expect([refused.status, refused.data.error], JSON.stringify(bad)).toEqual([
        400,
        "invalid_request",
      ]);
    }
    expect((await call("PUT", "/api/admin/workspace/name", owner.token, {})).status).toBe(400);
    expect(server!.workspaceName()).toBe("Rocket Team");
    expect(server!.accessPolicy()).toBe("account_required");
    // The longest name allowed is allowed here too.
    expect((await rename(owner.token, "x".repeat(80))).status).toBe(200);
    expect(server!.workspaceName()).toBe("x".repeat(80));
  });

  it("signs every guest out, sockets too, when an admin stops allowing guests", async () => {
    const { admin, member } = await workspace({ accessPolicy: "guest_allowed" });
    const guest = await joinAsGuest();
    const guestSocket = await connect(guest.token);
    const memberSocket = await connect(member.token);

    expect((await choose(admin.token, "account_required")).status).toBe(200);
    expect((await call("GET", "/api/me", guest.token)).status).toBe(401);
    await expect.poll(guestSocket.closed).not.toBeNull();
    // Accounts carry on.
    expect((await call("GET", "/api/me", member.token)).status).toBe(200);
    expect(memberSocket.closed()).toBeNull();
    const refused = await call("POST", "/api/auth/guest", undefined, { displayName: "Late" });
    expect(refused.status).toBe(403);
  });

  it("tells everyone signed in, and the next snapshot says the same", async () => {
    const { owner, admin, member } = await workspace({ workspaceName: "Rocket Team" });
    const ownerSocket = await connect(owner.token);
    const memberSocket = await connect(member.token);
    expect(memberSocket.ready()).toMatchObject({
      workspaceSettings: true,
      accessPolicy: "account_required",
      workspaceName: "Rocket Team",
    });

    await rename(admin.token, "Blue Team");
    await choose(admin.token, "invite_only");
    for (const socket of [ownerSocket, memberSocket]) {
      await socket.heard((e) => e.type === "workspace.renamed" && e.workspaceName === "Blue Team");
      await socket.heard(
        (e) => e.type === "workspace.accessPolicy" && e.accessPolicy === "invite_only",
      );
    }
    const later = await connect(member.token);
    expect(later.ready()).toMatchObject({
      workspaceSettings: true,
      accessPolicy: "invite_only",
      workspaceName: "Blue Team",
    });

    // Choosing what it already is changes nothing, and says nothing.
    const before = memberSocket.frames.length;
    expect((await choose(owner.token, "invite_only")).status).toBe(200);
    expect((await rename(owner.token, "Blue Team")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(memberSocket.frames.length).toBe(before);
  });

  it("records who changed what, the host as the host, and tells whoever hosts it", async () => {
    const { owner, admin } = await workspace({ workspaceName: "Rocket Team" });
    const changes: WorkspaceChange[] = [];
    const stop = server!.onWorkspaceChange((change) => changes.push(change));

    await rename(admin.token, "Blue Team");
    await choose(owner.token, "guest_allowed");
    server!.setAccessPolicy("invite_only");
    server!.setWorkspaceName("Rocket Team");
    // The same again is not a change.
    await choose(owner.token, "invite_only");
    server!.setInviteOnly(true);
    stop();
    await rename(admin.token, "Unheard");

    // Nothing after it stopped listening, and nothing for what was no change.
    expect(changes).toEqual([
      { workspaceName: "Blue Team", by: admin.user.id },
      { accessPolicy: "guest_allowed", by: owner.user.id },
      { accessPolicy: "invite_only", by: null },
      { workspaceName: "Rocket Team", by: null },
    ]);
    const entries = (await audit(owner.token))
      .filter((entry) => entry.action.startsWith("workspace."))
      .map(({ actorId, action, targetType, targetId, details }) => ({
        actorId,
        action,
        targetType,
        targetId,
        details,
      }));
    expect(entries).toEqual([
      {
        actorId: admin.user.id,
        action: "workspace.renamed",
        targetType: "workspace",
        targetId: null,
        details: { from: "Rocket Team", to: "Unheard" },
      },
      {
        actorId: null,
        action: "workspace.renamed",
        targetType: "workspace",
        targetId: null,
        details: { from: "Blue Team", to: "Rocket Team" },
      },
      {
        actorId: null,
        action: "workspace.access_policy_changed",
        targetType: "workspace",
        targetId: null,
        details: { from: "guest_allowed", to: "invite_only" },
      },
      {
        actorId: owner.user.id,
        action: "workspace.access_policy_changed",
        targetType: "workspace",
        targetId: null,
        details: { from: "account_required", to: "guest_allowed" },
      },
      {
        actorId: admin.user.id,
        action: "workspace.renamed",
        targetType: "workspace",
        targetId: null,
        details: { from: "Rocket Team", to: "Blue Team" },
      },
    ]);
  });
});

describe("what a start is given", () => {
  it("names a new workspace and says who may join it, until it has an owner", async () => {
    await start({ workspaceName: "First Try", accessPolicy: "guest_allowed" });
    await server!.stop();
    // Nobody owns it yet, so a second start may still correct the first.
    await start({ workspaceName: "Rocket Team", inviteOnly: true });
    expect(server!.workspaceName()).toBe("Rocket Team");
    expect(server!.accessPolicy()).toBe("invite_only");
    await register("owner");
    await server!.stop();

    // Owned now: what it holds stays, whatever the start says.
    await start({ workspaceName: "Other Name", accessPolicy: "guest_allowed" });
    expect(server!.workspaceName()).toBe("Rocket Team");
    expect(server!.accessPolicy()).toBe("invite_only");
    await server!.stop();
    await start({ inviteOnly: false });
    expect(server!.accessPolicy()).toBe("invite_only");
  });

  it("keeps what an admin chose over what the next start is given", async () => {
    const { admin } = await workspace({ workspaceName: "Rocket Team" });
    await rename(admin.token, "Blue Team");
    await choose(admin.token, "guest_allowed");
    await server!.stop();
    await start({ workspaceName: "Rocket Team", inviteOnly: true });
    expect(server!.workspaceName()).toBe("Blue Team");
    expect(server!.accessPolicy()).toBe("guest_allowed");
    expect((await call("GET", "/api/server-info")).data).toMatchObject({
      workspaceName: "Blue Team",
      accessPolicy: "guest_allowed",
      requiresInvite: false,
    });
  });

  it("still refuses a rule that is not one, owned or not, and leaves the folder free", async () => {
    const { owner } = await workspace();
    expect(owner.user.role).toBe("owner");
    await server!.stop();
    server = undefined;
    await expect(start({ accessPolicy: "everyone" as AccessPolicy })).rejects.toThrow(
      /accessPolicy must be one of/,
    );
    server = undefined;
    // Refused before the database opened, so the next start finds it as it was.
    await start();
    expect(server!.accessPolicy()).toBe("account_required");
  });
});

describe("the command line", () => {
  it("says, a line for each, which flags the workspace did not take", () => {
    const kept = { name: "Blue Team", accessPolicy: "guest_allowed" as const };
    expect(keptSettingsNotes({ kept })).toEqual([]);
    expect(
      keptSettingsNotes({
        name: "Blue Team",
        accessPolicy: "guest_allowed",
        inviteOnly: true,
        kept,
      }),
    ).toEqual([]);
    expect(keptSettingsNotes({ name: "Rocket Team", inviteOnly: true, kept })).toEqual([
      'This workspace keeps its own name, "Blue Team", not --name "Rocket Team". Owners and admins rename it in Workspace settings.',
      "This workspace keeps its own rule for who may join, guest_allowed, not --invite-only. Owners and admins change it in Workspace settings.",
    ]);
    expect(keptSettingsNotes({ accessPolicy: "account_required", kept })).toEqual([
      "This workspace keeps its own rule for who may join, guest_allowed, not --access-policy account_required. Owners and admins change it in Workspace settings.",
    ]);
  });

  it("prints that line when started with a rule an owned workspace does not have", async () => {
    await workspace({ accessPolicy: "guest_allowed" });
    await server!.stop();
    server = undefined;
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        main,
        "--data",
        dataDir!,
        "--port",
        "0",
        "--host",
        "127.0.0.1",
        "--no-mdns",
        "--access-policy",
        "invite_only",
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let errors = "";
    child.stdout!.on("data", (chunk) => (output += String(chunk)));
    child.stderr!.on("data", (chunk) => (errors += String(chunk)));
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await expect
        .poll(() => output, { timeout: 15_000 })
        .toContain("This workspace keeps its own rule for who may join, guest_allowed");
      expect(output).toContain(
        "not --access-policy invite_only. Owners and admins change it in Workspace settings.",
      );
      expect(errors).toBe("");
    } finally {
      child.kill();
      await exited;
    }
  }, 20_000);
});
