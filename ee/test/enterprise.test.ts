import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient, type User } from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import { enterprise, type Enterprise } from "../src/enterprise.js";
import { LICENSE_PREFIX, type LicenseClaims } from "../src/license.js";

/**
 * The Enterprise edition in a running server (P6): the owner and admins read
 * the license and are told when it needs them, nobody else is, and chat
 * works whatever the license says.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 27, 12);
const keys = generateKeyPairSync("ed25519");

function license(over: Partial<LicenseClaims> = {}): string {
  const claims: LicenseClaims = {
    id: "lic-acme",
    licensee: "Acme Ltd",
    plan: "enterprise",
    members: 200,
    features: ["sso"],
    issuedAt: NOW - 30 * DAY,
    expiresAt: NOW + 300 * DAY,
    ...over,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(null, Buffer.from(`${LICENSE_PREFIX}.${payload}`), keys.privateKey);
  return `${LICENSE_PREFIX}.${payload}.${signature.toString("base64url")}`;
}

let server: WorkspaceServer | undefined;
let base: string;
const sockets: WebSocket[] = [];
type Account = { token: string; user: User };

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
  server = undefined;
});

async function start(extension: Enterprise) {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
    extensions: [extension],
  });
  base = `http://127.0.0.1:${server.port}`;
}

const at = (now: number, text: string | null = license()) =>
  enterprise({ license: text, trusted: [keys.publicKey], now: () => now });

async function call(path: string, token?: string, body?: unknown, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as any };
}

async function people() {
  const register = async (handle: string): Promise<Account> =>
    (
      await call("/api/auth/register", undefined, {
        handle,
        displayName: handle,
        password: "password123",
      })
    ).data;
  const owner = await register("owner");
  const admin = await register("admin");
  const member = await register("member");
  await call(`/api/admin/users/${admin.user.id}`, owner.token, { role: "admin" }, "PATCH");
  return { owner, admin, member };
}

async function ready(token: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerToClient));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  return frames.find((f) => f.type === "ready") as Extract<ServerToClient, { type: "ready" }>;
}

describe("an Enterprise license in a running server", () => {
  it("is read by the owner and admins, and is in the workspace status", async () => {
    await start(at(NOW));
    const { owner, admin, member } = await people();
    const read = await call("/api/admin/license", owner.token, undefined, "GET");
    expect(read).toEqual({
      status: 200,
      data: {
        state: "active",
        licensee: "Acme Ltd",
        plan: "enterprise",
        members: 200,
        features: ["sso"],
        issuedAt: NOW - 30 * DAY,
        expiresAt: NOW + 300 * DAY,
        memberCount: 3,
      },
    });
    expect((await call("/api/admin/license", admin.token, undefined, "GET")).status).toBe(200);
    expect((await call("/api/admin/license", member.token, undefined, "GET")).status).toBe(403);
    expect((await call("/api/admin/license", undefined, undefined, "GET")).status).toBe(401);
    const status = await call("/api/admin/status", owner.token, undefined, "GET");
    expect(status.data.extensions).toEqual([
      {
        name: "enterprise",
        summary: "Enterprise license for Acme Ltd, 200 members, until 23 August 2027",
        health: "ok",
      },
    ]);
    expect((await ready(owner.token)).notices).toBeUndefined();
  });

  it("tells the owner and admins in its grace, and keeps chat and its features on", async () => {
    const extension = at(NOW, license({ expiresAt: NOW - 2 * DAY }));
    await start(extension);
    const { owner, admin, member } = await people();
    const text =
      "The Enterprise license for Acme Ltd ended on 25 October 2026. Its features stop on 8 November 2026; chat keeps working.";
    expect((await ready(owner.token)).notices).toEqual([
      { id: "license:lic-acme:grace", tone: "alert", text },
    ]);
    expect((await ready(admin.token)).notices).toHaveLength(1);
    expect((await ready(member.token)).notices).toBeUndefined();
    expect(extension.has("sso")).toBe(true);
    const status = await call("/api/admin/status", owner.token, undefined, "GET");
    expect(status.data.extensions[0]).toMatchObject({ health: "problem", summary: text });
  });

  it("turns its features off once ended, and chat carries on", async () => {
    const extension = at(NOW, license({ expiresAt: NOW - 20 * DAY }));
    await start(extension);
    const { owner, member } = await people();
    expect(extension.has("sso")).toBe(false);
    expect((await ready(owner.token)).notices).toEqual([
      {
        id: "license:lic-acme:expired",
        tone: "alert",
        text: "The Enterprise license for Acme Ltd ended on 7 October 2026, and its features are off. Chat keeps working.",
      },
    ]);
    const general = server!.store.getChannelByName("general")!.id;
    const posted = await call(`/api/channels/${general}/messages`, member.token, { text: "hi" });
    expect(posted.status).toBe(201);
    expect((await call("/api/admin/license", owner.token, undefined, "GET")).data.state).toBe(
      "expired",
    );
  });

  it("says when it ends soon, and when the workspace has more members than it covers", async () => {
    await start(at(NOW, license({ expiresAt: NOW + 10 * DAY })));
    const { owner } = await people();
    expect((await ready(owner.token)).notices).toEqual([
      {
        id: "license:lic-acme:ending",
        tone: "status",
        text: "The Enterprise license for Acme Ltd ends on 6 November 2026. Renew it to keep its features.",
      },
    ]);
    await server!.stop();

    await start(at(NOW, license({ members: 2 })));
    const crowd = await people();
    expect((await ready(crowd.owner.token)).notices).toEqual([
      {
        id: "license:lic-acme:members",
        tone: "status",
        text: "This workspace has 3 members, more than the 2 its Enterprise license covers. Nobody is locked out.",
      },
    ]);
    const status = await call("/api/admin/status", crowd.owner.token, undefined, "GET");
    expect(status.data.extensions[0]).toMatchObject({
      health: "warning",
      summary:
        "Enterprise license for Acme Ltd, 2 members, until 23 August 2027; the workspace has 3",
    });
  });

  it("is the free edition without a license", async () => {
    const extension = at(NOW, null);
    await start(extension);
    const { owner } = await people();
    expect(extension.has("sso")).toBe(false);
    expect((await call("/api/admin/license", owner.token, undefined, "GET")).data).toEqual({
      state: "none",
      memberCount: 3,
    });
    const status = await call("/api/admin/status", owner.token, undefined, "GET");
    expect(status.data.extensions).toEqual([
      { name: "enterprise", summary: "No Enterprise license: the free edition", health: "ok" },
    ]);
  });
});

describe("the command line with the Enterprise edition", () => {
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });
  function cli(args: string[], env: Record<string, string> = {}) {
    const child = spawn(process.execPath, ["--import", "tsx", main, ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += String(chunk)));
    child.stderr!.on("data", (chunk) => (output += String(chunk)));
    return {
      child,
      output: () => output,
      exited: new Promise<number | null>((resolve) => child.once("exit", resolve)),
    };
  }
  const serverArgs = () => {
    const folder = mkdtempSync(join(tmpdir(), "ownbase-ee-"));
    folders.push(folder);
    return {
      folder,
      args: ["--data", join(folder, "data"), "--port", "0", "--host", "127.0.0.1", "--no-mdns"],
    };
  };

  it("says what --license does in --help, after the server's own options", async () => {
    const run = cli(["--help"]);
    expect(await run.exited).toBe(0);
    expect(run.output()).toContain("--data <dir>");
    expect(run.output()).toMatch(/Recovery[\s\S]+Enterprise\n\n {2}--license <file>/);
  }, 30_000);

  it("starts as the free edition without a license", async () => {
    const { args } = serverArgs();
    const run = cli(args);
    try {
      await vi.waitFor(
        () => expect(run.output()).toContain("No Enterprise license: the free edition"),
        { timeout: 20_000 },
      );
    } finally {
      run.child.kill();
      await run.exited;
    }
  }, 30_000);

  it("refuses a license it cannot accept, saying why, before taking the workspace", async () => {
    const { folder, args } = serverArgs();
    const file = join(folder, "acme.license");
    // Signed by a key this build does not trust, which is every key in a test.
    writeFileSync(file, license());
    const run = cli([...args, "--license", file]);
    expect(await run.exited).toBe(1);
    expect(run.output()).toContain("--license: This build of OwnBase trusts no license key yet.");
    expect(existsSync(join(folder, "data"))).toBe(false);
    const missing = cli([...args, "--license", join(folder, "none.license")]);
    expect(await missing.exited).toBe(1);
    expect(missing.output()).toContain("could not be read (ENOENT)");
    const twice = cli(args, { OWNBASE_LICENSE: license(), OWNBASE_LICENSE_FILE: file });
    expect(await twice.exited).toBe(1);
    expect(twice.output()).toContain("Give the license once");
  }, 60_000);
});
