import { execFile } from "node:child_process";
import { timingSafeEqual, createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { caddyConfig, loadCaddyConfig, type CaddyOptions } from "./caddy.js";
import {
  newClaimCode,
  PLANS,
  Registry,
  slugProblem,
  type HostedWorkspace,
  type Plan,
} from "./registry.js";
import { Supervisor, type ProcessStatus, type ServerCommand } from "./supervisor.js";

const run = promisify(execFile);

export interface ControlPlaneOptions {
  /** Holds control.db, workspaces/<slug>/ and exports/. */
  dataDir: string;
  /** Workspaces live at https://<slug>.<domain>. */
  domain: string;
  /** How to run the OwnBase server. */
  server: ServerCommand;
  /** The operator's token for /api/*. */
  token: string;
  /** Loopback ports for workspace servers, from and to. */
  ports: { from: number; to: number };
  /** Caddy's admin API, or null to leave Caddy alone (tests, or a hand-kept Caddy). */
  caddy: (Omit<CaddyOptions, "domain" | "askUrl"> & { adminUrl: string }) | null;
  /** Where the control plane listens, so Caddy knows where to ask. */
  listen?: { host: string; port: number };
  /** Where a workspace's owner chooses a bigger plan. */
  upgradeUrl?: string;
  /** How long to wait before telling Caddy again, after it would not take the config. */
  caddyRetryMs?: number;
  /** Settings the workspace servers take from the control plane's environment. */
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

/** The environment a workspace server is given: the system's, and its relay. */
const PASSED_ON = [
  /^PATH$/i,
  /^SYSTEMROOT$/i,
  /^TEMP$/i,
  /^TMP$/i,
  /^HOME$/,
  /^LANG$/,
  /^TZ$/,
  /^OWNBASE_ICE_SERVERS$/,
  /^OWNBASE_TURN_(URLS|SECRET)$/,
  /^OWNBASE_CLOUDFLARE_TURN_(KEY_ID|API_TOKEN)$/,
  /^OWNBASE_LICENSE(_FILE)?$/,
];

const createBody = z.object({
  slug: z.string(),
  name: z.string().trim().min(1).max(80),
  ownerEmail: z.email(),
  plan: z.enum(Object.keys(PLANS) as [Plan, ...Plan[]]).default("team"),
});

/** What the operator is told about a workspace. */
export interface WorkspaceView {
  slug: string;
  name: string;
  ownerEmail: string;
  plan: Plan;
  state: HostedWorkspace["state"];
  url: string;
  /** The owner's link, until someone has claimed the workspace. */
  claimLink: string | null;
  process: ProcessStatus;
  createdAt: number;
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 2026-10-27T13-24-03-123: sorts by time, and fits any file system. */
const stamp = (at = Date.now()) => new Date(at).toISOString().replace(/[:.]/g, "-").slice(0, 23);

/**
 * OwnBase's hosting (P7): a registry of workspaces, one server process each
 * on a loopback port, Caddy in front with a certificate per address, and an
 * operator API to create, suspend, resume, export and delete them.
 */
export class ControlPlane {
  readonly registry: Registry;
  readonly supervisor: Supervisor;
  readonly app: FastifyInstance;
  private readonly log: (message: string) => void;
  /** One change at a time, so two requests never pick the same port or race a stop. */
  private turn: Promise<unknown> = Promise.resolve();
  /** Whether Caddy has the config for the workspaces as they are now. */
  caddy: { synced: boolean; error: string | null } = { synced: false, error: null };
  private caddyRetry: NodeJS.Timeout | null = null;

  constructor(private readonly opts: ControlPlaneOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    this.log = opts.log ?? (() => {});
    this.registry = new Registry(join(opts.dataDir, "control.db"));
    this.supervisor = new Supervisor(opts.server, this.log);
    this.app = Fastify({ logger: false });
    this.routes();
  }

  private folder(slug: string) {
    return join(this.opts.dataDir, "workspaces", slug);
  }

  private url(slug: string) {
    return `https://${slug}.${this.opts.domain}`;
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.turn.then(work, work);
    this.turn = next.catch(() => {});
    return next;
  }

  /** The server's arguments and environment for a workspace. */
  private spec(workspace: HostedWorkspace) {
    const plan = PLANS[workspace.plan];
    const folder = this.folder(workspace.slug);
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(this.opts.env ?? process.env))
      if (PASSED_ON.some((pattern) => pattern.test(key))) env[key] = value;
    env.OWNBASE_CLAIM_CODE = workspace.claimCode;
    return {
      slug: workspace.slug,
      port: workspace.port,
      folder,
      env,
      args: [
        "--data",
        join(folder, "data"),
        "--port",
        String(workspace.port),
        "--host",
        "127.0.0.1",
        "--name",
        workspace.name,
        "--public-url",
        this.url(workspace.slug),
        "--trust-proxy",
        "--no-mdns",
        "--storage-limit-mb",
        String(plan.storageMb),
        "--member-notice",
        String(plan.members),
        "--plan-name",
        plan.name,
        ...(this.opts.upgradeUrl ? ["--upgrade-url", this.opts.upgradeUrl] : []),
        "--backup-dir",
        join(folder, "backups"),
        "--backup-every-hours",
        "24",
        "--backup-keep",
        "7",
      ],
    };
  }

  /**
   * Tells Caddy which workspaces exist now. Caddy not taking it fails
   * nothing: the workspaces run, and Caddy is told again until it does.
   */
  async tellCaddy(): Promise<void> {
    try {
      await this.syncCaddy();
      this.caddy = { synced: true, error: null };
    } catch (error) {
      const wait = this.opts.caddyRetryMs ?? 15_000;
      this.caddy = { synced: false, error: (error as Error).message };
      this.log(`Caddy: ${(error as Error).message}; telling it again in ${wait / 1000} s`);
      if (this.caddyRetry) return;
      this.caddyRetry = setTimeout(() => {
        this.caddyRetry = null;
        void this.tellCaddy();
      }, wait);
      this.caddyRetry.unref();
    }
  }

  private async syncCaddy(): Promise<void> {
    const caddy = this.opts.caddy;
    if (!caddy) return;
    const listen = this.opts.listen ?? { host: "127.0.0.1", port: 8100 };
    const config = caddyConfig(this.registry.list(), {
      ...caddy,
      domain: this.opts.domain,
      askUrl: `http://${listen.host}:${listen.port}/caddy/ask`,
    });
    await loadCaddyConfig(caddy.adminUrl, config);
  }

  /** A free loopback port in the range: not a workspace's, and nothing else listening. */
  private async freePort(): Promise<number> {
    const taken = this.registry.portsInUse();
    for (let port = this.opts.ports.from; port <= this.opts.ports.to; port++) {
      if (taken.has(port)) continue;
      const free = await new Promise<boolean>((resolve) => {
        const probe = createServer();
        probe.once("error", () => resolve(false));
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
      });
      if (free) return port;
    }
    throw new Refusal(503, "No port is free for another workspace");
  }

  private async claimed(workspace: HostedWorkspace): Promise<boolean | null> {
    if (workspace.state !== "active") return null;
    try {
      const response = await fetch(`http://127.0.0.1:${workspace.port}/api/server-info`, {
        signal: AbortSignal.timeout(2_000),
      });
      const info = (await response.json()) as { userCount?: number };
      return typeof info.userCount === "number" ? info.userCount > 0 : null;
    } catch {
      return null;
    }
  }

  async view(workspace: HostedWorkspace): Promise<WorkspaceView> {
    const claimed = await this.claimed(workspace);
    return {
      slug: workspace.slug,
      name: workspace.name,
      ownerEmail: workspace.ownerEmail,
      plan: workspace.plan,
      state: workspace.state,
      url: this.url(workspace.slug),
      claimLink:
        claimed === false ? `${this.url(workspace.slug)}/#/claim/${workspace.claimCode}` : null,
      process: this.supervisor.status(workspace.slug),
      createdAt: workspace.createdAt,
    };
  }

  private existing(slug: string, states: HostedWorkspace["state"][]): HostedWorkspace {
    const workspace = this.registry.get(slug);
    if (!workspace || workspace.state === "deleted")
      throw new Refusal(404, `No workspace called ${slug}`);
    if (!states.includes(workspace.state)) throw new Refusal(409, `${slug} is ${workspace.state}`);
    return workspace;
  }

  create(input: z.infer<typeof createBody>): Promise<WorkspaceView> {
    return this.serialized(async () => {
      const problem = slugProblem(input.slug);
      if (problem) throw new Refusal(400, problem);
      if (this.registry.get(input.slug))
        throw new Refusal(409, `${input.slug} is taken, or was used before`);
      const workspace = this.registry.add({
        slug: input.slug,
        name: input.name,
        ownerEmail: input.ownerEmail,
        plan: input.plan,
        state: "active",
        port: await this.freePort(),
        claimCode: newClaimCode(),
      });
      try {
        await this.supervisor.start(this.spec(workspace));
      } catch (error) {
        // It never served anyone: take it back out, folder and all.
        await this.supervisor.stop(workspace.slug);
        this.registry.forget(workspace.slug);
        rmSync(this.folder(workspace.slug), { recursive: true, force: true });
        throw new Refusal(500, `The workspace did not start: ${(error as Error).message}`);
      }
      await this.tellCaddy();
      this.log(`created ${workspace.slug} on port ${workspace.port}`);
      return this.view(workspace);
    });
  }

  suspend(slug: string): Promise<WorkspaceView> {
    return this.serialized(async () => {
      this.existing(slug, ["active"]);
      await this.supervisor.stop(slug);
      const workspace = this.registry.setState(slug, "suspended");
      await this.tellCaddy();
      this.log(`suspended ${slug}`);
      return this.view(workspace);
    });
  }

  resume(slug: string): Promise<WorkspaceView> {
    return this.serialized(async () => {
      const workspace = this.registry.setState(this.existing(slug, ["suspended"]).slug, "active");
      try {
        await this.supervisor.start(this.spec(workspace));
      } catch (error) {
        await this.supervisor.stop(slug);
        this.registry.setState(slug, "suspended");
        throw new Refusal(500, `The workspace did not start: ${(error as Error).message}`);
      }
      await this.tellCaddy();
      this.log(`resumed ${slug}`);
      return this.view(workspace);
    });
  }

  /**
   * A checked backup of the workspace in exports/<slug>-<time>, taken with
   * its server stopped so nothing changes under it, then started again if it
   * was running.
   */
  export(slug: string): Promise<{ path: string }> {
    return this.serialized(() => this.exportNow(this.existing(slug, ["active", "suspended"])));
  }

  private async exportNow(workspace: HostedWorkspace): Promise<{ path: string }> {
    const wasActive = workspace.state === "active";
    // A backup goes into an empty folder: one of its own, even within the same millisecond.
    const named = join(this.opts.dataDir, "exports", `${workspace.slug}-${stamp()}`);
    let path = named;
    for (let n = 2; existsSync(path); n++) path = `${named}-${n}`;
    mkdirSync(join(this.opts.dataDir, "exports"), { recursive: true });
    if (wasActive) await this.supervisor.stop(workspace.slug);
    try {
      const { command, args } = this.opts.server;
      const data = join(this.folder(workspace.slug), "data");
      await run(command, [...args, "backup", "--data", data, "--out", path], { windowsHide: true });
      await run(command, [...args, "verify-backup", "--from", path], { windowsHide: true });
    } catch (error) {
      throw new Refusal(500, `The export failed: ${(error as Error).message}`);
    } finally {
      if (wasActive) await this.supervisor.start(this.spec(workspace));
    }
    this.log(`exported ${workspace.slug} to ${path}`);
    return { path };
  }

  /**
   * Deletes a workspace: a checked export first, kept in exports/, then its
   * folder. Its address stays taken, so it never leads to someone else.
   */
  remove(slug: string): Promise<{ export: string }> {
    return this.serialized(async () => {
      const workspace = this.existing(slug, ["active", "suspended"]);
      await this.supervisor.stop(slug);
      let path: string;
      try {
        // Stopped already, and to stay stopped: exported as a paused one is.
        ({ path } = await this.exportNow({ ...workspace, state: "suspended" }));
      } catch (error) {
        if (workspace.state === "active")
          await this.supervisor.start(this.spec(workspace)).catch(() => {});
        throw error;
      }
      this.registry.setState(slug, "deleted");
      await this.tellCaddy();
      rmSync(this.folder(slug), { recursive: true, force: true });
      this.log(`deleted ${slug}; its export is ${path}`);
      return { export: path };
    });
  }

  /** Starts every active workspace and tells Caddy about them. */
  async start(): Promise<void> {
    for (const workspace of this.registry.list()) {
      if (workspace.state !== "active") continue;
      try {
        await this.supervisor.start(this.spec(workspace));
      } catch (error) {
        // The supervisor keeps trying; the others still start.
        this.log(`${workspace.slug} did not start: ${(error as Error).message}`);
      }
    }
    await this.tellCaddy();
  }

  async stop(): Promise<void> {
    if (this.caddyRetry) clearTimeout(this.caddyRetry);
    this.caddyRetry = null;
    await this.supervisor.stopAll();
    await this.app.close();
    this.registry.close();
  }

  private authorized(req: FastifyRequest): boolean {
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const digest = (text: string) => createHash("sha256").update(text).digest();
    return timingSafeEqual(digest(given), digest(this.opts.token));
  }

  private routes(): void {
    const app = this.app;
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof Refusal) return reply.code(error.status).send({ error: error.message });
      if (error instanceof z.ZodError)
        return reply.code(400).send({ error: error.issues.map((i) => i.message).join("; ") });
      // Fastify's own refusals of a request, such as a body that is not JSON.
      const status = (error as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500)
        return reply.code(status).send({ error: (error as Error).message });
      this.log(`error: ${(error as Error).message}`);
      return reply.code(500).send({ error: "Something went wrong; the log says what" });
    });

    // Caddy asks before getting a certificate for a name: only a workspace
    // that exists, running or paused, has one.
    app.get("/caddy/ask", async (req, reply) => {
      const domain = String((req.query as { domain?: string }).domain ?? "").toLowerCase();
      const suffix = `.${this.opts.domain}`;
      const slug = domain.endsWith(suffix) ? domain.slice(0, -suffix.length) : "";
      const workspace = slug ? this.registry.get(slug) : null;
      const known = !!workspace && workspace.state !== "deleted";
      return reply.code(known ? 200 : 404).send(known ? "ok" : "unknown");
    });

    app.register(async (api) => {
      api.addHook("onRequest", async (req, reply) => {
        if (!this.authorized(req)) return reply.code(401).send({ error: "Not authorized" });
      });
      api.get("/api/workspaces", async () => ({
        caddy: this.caddy,
        workspaces: await Promise.all(
          this.registry
            .list()
            .filter((w) => w.state !== "deleted")
            .map((w) => this.view(w)),
        ),
      }));
      api.get("/api/workspaces/:slug", async (req) =>
        this.view(this.existing((req.params as { slug: string }).slug, ["active", "suspended"])),
      );
      api.post("/api/workspaces", async (req, reply) =>
        reply.code(201).send(await this.create(createBody.parse(req.body))),
      );
      api.post("/api/workspaces/:slug/suspend", async (req) =>
        this.suspend((req.params as { slug: string }).slug),
      );
      api.post("/api/workspaces/:slug/resume", async (req) =>
        this.resume((req.params as { slug: string }).slug),
      );
      api.post("/api/workspaces/:slug/export", async (req) =>
        this.export((req.params as { slug: string }).slug),
      );
      api.delete("/api/workspaces/:slug", async (req) =>
        this.remove((req.params as { slug: string }).slug),
      );
    });
  }
}
