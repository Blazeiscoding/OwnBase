import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutboundError, postToUrl } from "../src/outbound.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * An app that takes its time. `hold` decides how long each request waits
 * before it is answered, and `arrived` resolves when the first one lands.
 */
class SlowApp {
  private server: Server;
  port = 0;
  hold = 10_000;
  answer: (req: IncomingMessage, body: string) => string = () => "";
  /** Requests whose connection went away before they were answered. */
  abandoned = 0;
  private arrivedNow!: () => void;
  arrived = new Promise<void>((r) => (this.arrivedNow = r));

  constructor() {
    this.server = createServer((req, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const challenge = /"challenge":"([^"]+)"/.exec(body)?.[1];
        // The handshake that registers a subscription is answered at once.
        if (challenge) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ challenge }));
          return;
        }
        this.arrivedNow();
        const timer = setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(this.answer(req, body));
        }, this.hold);
        res.on("close", () => {
          if (!res.writableFinished) {
            this.abandoned++;
            clearTimeout(timer);
          }
        });
      });
    });
  }

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
  }

  url(path: string) {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  stop() {
    this.server.closeAllConnections();
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

/**
 * Records every store call that failed because the database had already been
 * closed. That error is the thing this file exists to keep unreachable, and it
 * is otherwise silent: by the time it happens the request log is closed too.
 */
function watchForClosedDatabase(server: WorkspaceServer): string[] {
  const failures: string[] = [];
  const store = server.store as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(server.store))) {
    const method = store[name];
    if (name === "constructor" || typeof method !== "function") continue;
    store[name] = function (this: unknown, ...args: unknown[]) {
      try {
        return (method as (...a: unknown[]) => unknown).apply(this, args);
      } catch (error) {
        if (/database is not open/i.test(String(error))) failures.push(name);
        throw error;
      }
    };
  }
  return failures;
}

let app: SlowApp;
let server: WorkspaceServer | undefined;
let directory: string;

async function start() {
  server = await createWorkspaceServer({
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    allowPrivateHooks: true,
    logger: false,
  });
  return `http://127.0.0.1:${server.port}`;
}

async function call<T = any>(base: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T };
}

async function owner(base: string) {
  const { data } = await call<{ token: string }>(base, "/api/auth/register", undefined, {
    handle: "owner",
    displayName: "Owner",
    password: "password123",
  });
  return data.token;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ownbase-shutdown-"));
  app = new SlowApp();
  await app.start();
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await app.stop();
  rmSync(directory, { recursive: true, force: true });
});

describe("stopping while a request is still being worked on", () => {
  it("finishes a sign-in that was checking a password before closing the database", async () => {
    const base = await start();
    await owner(base);
    const failures = watchForClosedDatabase(server!);

    // Stop the moment the handler has looked the account up, which is just
    // before it spends a deliberate while hashing the password and then
    // writes a session. The connection is gone long before that write.
    const store = server!.store as unknown as Record<string, (...a: unknown[]) => unknown>;
    const lookup = store.getUserAuthByHandle!;
    let stopped: Promise<void> | undefined;
    store.getUserAuthByHandle = function (this: unknown, ...args: unknown[]) {
      const found = lookup.apply(this, args);
      stopped ??= server!.stop();
      return found;
    };
    const login = call(base, "/api/auth/login", undefined, {
      handle: "owner",
      password: "password123",
    }).catch(() => null);

    await login;
    await stopped;
    server = undefined;
    // Long enough for a hash left running on its own to have finished.
    await new Promise((r) => setTimeout(r, 400));
    expect(failures).toEqual([]);
  });

  it("does not wait out a slow app, and does not touch a closed database afterwards", async () => {
    const base = await start();
    const token = await owner(base);
    const { data: made } = await call<{ app: { id: string } }>(base, "/api/apps", token, {
      name: "Slow Bot",
    });
    const registered = await call(base, `/api/apps/${made.app.id}/commands`, token, {
      command: "/slow",
      url: app.url("/command"),
    });
    expect(registered.status).toBe(201);
    const channelId = server!.store.getChannelByName("general")!.id;
    const failures = watchForClosedDatabase(server!);

    void call(base, `/api/channels/${channelId}/commands`, token, { text: "/slow" }).catch(
      () => null,
    );
    await app.arrived;

    // The app would answer in ten seconds and the call's own timeout is four;
    // shutdown should wait for neither.
    const began = Date.now();
    await server!.stop();
    server = undefined;
    expect(Date.now() - began).toBeLessThan(2000);
    await new Promise((r) => setTimeout(r, 300));
    expect(app.abandoned).toBe(1);
    expect(failures).toEqual([]);
  });

  it("can be asked to stop twice, and means it both times", async () => {
    await start();
    const first = server!.stop();
    const second = server!.stop();
    expect(second).toBe(first);
    await first;
    server = undefined;
  });
});

describe("an event delivery cut short by shutdown", () => {
  it("is not counted against the endpoint, and goes out after the restart", async () => {
    let base = await start();
    const token = await owner(base);
    const { data: made } = await call<{ app: { id: string }; botUser: { id: string } }>(
      base,
      "/api/apps",
      token,
      { name: "Events Bot" },
    );
    const subscribed = await call(base, `/api/apps/${made.app.id}/subscriptions`, token, {
      url: app.url("/events"),
      eventTypes: ["message.created"],
    });
    expect(subscribed.status).toBe(201);
    const channelId = server!.store.getChannelByName("general")!.id;
    server!.store.addMember(channelId, made.botUser.id);

    await call(base, `/api/channels/${channelId}/messages`, token, { text: "on its way" });
    await app.arrived;
    await server!.stop();
    server = undefined;

    base = await start();
    // Nothing about the endpoint was learned: it neither answered nor refused.
    // Charging it an attempt would push the event hours down the retry ladder
    // for something this server did.
    const due = server!.store.dueEventDeliveries(Date.now());
    expect(due).toHaveLength(1);
    expect(due[0]!.attempts).toBe(0);
  });
});

describe("an outbound call and the shutdown signal", () => {
  it("does not start once shutdown has begun", async () => {
    const controller = new AbortController();
    controller.abort();
    const refused = await postToUrl(app.url("/x"), "{}", "application/json", {
      allowPrivate: true,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(OutboundError);
    expect((refused as OutboundError).code).toBe("aborted");
  });

  it("ends one already waiting, promptly", async () => {
    const controller = new AbortController();
    const pending = postToUrl(app.url("/x"), "{}", "application/json", {
      allowPrivate: true,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    await app.arrived;
    const began = Date.now();
    controller.abort();
    const ended = await pending;
    expect(Date.now() - began).toBeLessThan(500);
    expect((ended as OutboundError).code).toBe("aborted");
  });
});
