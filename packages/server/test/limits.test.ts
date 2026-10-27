import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";
import { APP_CALLS_IN_FLIGHT, DEFAULT_LIMITS, RateLimiter } from "../src/limits.js";

let server: WorkspaceServer | undefined;
let dataDir: string | undefined;
let base = "";

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

async function start(
  rateLimits?: Parameters<typeof createWorkspaceServer>[0]["rateLimits"],
  trustedClientProxy?: Parameters<typeof createWorkspaceServer>[0]["trustedClientProxy"],
) {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-limits-"));
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits,
    trustedClientProxy,
    // The stand-in app below listens on loopback.
    allowPrivateHooks: true,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function call<T>(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; retryAfter: string | null; data: T }> {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return {
    status: res.status,
    retryAfter: res.headers.get("retry-after"),
    data: (await res.json()) as T,
  };
}

async function register(handle: string, password = "password123") {
  const { data } = await call<{ token: string }>("/api/auth/register", {
    body: { handle, displayName: handle, password },
  });
  return data.token;
}

describe("the token bucket", () => {
  const rule = { burst: 3, perMinute: 60 };
  const limits = { ...DEFAULT_LIMITS, post: rule };

  it("allows a burst, then refills at the rate it was given", () => {
    const limiter = new RateLimiter(limits);
    const t0 = 1_000_000;
    for (let i = 0; i < rule.burst; i++) expect(limiter.take("post", "a", t0).ok).toBe(true);

    const refused = limiter.take("post", "a", t0);
    expect(refused.ok).toBe(false);
    // One token a second at sixty a minute, so it says about a second.
    expect(refused.retryAfterMs).toBeGreaterThan(900);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(1000);

    expect(limiter.take("post", "a", t0 + 1000).ok).toBe(true);
    expect(limiter.take("post", "a", t0 + 1000).ok).toBe(false);
  });

  it("does not charge for a refusal, so being refused is not made worse", () => {
    const limiter = new RateLimiter(limits);
    const t0 = 2_000_000;
    for (let i = 0; i < rule.burst; i++) limiter.take("post", "a", t0);
    // Hammering while refused must not push recovery further out.
    for (let i = 0; i < 50; i++) expect(limiter.take("post", "a", t0).ok).toBe(false);
    expect(limiter.take("post", "a", t0 + 1000).ok).toBe(true);
  });

  it("keeps one caller's budget out of another's", () => {
    const limiter = new RateLimiter(limits);
    const t0 = 3_000_000;
    for (let i = 0; i < rule.burst; i++) limiter.take("post", "a", t0);
    expect(limiter.take("post", "a", t0).ok).toBe(false);
    expect(limiter.take("post", "b", t0).ok).toBe(true);
  });

  it("forgets callers once they have refilled, rather than remembering everyone", () => {
    const limiter = new RateLimiter(limits);
    let now = 4_000_000;
    for (let i = 0; i < 500; i++) limiter.take("post", `caller-${i}`, now);
    expect(limiter.size).toBeGreaterThan(0);

    // Long enough for every bucket to be full again. A full bucket says the
    // same thing as no bucket, so holding one would only cost memory.
    now += 60_000;
    limiter.take("post", "someone", now);
    expect(limiter.size).toBeLessThanOrEqual(1);
  });
});

describe("authentication limits", () => {
  it("stops a run of guesses at one handle, and says when to come back", async () => {
    await start({ authByHandle: { burst: 3, perMinute: 1 } });
    await register("target");

    for (let i = 0; i < 3; i++) {
      const wrong = await call("/api/auth/login", {
        body: { handle: "target", password: "not-the-password" },
      });
      expect(wrong.status).toBe(401);
    }
    const stopped = await call<{ error: string }>("/api/auth/login", {
      body: { handle: "target", password: "not-the-password" },
    });
    expect(stopped.status).toBe(429);
    expect(stopped.data.error).toBe("too_many_requests");
    // Something to wait for, rather than leaving a client to guess.
    expect(Number(stopped.retryAfter)).toBeGreaterThan(0);

    // The right password is refused too: that is the point, or a guesser would
    // simply keep going until it worked.
    const evenIfRight = await call("/api/auth/login", {
      body: { handle: "target", password: "password123" },
    });
    expect(evenIfRight.status).toBe(429);
  });

  it("never meets that limit when the password is right", async () => {
    await start({ authByHandle: { burst: 3, perMinute: 1 } });
    await register("regular");
    // Far more sign-ins than the burst allows, all of them correct. Only wrong
    // guesses are worth counting, so someone who knows their password is never
    // rationed however often they sign in.
    for (let i = 0; i < 10; i++) {
      const ok = await call("/api/auth/login", {
        body: { handle: "regular", password: "password123" },
      });
      expect(ok.status).toBe(200);
    }
  });

  it("keeps one handle's guesses off another account", async () => {
    await start({
      authByHandle: { burst: 2, perMinute: 1 },
      authByAddress: { burst: 500, perMinute: 500 },
    });
    await register("first");
    await register("second");

    for (let i = 0; i < 3; i++) {
      await call("/api/auth/login", { body: { handle: "first", password: "wrong" } });
    }
    expect(
      (await call("/api/auth/login", { body: { handle: "first", password: "wrong" } })).status,
    ).toBe(429);
    // A shared office address is one address for everybody in it, so one
    // person being guessed at must not lock their colleagues out.
    expect(
      (await call("/api/auth/login", { body: { handle: "second", password: "password123" } }))
        .status,
    ).toBe(200);
  });

  it("still bounds one address trying a great many different handles", async () => {
    await start({
      authByAddress: { burst: 4, perMinute: 1 },
      authByHandle: { burst: 100, perMinute: 100 },
    });
    await register("known");

    let refused = 0;
    for (let i = 0; i < 10; i++) {
      const res = await call(`/api/auth/login`, {
        body: { handle: `guess-${i}`, password: "wrong" },
      });
      if (res.status === 429) refused++;
    }
    // Spreading across handles evades the per-handle limit, which is what the
    // per-address one is there to catch.
    expect(refused).toBeGreaterThan(0);
  });

  it("gives Cloudflare visitors separate address budgets through a trusted loopback proxy", async () => {
    await start(
      {
        authByAddress: { burst: 1, perMinute: 1 },
        authByHandle: { burst: 100, perMinute: 100 },
      },
      "loopback",
    );

    const first = await call("/api/auth/login", {
      headers: { "cf-connecting-ip": "203.0.113.10" },
      body: { handle: "missing-one", password: "wrong" },
    });
    const second = await call("/api/auth/login", {
      headers: { "cf-connecting-ip": "203.0.113.11" },
      body: { handle: "missing-two", password: "wrong" },
    });
    const repeated = await call("/api/auth/login", {
      headers: { "cf-connecting-ip": "203.0.113.11" },
      body: { handle: "missing-three", password: "wrong" },
    });

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(repeated.status).toBe(429);
  });

  it("changes client-address trust only while the loopback proxy is enabled", async () => {
    await start({
      authByAddress: { burst: 1, perMinute: 1 },
      authByHandle: { burst: 100, perMinute: 100 },
    });

    expect(
      (
        await call("/api/auth/login", {
          headers: { "cf-connecting-ip": "203.0.113.20" },
          body: { handle: "missing-one", password: "wrong" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("/api/auth/login", {
          headers: { "cf-connecting-ip": "203.0.113.21" },
          body: { handle: "missing-two", password: "wrong" },
        })
      ).status,
    ).toBe(429);

    server!.setTrustLoopbackProxy(true);
    for (const [address, handle] of [
      ["203.0.113.20", "missing-three"],
      ["203.0.113.21", "missing-four"],
    ] as const) {
      expect(
        (
          await call("/api/auth/login", {
            headers: { "cf-connecting-ip": address },
            body: { handle, password: "wrong" },
          })
        ).status,
      ).toBe(401);
    }

    server!.setTrustLoopbackProxy(false);
    expect(
      (
        await call("/api/auth/login", {
          headers: { "cf-connecting-ip": "203.0.113.22" },
          body: { handle: "missing-five", password: "wrong" },
        })
      ).status,
    ).toBe(429);
  });
});

describe("posting and upload limits", () => {
  it("charges built-in messages to the same account post budget as normal messages", async () => {
    await start({ post: { burst: 1, perMinute: 1 } });
    const noisy = await register("noisy");
    const quiet = await register("quiet");
    const channelId = server!.store.getChannelByName("general")!.id;

    const first = await call(`/api/channels/${channelId}/messages`, {
      token: noisy,
      body: { text: "one normal message" },
    });
    expect(first.status).toBe(201);
    for (const text of ["/shrug bypass", "/me bypass"]) {
      const blocked = await call<{ error: string }>(`/api/channels/${channelId}/commands`, {
        token: noisy,
        body: { text },
      });
      expect(blocked.status).toBe(429);
      expect(blocked.data.error).toBe("too_many_requests");
      expect(Number(blocked.retryAfter)).toBeGreaterThan(0);
    }
    expect(server!.store.listMessages({ channelId, limit: 10 }).map((m) => m.text)).toEqual([
      "one normal message",
    ]);

    const other = await call(`/api/channels/${channelId}/commands`, {
      token: quiet,
      body: { text: "/shrug unaffected" },
    });
    expect(other.status).toBe(200);
    expect(server!.store.listMessages({ channelId, limit: 10 })).toHaveLength(2);
  });

  it("lets a built-in spend the post budget, without charging invalid usage", async () => {
    await start({ post: { burst: 1, perMinute: 1 } });
    const token = await register("speaker");
    const channelId = server!.store.getChannelByName("general")!.id;

    expect(
      (await call(`/api/channels/${channelId}/commands`, { token, body: { text: "/me" } })).status,
    ).toBe(400);
    expect(
      (await call(`/api/channels/${channelId}/commands`, { token, body: { text: "/shrug" } }))
        .status,
    ).toBe(200);
    expect(
      (
        await call(`/api/channels/${channelId}/messages`, {
          token,
          body: { text: "another post" },
        })
      ).status,
    ).toBe(429);
    expect(server!.store.listMessages({ channelId, limit: 10 })).toHaveLength(1);
  });

  it("refuses to schedule a message once the post budget is spent", async () => {
    await start({ post: { burst: 1, perMinute: 1 } });
    const noisy = await register("noisy");
    const quiet = await register("quiet");
    const channelId = server!.store.getChannelByName("general")!.id;
    const sendAt = Date.now() + 60_000;

    expect(
      (await call(`/api/channels/${channelId}/messages`, { token: noisy, body: { text: "one" } }))
        .status,
    ).toBe(201);
    // A scheduled message becomes an ordinary one later, so queuing it is
    // posting on a delay, not a way round the limit.
    const blocked = await call<{ error: string }>(`/api/channels/${channelId}/scheduled`, {
      token: noisy,
      body: { text: "later instead", sendAt },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.data.error).toBe("too_many_requests");
    expect(Number(blocked.retryAfter)).toBeGreaterThan(0);
    expect(
      (await call<{ scheduled: unknown[] }>("/api/scheduled", { token: noisy })).data.scheduled,
    ).toEqual([]);

    const other = await call(`/api/channels/${channelId}/scheduled`, {
      token: quiet,
      body: { text: "unaffected", sendAt },
    });
    expect(other.status).toBe(201);
  });

  it("charges a scheduled message once, when it is queued, not on a retry or at delivery", async () => {
    await start({ post: { burst: 1, perMinute: 1 } });
    const token = await register("planner");
    const channelId = server!.store.getChannelByName("general")!.id;
    const request = { text: "queued once", sendAt: Date.now() + 60_000, nonce: "schedule-once" };

    const accepted = await call<{ scheduled: { id: string } }>(
      `/api/channels/${channelId}/scheduled`,
      { token, body: request },
    );
    expect(accepted.status).toBe(201);
    expect(
      (await call(`/api/channels/${channelId}/messages`, { token, body: { text: "now too" } }))
        .status,
    ).toBe(429);

    // A client that lost the answer retries; it gets what was accepted, not a refusal.
    const replay = await call<{ scheduled: { id: string } }>(
      `/api/channels/${channelId}/scheduled`,
      { token, body: request },
    );
    expect(replay.status).toBe(200);
    expect(replay.data.scheduled.id).toBe(accepted.data.scheduled.id);

    // Paid for when queued, so the empty budget does not hold it back when due.
    const id = accepted.data.scheduled.id;
    expect(
      (
        await call(`/api/scheduled/${id}`, {
          token,
          method: "PATCH",
          body: { sendAt: Date.now() - 1000 },
        })
      ).status,
    ).toBe(200);
    server!.flushScheduled();
    expect(server!.store.getScheduled(id)?.status).toBe("sent");
    expect(server!.store.listMessages({ channelId, limit: 10 }).map((m) => m.text)).toEqual([
      "queued once",
    ]);
  });

  it("refuses a flood from one account without touching anyone else", async () => {
    await start({ post: { burst: 3, perMinute: 1 } });
    const noisy = await register("noisy");
    const quiet = await register("quiet");
    const channelId = server!.store.getChannelByName("general")!.id;

    let refused = 0;
    for (let i = 0; i < 6; i++) {
      const res = await call(`/api/channels/${channelId}/messages`, {
        token: noisy,
        body: { text: `flood ${i}` },
      });
      if (res.status === 429) refused++;
    }
    expect(refused).toBeGreaterThan(0);

    // Keyed on the account, so a whole office behind one address does not
    // share one person's allowance.
    const other = await call(`/api/channels/${channelId}/messages`, {
      token: quiet,
      body: { text: "unaffected" },
    });
    expect(other.status).toBe(201);
  });

  it("leaves reading alone when writing has been cut off", async () => {
    await start({ post: { burst: 1, perMinute: 1 } });
    const token = await register("reader");
    const channelId = server!.store.getChannelByName("general")!.id;

    await call(`/api/channels/${channelId}/messages`, { token, body: { text: "one" } });
    expect(
      (await call(`/api/channels/${channelId}/messages`, { token, body: { text: "two" } })).status,
    ).toBe(429);
    // Being told to slow down should not amount to being signed out.
    expect((await call(`/api/channels/${channelId}/messages`, { token })).status).toBe(200);
    expect((await call("/api/me", { token })).status).toBe(200);
  });
});

describe("socket limits", () => {
  function connect(headers?: Record<string, string>): Promise<"open" | "refused"> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`, { headers });
      ws.on("open", () => {
        ws.close();
        resolve("open");
      });
      ws.on("error", () => resolve("refused"));
      ws.on("close", () => resolve("refused"));
    });
  }

  it("stops one address opening sockets without end", async () => {
    await start({ socket: { burst: 3, perMinute: 1 } });
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) outcomes.push(await connect());
    expect(outcomes.slice(0, 3).every((o) => o === "open")).toBe(true);
    expect(outcomes.includes("refused")).toBe(true);
  });

  it("gives Cloudflare visitors separate socket budgets through a trusted loopback proxy", async () => {
    await start({ socket: { burst: 1, perMinute: 1 } }, "loopback");
    expect(await connect({ "cf-connecting-ip": "203.0.113.30" })).toBe("open");
    expect(await connect({ "cf-connecting-ip": "203.0.113.31" })).toBe("open");
    expect(await connect({ "cf-connecting-ip": "203.0.113.31" })).toBe("refused");
  });
});

describe("turning limits off", () => {
  it("rations nothing when the host has said not to", async () => {
    await start(false);
    const token = await register("unlimited");
    const channelId = server!.store.getChannelByName("general")!.id;
    for (let i = 0; i < 80; i++) {
      const res = await call(`/api/channels/${channelId}/messages`, {
        token,
        body: { text: `no limit ${i}` },
      });
      expect(res.status).toBe(201);
    }
    expect(
      (await call(`/api/channels/${channelId}/commands`, { token, body: { text: "/shrug" } }))
        .status,
    ).toBe(200);
    expect(
      (
        await call(`/api/channels/${channelId}/commands`, {
          token,
          body: { text: "/me unbounded" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(`/api/channels/${channelId}/scheduled`, {
          token,
          body: { text: "scheduled unbounded", sendAt: Date.now() + 60_000 },
        })
      ).status,
    ).toBe(201);
  }, 15_000);
});

describe("typing notices", () => {
  it("drops the excess quietly rather than closing the socket", async () => {
    await start({ ephemeral: { burst: 2, perMinute: 1 } });
    const token = await register("typist");
    const channelId = server!.store.getChannelByName("general")!.id;

    const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`);
    const seen: ServerToClient[] = [];
    ws.on("message", (d) => seen.push(JSON.parse(String(d)) as ServerToClient));
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no ready frame")), 3000);
      const check = () => {
        if (seen.some((m) => m.type === "ready")) {
          clearTimeout(timer);
          resolve();
        } else setTimeout(check, 20);
      };
      check();
    });

    for (let i = 0; i < 20; i++) ws.send(JSON.stringify({ type: "typing", channelId }));
    // A dropped typing notice is not worth an error frame, and certainly not
    // worth losing the connection the person is talking over.
    const pongs = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket went quiet")), 3000);
      const check = () => {
        if (seen.some((m) => m.type === "pong")) {
          clearTimeout(timer);
          resolve();
        } else setTimeout(check, 20);
      };
      check();
    });
    ws.send(JSON.stringify({ type: "ping" }));
    await pongs;
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(seen.some((m) => m.type === "error")).toBe(false);
    ws.close();
  });
});

/**
 * An app that answers its verification handshake at once and holds every
 * other request until told to answer, so calls can be kept in flight.
 */
class HeldApp {
  server: Server;
  port = 0;
  calls: string[] = [];
  hold = true;
  private waiting: (() => void)[] = [];

  constructor() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        if (body.includes("url_verification")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ challenge: (JSON.parse(body) as { challenge: string }).challenge }),
          );
          return;
        }
        this.calls.push(req.url ?? "");
        const answer = () => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("");
        };
        if (this.hold) this.waiting.push(answer);
        else answer();
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  get held(): number {
    return this.waiting.length;
  }

  answerAll(): void {
    this.hold = false;
    for (const answer of this.waiting.splice(0)) answer();
  }

  async stop(): Promise<void> {
    this.answerAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe("incoming webhooks", () => {
  async function webhooks(owner: string, count: number) {
    const channelId = server!.store.getChannelByName("general")!.id;
    const { data: created } = await call<{ app: { id: string } }>("/api/apps", {
      token: owner,
      body: { name: "Alerts" },
    });
    const urls: string[] = [];
    for (let i = 0; i < count; i++) {
      const { data } = await call<{ url: string }>(`/api/apps/${created.app.id}/webhooks`, {
        token: owner,
        body: { channelId },
      });
      urls.push(data.url);
    }
    return { channelId, urls };
  }
  /** Posts to a webhook, which answers Slack's way: plain "ok" on success. */
  const hook = async (url: string, text: string) => {
    const res = await fetch(`${base}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    await res.text();
    return { status: res.status, retryAfter: res.headers.get("retry-after") };
  };

  it("gives each webhook its own budget, apart from the app's other webhooks and from people", async () => {
    await start({ hook: { burst: 2, perMinute: 1 }, post: { burst: 1, perMinute: 1 } });
    const owner = await register("owner");
    const { channelId, urls } = await webhooks(owner, 2);
    const [noisy, quiet] = urls as [string, string];

    expect((await hook(noisy, "one")).status).toBe(200);
    expect((await hook(noisy, "two")).status).toBe(200);
    const refused = await hook(noisy, "three");
    expect(refused.status).toBe(429);
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);

    expect((await hook(quiet, "from the other webhook")).status).toBe(200);
    expect(
      (await call(`/api/channels/${channelId}/messages`, { token: owner, body: { text: "me" } }))
        .status,
    ).toBe(201);
    expect(
      server!.store
        .listMessages({ channelId, limit: 10 })
        .map((m) => m.text)
        .sort(),
    ).toEqual(["from the other webhook", "me", "one", "two"]);
  });

  it("counts guessed tokens against the address they come from", async () => {
    await start({ hookByAddress: { burst: 3, perMinute: 1 } });
    const owner = await register("owner");
    const { urls } = await webhooks(owner, 1);
    for (const guess of ["/hooks/nope-1", "/hooks/nope-2", "/hooks/nope-3"])
      expect((await hook(guess, "guess")).status).toBe(404);
    // The right token from the same address waits like everything else from it.
    expect((await hook(urls[0]!, "real")).status).toBe(429);
  });

  it("stays unlimited when the workspace turns limits off", async () => {
    await start(false);
    const owner = await register("owner");
    const { urls } = await webhooks(owner, 1);
    for (let i = 0; i < DEFAULT_LIMITS.hook.burst + 5; i++)
      expect((await hook(urls[0]!, `n${i}`)).status).toBe(200);
  });
});

describe("calls out to apps", () => {
  let app: HeldApp;
  afterEach(async () => {
    await app?.stop();
  });

  /** An app with a slash command and buttons, all pointing at `app`. */
  async function installed(owner: string) {
    const channelId = server!.store.getChannelByName("general")!.id;
    const { data: created } = await call<{ app: { id: string } }>("/api/apps", {
      token: owner,
      body: { name: "Deployer" },
    });
    const appId = created.app.id;
    expect(
      (
        await call(`/api/apps/${appId}/commands`, {
          token: owner,
          body: { command: "/deploy", url: app.url("/deploy") },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(`/api/apps/${appId}/interactivity`, {
          method: "PUT",
          token: owner,
          body: { url: app.url("/interact") },
        })
      ).status,
    ).toBe(200);
    const { data: hook } = await call<{ url: string }>(`/api/apps/${appId}/webhooks`, {
      token: owner,
      body: { channelId },
    });
    await fetch(`${base}${hook.url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Ship it?",
        blocks: [
          {
            type: "actions",
            elements: [
              { type: "button", text: { type: "plain_text", text: "Ship" }, action_id: "ship" },
            ],
          },
        ],
      }),
    });
    const withButton = server!.store
      .listMessages({ channelId, limit: 10 })
      .find((m) => m.actions.length > 0)!;
    const command = (token: string) =>
      call<{ ok?: boolean; error?: string; message?: string }>(
        `/api/channels/${channelId}/commands`,
        { token, body: { text: "/deploy now" } },
      );
    const press = (token: string) =>
      call<{ ok?: boolean; error?: string }>(`/api/messages/${withButton.id}/actions`, {
        token,
        body: { actionId: "ship" },
      });
    return { command, press };
  }

  it("spends one budget per account on commands and buttons, and sends nothing it refuses", async () => {
    app = new HeldApp();
    await app.start();
    app.hold = false;
    await start({ appCall: { burst: 2, perMinute: 1 } });
    const owner = await register("owner");
    const other = await register("other");
    const { command, press } = await installed(owner);

    expect((await command(owner)).status).toBe(200);
    expect((await press(owner)).status).toBe(200);
    const refused = await command(owner);
    expect(refused.status).toBe(429);
    expect(refused.data.error).toBe("too_many_requests");
    expect((await press(owner)).status).toBe(429);
    expect(app.calls).toEqual(["/deploy", "/interact"]);

    expect((await command(other)).status).toBe(200);
    expect(app.calls).toHaveLength(3);
  });

  it("holds no more than a few unanswered calls per account, and frees them as they finish", async () => {
    app = new HeldApp();
    await app.start();
    await start();
    const owner = await register("owner");
    const other = await register("other");
    const { command } = await installed(owner);

    const waiting = Array.from({ length: APP_CALLS_IN_FLIGHT.perAccount }, () => command(owner));
    await expect.poll(() => app.held).toBe(APP_CALLS_IN_FLIGHT.perAccount);
    const refused = await command(owner);
    expect(refused.status).toBe(429);
    expect(refused.data.message).toMatch(/not been answered yet/);
    expect(app.held).toBe(APP_CALLS_IN_FLIGHT.perAccount);

    // Someone else is not held up by it.
    const theirs = command(other);
    await expect.poll(() => app.held).toBe(APP_CALLS_IN_FLIGHT.perAccount + 1);

    app.answerAll();
    for (const done of [...waiting, theirs]) expect((await done).status).toBe(200);
    expect((await command(owner)).status).toBe(200);
  });

  it("holds no more than a bounded number of unanswered calls to one app", async () => {
    app = new HeldApp();
    await app.start();
    await start({ authByAddress: { burst: 100, perMinute: 100 } });
    const owner = await register("owner");
    const { command } = await installed(owner);
    const people = [owner];
    const needed = Math.ceil(APP_CALLS_IN_FLIGHT.perApp / APP_CALLS_IN_FLIGHT.perAccount);
    for (let i = 1; i < needed; i++) people.push(await register(`member${i}`));
    const latecomer = await register("latecomer");

    const waiting = people.flatMap((token) =>
      Array.from({ length: APP_CALLS_IN_FLIGHT.perAccount }, () => command(token)),
    );
    await expect.poll(() => app.held).toBe(APP_CALLS_IN_FLIGHT.perApp);
    const busy = await command(latecomer);
    expect(busy.status).toBe(429);
    expect(busy.data.error).toBe("app_busy");

    app.answerAll();
    for (const done of waiting) expect((await done).status).toBe(200);
    expect((await command(latecomer)).status).toBe(200);
  });
});
