import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlPlane } from "../src/controlPlane.js";

/**
 * The control plane with real OwnBase servers (P7): each workspace a process
 * of its own on a loopback port, run from source through tsx, and a stand-in
 * for Caddy's admin API that keeps what it is given.
 */
const TOKEN = "operator-token-0123456789abcdefghij";
const server = {
  command: process.execPath,
  args: [
    "--import",
    // Resolved from this package, the working directory the servers inherit.
    "tsx",
    fileURLToPath(new URL("../../src/main.ts", import.meta.url)),
  ],
};

let dataDir: string;
let plane: ControlPlane;
let base: string;
let caddy: Server;
const loads: any[] = [];
/** While true, the stand-in for Caddy refuses every config, as a Caddy that is down would. */
let refusing = false;

function startPlane() {
  plane = new ControlPlane({
    dataDir,
    domain: "ownbase.test",
    server,
    token: TOKEN,
    ports: { from: 21000, to: 21999 },
    caddy: {
      adminUrl: `http://127.0.0.1:${(caddy.address() as { port: number }).port}`,
      adminListen: "127.0.0.1:2019",
      issuer: "internal",
    },
    listen: { host: "127.0.0.1", port: 8100 },
    env: { ...process.env, OWNBASE_CLOUD_TOKEN: TOKEN },
    caddyRetryMs: 200,
  });
  return plane;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-cloud-"));
  caddy = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      // Caddy's own rule: a request that says Sec-Fetch-Mode, as Node's fetch
      // does, comes from a browser unless its Origin is the admin address.
      const own = [`http://127.0.0.1:${(caddy.address() as { port: number }).port}`];
      if (req.headers["sec-fetch-mode"] && !own.includes(String(req.headers.origin ?? ""))) {
        res.writeHead(403).end(
          JSON.stringify({
            error: `client is not allowed to access from origin '${req.headers.origin ?? ""}'`,
          }),
        );
        return;
      }
      if (refusing) {
        res.writeHead(500).end(JSON.stringify({ error: "loading new config: not now" }));
        return;
      }
      if (req.method === "POST" && req.url === "/load") loads.push(JSON.parse(body));
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => caddy.listen(0, "127.0.0.1", resolve));
  startPlane();
  await plane.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(plane.app.server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  await plane?.stop();
  await new Promise((resolve) => caddy.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
}, 60_000);

async function api(path: string, method = "GET", body?: unknown, token: string | null = TOKEN) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

/** Straight to a workspace's server, as Caddy would send someone. */
async function workspace(port: number, path: string, method = "GET", body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "x-forwarded-for": "203.0.113.9",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

const answers = (port: number) =>
  fetch(`http://127.0.0.1:${port}/api/health`).then(
    (r) => r.ok,
    () => false,
  );
const until = async (check: () => Promise<boolean> | boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};
const routesLoaded = () =>
  loads
    .at(-1)
    .apps.http.servers.workspaces.routes.map((r: any) => [
      r.match[0].host[0],
      r.handle[0].handler,
      r.handle[0].upstreams?.[0].dial ?? r.handle[0].status_code,
    ]);
const ask = async (domain: string) =>
  (await fetch(`${base}/caddy/ask?domain=${encodeURIComponent(domain)}`)).status;

let acmePort: number;

describe("hosting workspaces", () => {
  it("answers the operator only with the token", async () => {
    expect((await api("/api/workspaces", "GET", undefined, null)).status).toBe(401);
    expect((await api("/api/workspaces", "GET", undefined, "wrong-token")).status).toBe(401);
    expect((await api("/api/workspaces")).body.workspaces).toEqual([]);
    // Fastify's own refusal says what was wrong, rather than that something went wrong.
    const empty = await fetch(base + "/api/workspaces", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toMatch(/empty/);
  });

  it("creates a workspace: its own server, its address in Caddy, a link to claim it", async () => {
    expect(loads).toHaveLength(0);
    const created = await api("/api/workspaces", "POST", {
      slug: "acme",
      name: "Acme",
      ownerEmail: "ada@acme.example",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      slug: "acme",
      plan: "team",
      state: "active",
      url: "https://acme.ownbase.test",
      process: { state: "running", restarts: 0 },
    });
    const link = created.body.claimLink as string;
    expect(link).toMatch(/^https:\/\/acme\.ownbase\.test\/#\/claim\/[A-Za-z0-9_-]{32}$/);
    acmePort = plane.registry.get("acme")!.port;
    expect(acmePort).toBeGreaterThanOrEqual(21000);

    const info = await workspace(acmePort, "/api/server-info");
    expect(info.body).toMatchObject({ workspaceName: "Acme", userCount: 0, requiresClaim: true });
    expect(routesLoaded()).toEqual([
      ["acme.ownbase.test", "reverse_proxy", `127.0.0.1:${acmePort}`],
    ]);
    expect((await api("/api/workspaces")).body.caddy).toEqual({ synced: true, error: null });
    expect(await ask("acme.ownbase.test")).toBe(200);
    expect(await ask("other.ownbase.test")).toBe(404);
    expect(await ask("acme.evil.example")).toBe(404);

    // The link's code claims it, through the proxy as the owner would come.
    const code = link.split("/").at(-1);
    const stranger = { handle: "eve", displayName: "Eve", password: "password123" };
    expect((await workspace(acmePort, "/api/auth/register", "POST", stranger)).status).toBe(403);
    const owner = await workspace(acmePort, "/api/auth/register", "POST", {
      handle: "ada",
      displayName: "Ada",
      password: "password123",
      claimCode: code,
    });
    expect(owner.status).toBe(201);
    expect(owner.body.user.role).toBe("owner");
    expect((await api("/api/workspaces/acme")).body.claimLink).toBeNull();
  }, 60_000);

  it("refuses an address that is wrong, kept or taken", async () => {
    const make = (slug: string) =>
      api("/api/workspaces", "POST", { slug, name: "X", ownerEmail: "x@x.example" });
    expect((await make("A!")).status).toBe(400);
    expect((await make("www")).status).toBe(400);
    expect((await make("acme")).status).toBe(409);
    expect(
      (await api("/api/workspaces", "POST", { slug: "fine", name: "X", ownerEmail: "nope" }))
        .status,
    ).toBe(400);
  });

  it("starts a workspace's server again when it stops on its own", async () => {
    const pid = plane.supervisor.status("acme").pid!;
    process.kill(pid);
    await until(() => plane.supervisor.status("acme").restarts === 1);
    await until(() => answers(acmePort));
    expect(plane.supervisor.status("acme").pid).not.toBe(pid);
    // Nothing was lost: the owner signs in.
    expect(
      (
        await workspace(acmePort, "/api/auth/login", "POST", {
          handle: "ada",
          password: "password123",
        })
      ).status,
    ).toBe(200);
  }, 60_000);

  it("suspends a workspace, keeping it, and resumes it as it was", async () => {
    const suspended = await api("/api/workspaces/acme/suspend", "POST");
    expect(suspended.body).toMatchObject({ state: "suspended", process: { state: "stopped" } });
    expect(await answers(acmePort)).toBe(false);
    expect(routesLoaded()).toEqual([["acme.ownbase.test", "static_response", 503]]);
    // Still a name with a certificate, to show the page that says it is paused.
    expect(await ask("acme.ownbase.test")).toBe(200);
    expect((await api("/api/workspaces/acme/suspend", "POST")).status).toBe(409);

    const resumed = await api("/api/workspaces/acme/resume", "POST");
    expect(resumed.body).toMatchObject({ state: "active", process: { state: "running" } });
    expect(routesLoaded()).toEqual([
      ["acme.ownbase.test", "reverse_proxy", `127.0.0.1:${acmePort}`],
    ]);
    expect(
      (
        await workspace(acmePort, "/api/auth/login", "POST", {
          handle: "ada",
          password: "password123",
        })
      ).status,
    ).toBe(200);
  }, 60_000);

  it("exports a checked copy, and the workspace goes on running", async () => {
    const exported = await api("/api/workspaces/acme/export", "POST");
    expect(exported.status).toBe(200);
    expect(existsSync(join(exported.body.path, "manifest.json"))).toBe(true);
    expect(await answers(acmePort)).toBe(true);
    // Straight after, within the same second: a folder of its own.
    const again = await api("/api/workspaces/acme/export", "POST");
    expect(again.status).toBe(200);
    expect(again.body.path).not.toBe(exported.body.path);
    expect(existsSync(join(again.body.path, "manifest.json"))).toBe(true);
  }, 120_000);

  it("starts every active workspace again when the control plane does", async () => {
    await plane.stop();
    expect(await answers(acmePort)).toBe(false);
    startPlane();
    await plane.start();
    await plane.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(plane.app.server.address() as { port: number }).port}`;
    expect(await answers(acmePort)).toBe(true);
    expect(routesLoaded()).toEqual([
      ["acme.ownbase.test", "reverse_proxy", `127.0.0.1:${acmePort}`],
    ]);
  }, 60_000);

  it("deletes a workspace after exporting it, and never gives its address out again", async () => {
    const deleted = await api("/api/workspaces/acme", "DELETE");
    expect(deleted.status).toBe(200);
    expect(existsSync(join(deleted.body.export, "manifest.json"))).toBe(true);
    expect(existsSync(join(dataDir, "workspaces", "acme"))).toBe(false);
    expect(await answers(acmePort)).toBe(false);
    expect(routesLoaded()).toEqual([]);
    expect(await ask("acme.ownbase.test")).toBe(404);
    expect((await api("/api/workspaces/acme")).status).toBe(404);
    expect(
      (
        await api("/api/workspaces", "POST", {
          slug: "acme",
          name: "Acme 2",
          ownerEmail: "a@b.example",
        })
      ).status,
    ).toBe(409);
    expect(readdirSync(join(dataDir, "exports"))).toHaveLength(3);
    expect((await api("/api/workspaces")).body.workspaces).toEqual([]);
  }, 120_000);

  it("goes on when Caddy will not take the config, and tells it again until it does", async () => {
    refusing = true;
    const loaded = loads.length;
    const created = await api("/api/workspaces", "POST", {
      slug: "rocket",
      name: "Rocket",
      ownerEmail: "sam@rocket.example",
    });
    expect(created.status).toBe(201);
    const port = plane.registry.get("rocket")!.port;
    expect(await answers(port)).toBe(true);
    const listed = (await api("/api/workspaces")).body;
    expect(listed.caddy).toEqual({ synced: false, error: expect.stringMatching(/not now/) });
    expect(loads).toHaveLength(loaded);

    refusing = false;
    await until(async () => (await api("/api/workspaces")).body.caddy.synced === true, 10_000);
    expect(routesLoaded()).toEqual([["rocket.ownbase.test", "reverse_proxy", `127.0.0.1:${port}`]]);
  }, 60_000);
});
