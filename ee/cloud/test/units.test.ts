import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { caddyConfig, SUSPENDED_PAGE } from "../src/caddy.js";
import { newClaimCode, Registry, slugProblem, type HostedWorkspace } from "../src/registry.js";
import { BACKOFF_MS, Supervisor } from "../src/supervisor.js";

const folders: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "ownbase-cloud-"));
  folders.push(dir);
  return dir;
};
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const workspace = (over: Partial<HostedWorkspace>): HostedWorkspace => ({
  slug: "acme",
  name: "Acme",
  ownerEmail: "ada@acme.example",
  plan: "team",
  state: "active",
  port: 20001,
  claimCode: "claim-0123456789abcdef",
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe("a workspace's address", () => {
  it("is 3 to 32 lowercase letters, digits and single hyphens, not one OwnBase keeps", () => {
    for (const good of ["acme", "a1b", "rocket-team", "x".repeat(32)])
      expect(slugProblem(good)).toBeNull();
    for (const bad of [
      "ab",
      "x".repeat(33),
      "-acme",
      "acme-",
      "Acme",
      "ac_me",
      "ac.me",
      "a--b",
      "www",
      "admin",
      "api",
    ])
      expect(slugProblem(bad), bad).not.toBeNull();
  });

  it("comes with a claim code a link carries unchanged", () => {
    const code = newClaimCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newClaimCode()).not.toBe(code);
  });
});

describe("the registry", () => {
  it("keeps workspaces across opening, and frees a deleted one's port but not its address", () => {
    const path = join(folder(), "control.db");
    const registry = new Registry(path);
    registry.add(workspace({ slug: "acme", port: 20001 }));
    registry.add(workspace({ slug: "rocket", port: 20002 }));
    expect(() => registry.add(workspace({ slug: "other", port: 20001 }))).toThrow();
    registry.setState("acme", "deleted");
    expect([...registry.portsInUse()]).toEqual([20002]);
    registry.add(workspace({ slug: "other", port: 20001 }));
    registry.close();

    const again = new Registry(path);
    cleanups.push(() => again.close());
    expect(again.list().map((w) => [w.slug, w.state, w.port])).toEqual([
      ["acme", "deleted", 20001],
      ["other", "active", 20001],
      ["rocket", "active", 20002],
    ]);
    expect(() => again.add(workspace({ slug: "acme", port: 20003 }))).toThrow();
  });
});

describe("Caddy's config", () => {
  const config = (workspaces: HostedWorkspace[], issuer: "acme" | "internal" = "acme") =>
    caddyConfig(workspaces, {
      domain: "ownbase.test",
      askUrl: "http://127.0.0.1:8100/caddy/ask",
      adminListen: "127.0.0.1:2019",
      issuer,
      email: "ops@ownbase.test",
    }) as any;

  it("sends each active workspace's address to its server, and shows a paused one's page", () => {
    const loaded = config([
      workspace({ slug: "acme", port: 20001 }),
      workspace({ slug: "paused", port: 20002, state: "suspended" }),
      workspace({ slug: "gone", port: 20003, state: "deleted" }),
    ]);
    const routes = loaded.apps.http.servers.workspaces.routes;
    expect(routes).toHaveLength(2);
    expect(routes[0].match).toEqual([{ host: ["acme.ownbase.test"] }]);
    expect(routes[0].handle).toEqual([
      { handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:20001" }] },
    ]);
    expect(routes[1].match).toEqual([{ host: ["paused.ownbase.test"] }]);
    expect(routes[1].handle[0]).toMatchObject({
      handler: "static_response",
      status_code: 503,
      body: SUSPENDED_PAGE,
    });
    expect(JSON.stringify(loaded)).not.toContain("gone.ownbase.test");
  });

  it("gets certificates on demand, for the names the control plane says exist", () => {
    const loaded = config([workspace({})]);
    expect(loaded.admin).toEqual({ listen: "127.0.0.1:2019" });
    expect(loaded.apps.tls.automation.on_demand).toEqual({
      permission: { module: "http", endpoint: "http://127.0.0.1:8100/caddy/ask" },
    });
    expect(loaded.apps.tls.automation.policies).toEqual([
      { issuers: [{ module: "acme", email: "ops@ownbase.test" }], on_demand: true },
    ]);
    expect(config([], "internal").apps.tls.automation.policies[0].issuers).toEqual([
      { module: "internal" },
    ]);
  });
});

describe("the supervisor", () => {
  const healthServer = fileURLToPath(new URL("./fixtures/healthServer.mjs", import.meta.url));
  const freePort = () =>
    new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
  const answering = async (port: number) =>
    fetch(`http://127.0.0.1:${port}/api/health`).then(
      (r) => r.json() as Promise<{ pid: number }>,
      () => null,
    );
  const until = async (check: () => Promise<boolean> | boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it("starts a server again after it stops on its own, waiting longer each time", async () => {
    const supervisor = new Supervisor({ command: process.execPath, args: [healthServer] });
    cleanups.push(() => supervisor.stopAll());
    const port = await freePort();
    const dir = folder();
    await supervisor.start({
      slug: "acme",
      port,
      folder: dir,
      args: ["--port", String(port)],
      env: process.env,
    });
    const first = (await answering(port))!.pid;
    expect(supervisor.status("acme")).toMatchObject({ state: "running", pid: first, restarts: 0 });

    process.kill(first);
    await until(() => supervisor.status("acme").state === "waiting");
    let status = supervisor.status("acme");
    expect(status.nextStartAt! - status.lastExit!.at).toBeGreaterThanOrEqual(BACKOFF_MS[0]! - 50);
    await until(async () => ((await answering(port))?.pid ?? first) !== first);
    expect(supervisor.status("acme").restarts).toBe(1);

    const second = (await answering(port))!.pid;
    process.kill(second);
    await until(() => supervisor.status("acme").state === "waiting");
    status = supervisor.status("acme");
    expect(status.nextStartAt! - status.lastExit!.at).toBeGreaterThanOrEqual(BACKOFF_MS[1]! - 50);
    expect(readFileSync(join(dir, "server.log"), "utf8")).toMatch(
      /starting again in 1 s[\s\S]*starting again in 2 s/,
    );
  }, 30_000);

  it("stops a server for good when asked, and does not start it again", async () => {
    const supervisor = new Supervisor({ command: process.execPath, args: [healthServer] });
    cleanups.push(() => supervisor.stopAll());
    const port = await freePort();
    await supervisor.start({
      slug: "acme",
      port,
      folder: folder(),
      args: ["--port", String(port)],
      env: process.env,
    });
    await supervisor.stop("acme");
    expect(supervisor.status("acme").state).toBe("stopped");
    expect(await answering(port)).toBeNull();
    await new Promise((r) => setTimeout(r, BACKOFF_MS[0]! + 300));
    expect(await answering(port)).toBeNull();
  }, 15_000);

  it("says so when a server never answers", async () => {
    const supervisor = new Supervisor({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000)"],
    });
    cleanups.push(() => supervisor.stopAll());
    const port = await freePort();
    const started = supervisor.start({
      slug: "mute",
      port,
      folder: folder(),
      args: [],
      env: process.env,
    });
    const outcome = await Promise.race([
      started.then(
        () => "answered",
        () => "refused",
      ),
      new Promise((r) => setTimeout(() => r("still waiting"), 1_500)),
    ]);
    expect(outcome).toBe("still waiting");
    await supervisor.stop("mute");
    await expect(started).rejects.toThrow(/stopped before it answered/);
  }, 15_000);
});
