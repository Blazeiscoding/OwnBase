import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_SCOPES, type App, type User } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";
import { SOCKET_TICKET_TTL_MS, SocketTickets } from "../src/apps/socketTickets.js";

/**
 * Socket Mode (J14): an app with no public address opens a socket to the
 * server with an app-level token and is sent its events, commands and button
 * presses over it, as Slack's Socket Mode does.
 */
let server: WorkspaceServer;
let base: string;
let dataDir: string;
let aliceToken: string;
let bobToken: string;

/** Stands in for an app's URL, counting what it is sent. */
let endpoint: Server;
let endpointUrl: string;
const received: string[] = [];

async function api<T = any>(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as T };
}

async function newApp(name: string) {
  const { data } = await api<{ app: App; botUser: User; token: string }>("/api/apps", {
    token: aliceToken,
    body: { name, scopes: APP_SCOPES },
  });
  return { id: data.app.id, botUser: data.botUser, token: data.token };
}

async function socketApp(name: string) {
  const app = await newApp(name);
  const switched = await api(`/api/apps/${app.id}/receive`, {
    method: "PUT",
    token: aliceToken,
    body: { receive: "socket" },
  });
  expect(switched.status).toBe(200);
  const made = await api<{ token: string }>(`/api/apps/${app.id}/app-token`, {
    method: "POST",
    token: aliceToken,
  });
  return { ...app, appToken: made.data.token };
}

const open = (token: string) =>
  api<{ ok: boolean; url?: string; error?: string }>("/api/apps.connections.open", {
    method: "POST",
    token,
  });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-socket-mode-"));
  endpoint = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      received.push(body);
      const challenge = (JSON.parse(body || "{}") as { challenge?: string }).challenge;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ challenge }));
    });
  });
  await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
  endpointUrl = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}/events`;
  server = await createWorkspaceServer({
    dataDir,
    port: 0,
    workspaceName: "Socket Mode",
    mdns: false,
    allowPrivateHooks: true,
    logger: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  const a = await api<{ token: string }>("/api/auth/register", {
    body: { handle: "alice", displayName: "Alice", password: "password123" },
  });
  aliceToken = a.data.token;
  const b = await api<{ token: string }>("/api/auth/register", {
    body: { handle: "bob", displayName: "Bob", password: "password123" },
  });
  bobToken = b.data.token;
});

afterAll(async () => {
  await server.stop();
  await new Promise<void>((r) => endpoint.close(() => r()));
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the app-level token", () => {
  it("is shown once, kept only as a hash, and refused once revoked or replaced", async () => {
    const app = await newApp("Token Bot");
    const made = await api<{ token: string }>(`/api/apps/${app.id}/app-token`, {
      method: "POST",
      token: aliceToken,
    });
    expect(made.status).toBe(200);
    const token = made.data.token;
    expect(token).toMatch(/^xapp-/);

    const db = (server.store as unknown as { db: { prepare: (s: string) => any } }).db;
    const row = db.prepare("SELECT app_token_hash FROM apps WHERE id = ?").get(app.id) as {
      app_token_hash: string;
    };
    expect(row.app_token_hash).toBe(createHash("sha256").update(token).digest("hex"));

    const listed = await api<{ apps: { id: string; hasAppToken: boolean }[] }>("/api/apps", {
      token: aliceToken,
    });
    expect(listed.data.apps.find((a) => a.id === app.id)!.hasAppToken).toBe(true);
    expect(JSON.stringify(listed.data)).not.toContain(token);

    // Slack's answer while the app is still sent things by URL.
    expect((await open(token)).data).toEqual({ ok: false, error: "socket_mode_disabled" });
    await api(`/api/apps/${app.id}/receive`, {
      method: "PUT",
      token: aliceToken,
      body: { receive: "socket" },
    });
    expect((await open(token)).data.ok).toBe(true);

    const replaced = await api<{ token: string }>(`/api/apps/${app.id}/app-token`, {
      method: "POST",
      token: aliceToken,
    });
    expect((await open(token)).data).toEqual({ ok: false, error: "invalid_auth" });
    expect((await open(replaced.data.token)).data.ok).toBe(true);

    const revoked = await api(`/api/apps/${app.id}/app-token`, {
      method: "DELETE",
      token: aliceToken,
    });
    expect(revoked.status).toBe(200);
    expect((await open(replaced.data.token)).data).toEqual({ ok: false, error: "invalid_auth" });
  });

  it("opens sockets and nothing else", async () => {
    const app = await socketApp("Narrow Bot");
    const posted = await api("/api/chat.postMessage", {
      token: app.appToken,
      body: { channel: "general", text: "hi" },
    });
    expect(posted.data).toEqual({ ok: false, error: "invalid_auth" });
  });

  it("is the only token apps.connections.open takes", async () => {
    const app = await socketApp("Picky Bot");
    // Slack's refusal for a bot token, which Bolt prints as it is.
    expect((await open(app.token)).data).toEqual({ ok: false, error: "not_allowed_token_type" });
    expect((await open(bobToken)).data).toEqual({ ok: false, error: "invalid_auth" });
    expect((await open(aliceToken)).data).toEqual({ ok: false, error: "invalid_auth" });
    const answered = await open(app.appToken);
    expect(answered.data.ok).toBe(true);
    expect(answered.data.url).toMatch(
      new RegExp(`^ws://127\\.0\\.0\\.1:${server.port}/apps/socket\\?ticket=[a-f0-9]{64}$`),
    );
  });

  it("is made and taken away by administrators only", async () => {
    const app = await newApp("Guarded Bot");
    const made = await api(`/api/apps/${app.id}/app-token`, { method: "POST", token: bobToken });
    expect(made.status).toBe(403);
    const switched = await api(`/api/apps/${app.id}/receive`, {
      method: "PUT",
      token: bobToken,
      body: { receive: "socket" },
    });
    expect(switched.status).toBe(403);
  });
});

describe("socket tickets", () => {
  it("work once, and not after they expire or their app's tokens change", () => {
    const tickets = new SocketTickets();
    const now = 1_000_000;
    const ticket = tickets.issue("A", "hash", now);
    expect(tickets.spend(ticket, now)).toEqual({ appId: "A", tokenHash: "hash" });
    expect(tickets.spend(ticket, now)).toBeNull();

    const late = tickets.issue("A", "hash", now);
    expect(tickets.spend(late, now + SOCKET_TICKET_TTL_MS)).toBeNull();

    const forgotten = tickets.issue("A", "hash", now);
    const other = tickets.issue("B", "hash", now);
    tickets.forget("A");
    expect(tickets.spend(forgotten, now)).toBeNull();
    expect(tickets.spend(other, now)).toEqual({ appId: "B", tokenHash: "hash" });

    expect(tickets.spend("not a ticket", now)).toBeNull();
  });
});

describe("subscriptions and commands", () => {
  it("need no URL and send no url_verification for an app on Socket Mode", async () => {
    const app = await socketApp("Quiet Bot");
    received.length = 0;
    const sub = await api<{ subscription: { url: string } }>(`/api/apps/${app.id}/subscriptions`, {
      token: aliceToken,
      body: { eventTypes: ["message.created"] },
    });
    expect(sub.status).toBe(201);
    expect(sub.data.subscription.url).toBe("");
    const command = await api<{ command: { url: string } }>(`/api/apps/${app.id}/commands`, {
      token: aliceToken,
      body: { command: "quiet" },
    });
    expect(command.status).toBe(201);
    expect(command.data.command.url).toBe("");
    expect(received).toEqual([]);
  });

  it("still need a URL, and the URL still answers the check, for an app sent things by URL", async () => {
    const app = await newApp("Plain Bot");
    const sub = await api<{ error: string }>(`/api/apps/${app.id}/subscriptions`, {
      token: aliceToken,
      body: { eventTypes: ["message.created"] },
    });
    expect(sub.status).toBe(400);
    expect(sub.data.error).toBe("url_required");
    const command = await api<{ error: string }>(`/api/apps/${app.id}/commands`, {
      token: aliceToken,
      body: { command: "plain" },
    });
    expect(command.status).toBe(400);
    expect(command.data.error).toBe("url_required");

    received.length = 0;
    const verified = await api(`/api/apps/${app.id}/subscriptions`, {
      token: aliceToken,
      body: { url: endpointUrl, eventTypes: ["message.created"] },
    });
    expect(verified.status).toBe(201);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!)).toMatchObject({ type: "url_verification" });
  });

  it("keep an app on Socket Mode while one of them has no URL", async () => {
    const app = await socketApp("Stuck Bot");
    const sub = await api<{ subscription: { id: string } }>(`/api/apps/${app.id}/subscriptions`, {
      token: aliceToken,
      body: {},
    });
    const command = await api<{ command: { id: string } }>(`/api/apps/${app.id}/commands`, {
      token: aliceToken,
      body: { command: "stuck" },
    });
    const refused = await api<{ error: string; message: string }>(`/api/apps/${app.id}/receive`, {
      method: "PUT",
      token: aliceToken,
      body: { receive: "url" },
    });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toBe("urls_missing");
    expect(refused.data.message).toContain("/stuck");
    expect(refused.data.message).toContain("event subscription");

    await api(`/api/commands/${command.data.command.id}`, { method: "DELETE", token: aliceToken });
    await api(`/api/subscriptions/${sub.data.subscription.id}`, {
      method: "DELETE",
      token: aliceToken,
    });
    const allowed = await api<{ app: App }>(`/api/apps/${app.id}/receive`, {
      method: "PUT",
      token: aliceToken,
      body: { receive: "url" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.data.app.receive).toBe("url");
  });
});
