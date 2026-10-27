import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient, type User } from "@slackoss/protocol";
import type { ServerExtension } from "../src/extensions.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * The server's extension point (P6): whatever is handed over is registered
 * after the server's own routes, reports in the workspace status, tells the
 * owner and admins what it needs them to know, and is stopped with the
 * server. Nothing here needs ee/.
 */
let server: WorkspaceServer | undefined;
let base: string;
const sockets: WebSocket[] = [];
type Account = { token: string; user: User };

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
  server = undefined;
});

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

/** An extension with a route for each kind of person, and what it was told. */
function probe() {
  const seen = { members: [] as number[], stopped: 0 };
  const extension: ServerExtension = {
    name: "probe",
    register({ app, requireUser, requireAdmin, requireOwner, memberCount }) {
      app.get("/api/probe/anyone", async (req) => ({ handle: requireUser(req).handle }));
      app.get("/api/probe/admins", async (req) => ({ handle: requireAdmin(req).handle }));
      app.get("/api/probe/owner", async (req) => ({ handle: requireOwner(req).handle }));
      app.get("/api/probe/members", async () => {
        seen.members.push(memberCount());
        return { members: memberCount() };
      });
    },
    status: () => ({ name: "probe", summary: "Probe: fine", health: "ok" }),
    notice: () => ({ id: "probe:1", tone: "status", text: "The probe says hello." }),
    stop: () => {
      seen.stopped++;
    },
  };
  return { extension, seen };
}

async function start(extensions?: ServerExtension[]) {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
    ...(extensions ? { extensions } : {}),
  });
  base = `http://127.0.0.1:${server.port}`;
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

describe("an extension", () => {
  it("adds routes that hold each person to what the server's own do", async () => {
    const { extension, seen } = probe();
    await start([extension]);
    const { owner, admin, member } = await people();
    const get = (path: string, who?: Account) => call(path, who?.token, undefined, "GET");
    expect((await get("/api/probe/anyone")).status).toBe(401);
    expect((await get("/api/probe/anyone", member)).data).toEqual({ handle: "member" });
    expect((await get("/api/probe/admins", member)).status).toBe(403);
    expect((await get("/api/probe/admins", admin)).data).toEqual({ handle: "admin" });
    expect((await get("/api/probe/owner", admin)).status).toBe(403);
    expect((await get("/api/probe/owner", owner)).data).toEqual({ handle: "owner" });
    expect((await get("/api/probe/members", owner)).data).toEqual({ members: 3 });
    expect(seen.members).toEqual([3]);
  });

  it("reports in the workspace status and tells the owner and admins, nobody else", async () => {
    await start([probe().extension]);
    const { owner, admin, member } = await people();
    expect(
      (await call("/api/admin/status", owner.token, undefined, "GET")).data.extensions,
    ).toEqual([{ name: "probe", summary: "Probe: fine", health: "ok" }]);
    const notice = { id: "probe:1", tone: "status", text: "The probe says hello." };
    expect((await ready(owner.token)).notices).toEqual([notice]);
    expect((await ready(admin.token)).notices).toEqual([notice]);
    expect((await ready(member.token)).notices).toBeUndefined();
  });

  it("is stopped with the server, once", async () => {
    const { extension, seen } = probe();
    await start([extension]);
    await server!.stop();
    await server!.stop();
    server = undefined;
    expect(seen.stopped).toBe(1);
  });

  it("is not needed: without one the status and snapshot say nothing of them", async () => {
    await start();
    const { owner } = await people();
    const status = (await call("/api/admin/status", owner.token, undefined, "GET")).data;
    expect("extensions" in status).toBe(false);
    expect("notices" in (await ready(owner.token))).toBe(false);
  });
});

describe("an extension on the command line", () => {
  const entry = fileURLToPath(new URL("./fixtures/extensionEntry.ts", import.meta.url));
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });
  function cli(args: string[], env: Record<string, string> = {}) {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
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
    const folder = mkdtempSync(join(tmpdir(), "ownbase-extension-"));
    folders.push(folder);
    return ["--data", join(folder, "data"), "--port", "0", "--host", "127.0.0.1", "--no-mdns"];
  };

  it("adds its flags and its help to the server's", async () => {
    const help = cli(["--help"]);
    expect(await help.exited).toBe(0);
    expect(help.output()).toMatch(/Recovery[\s\S]+\nGreeting\n\n {2}--greeting <words>/);
    for (const [args, env, said] of [
      [["--greeting", "hello"], {}, "Greeting: hello"],
      [[], { OWNBASE_GREETING: "from the environment" }, "Greeting: from the environment"],
    ] as const) {
      const run = cli([...serverArgs(), ...args], env);
      try {
        await vi.waitFor(() => expect(run.output()).toContain(said), { timeout: 20_000 });
      } finally {
        run.child.kill();
        await run.exited;
      }
    }
  }, 60_000);

  it("refuses a setting the extension cannot use, as the server's own are", async () => {
    const run = cli([...serverArgs(), "--greeting", "refuse"]);
    expect(await run.exited).toBe(1);
    expect(run.output()).toContain("--greeting: not that one");
    // Its flags are its own: the server alone does not know them.
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const alone = spawn(process.execPath, ["--import", "tsx", main, "--greeting", "hello"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let said = "";
    alone.stderr!.on("data", (chunk) => (said += String(chunk)));
    expect(await new Promise((resolve) => alone.once("exit", resolve))).toBe(2);
    expect(said).toContain("--greeting");
  }, 60_000);
});
