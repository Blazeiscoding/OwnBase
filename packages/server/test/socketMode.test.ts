import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  APP_SCOPES,
  PROTOCOL_VERSION,
  type App,
  type Message,
  type ServerToClient,
  type User,
} from "@ownbase/protocol";
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
let channelId: string;

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

/** A frame the server sent an app over its socket. */
interface Frame {
  type: string;
  envelope_id?: string;
  payload?: any;
  accepts_response_payload?: boolean;
  retry_attempt?: number;
  retry_reason?: string;
  reason?: string;
}

/** What an app's socket client sees, with a way to answer each envelope. */
interface AppClient {
  ws: WebSocket;
  frames: Frame[];
  next(predicate: (f: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  ack(envelopeId: string, payload?: unknown): void;
  closed: Promise<number>;
}

function waitFor<T>(
  list: T[],
  listeners: ((item: T) => void)[],
  predicate: (item: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const hit = list.find(predicate);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => reject(new Error("wait timed out")), timeoutMs);
    listeners.push(function check(item) {
      if (!predicate(item)) return;
      clearTimeout(timer);
      listeners.splice(listeners.indexOf(check), 1);
      resolve(item);
    });
  });
}

/** Connects to `url` as an app would, resolving once the hello arrives. */
async function connectApp(url: string): Promise<AppClient> {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  const listeners: ((f: Frame) => void)[] = [];
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data)) as Frame;
    frames.push(frame);
    for (const listener of [...listeners]) listener(frame);
  });
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  const client: AppClient = {
    ws,
    frames,
    next: (predicate, timeoutMs = 3000) => waitFor(frames, listeners, predicate, timeoutMs),
    ack: (envelopeId, payload) =>
      ws.send(
        JSON.stringify(
          payload === undefined
            ? { envelope_id: envelopeId }
            : { envelope_id: envelopeId, payload },
        ),
      ),
    closed,
  };
  await client.next((f) => f.type === "hello");
  return client;
}

/** Opens a socket for an app with its app-level token. */
async function connectWith(appToken: string): Promise<AppClient> {
  const opened = await open(appToken);
  expect(opened.data.ok).toBe(true);
  return connectApp(opened.data.url!);
}

/** The HTTP status an upgrade was refused with, or "open" when it was let in. */
function upgradeOutcome(url: string): Promise<number | "open"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => {
      resolve("open");
      ws.terminate();
    });
    // A connection destroyed without an answer.
    ws.on("error", () => resolve(0));
  });
}

/** A member's socket on /ws, with what it is told. */
function connectMember(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const received: ServerToClient[] = [];
  const listeners: ((m: ServerToClient) => void)[] = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as ServerToClient;
    received.push(msg);
    for (const listener of [...listeners]) listener(msg);
  });
  ws.on("open", () =>
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    ),
  );
  return {
    ws,
    next: (predicate: (m: ServerToClient) => boolean, timeoutMs = 3000) =>
      waitFor(received, listeners, predicate, timeoutMs),
  };
}

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
    // One test opens more sockets from this address than a person would.
    rateLimits: false,
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
  channelId = server.store.channels.byName("general")!.id;
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

  it("are audited without a host, made or removed, for an app on Socket Mode", async () => {
    const app = await socketApp("Quiet Bot");
    const sub = await api<{ subscription: { id: string } }>(`/api/apps/${app.id}/subscriptions`, {
      token: aliceToken,
      body: { eventTypes: ["message.created"] },
    });
    await api(`/api/subscriptions/${sub.data.subscription.id}`, {
      token: aliceToken,
      method: "DELETE",
    });
    const details = server.store.audit
      .list({ limit: 50 })
      .filter((entry) => entry.targetId === sub.data.subscription.id)
      .map((entry) => entry.details);
    expect(details).toHaveLength(2);
    for (const entry of details) expect(entry).not.toHaveProperty("host");
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

describe("the one upgrade listener", () => {
  it("still connects a member on /ws, and still destroys an unknown path", async () => {
    const member = connectMember(bobToken);
    await member.next((m) => m.type === "ready");
    member.ws.close();
    expect(await upgradeOutcome(`ws://127.0.0.1:${server.port}/nowhere`)).toBe(0);
  });

  it("refuses an app-level token on /ws", async () => {
    const app = await socketApp("Wrong Door Bot");
    const member = connectMember(app.appToken);
    const refused = await member.next((m) => m.type === "error");
    expect(refused).toMatchObject({ type: "error", code: "auth_failed" });
  });
});

describe("the app socket", () => {
  it("says hello, with the app it is", async () => {
    const app = await socketApp("Hello Bot");
    const client = await connectWith(app.appToken);
    expect(client.frames[0]).toMatchObject({
      type: "hello",
      num_connections: 1,
      connection_info: { app_id: app.id },
    });
    client.ws.close();
  });

  it("refuses a bad ticket, a spent one, and a member's or bot's token in its place", async () => {
    const app = await socketApp("Ticket Bot");
    const socketUrl = `ws://127.0.0.1:${server.port}/apps/socket`;
    expect(await upgradeOutcome(`${socketUrl}?ticket=nonsense`)).toBe(401);
    expect(await upgradeOutcome(socketUrl)).toBe(401);
    expect(await upgradeOutcome(`${socketUrl}?ticket=${aliceToken}`)).toBe(401);
    expect(await upgradeOutcome(`${socketUrl}?ticket=${app.token}`)).toBe(401);
    expect(await upgradeOutcome(`${socketUrl}?ticket=${app.appToken}`)).toBe(401);

    const once = (await open(app.appToken)).data.url!;
    expect(await upgradeOutcome(once)).toBe("open");
    expect(await upgradeOutcome(once)).toBe(401);
  });

  it("refuses the eleventh socket of one app", async () => {
    const app = await socketApp("Crowded Bot");
    const clients = [];
    for (let i = 0; i < 10; i++) clients.push(await connectWith(app.appToken));
    const listed = await api<{ apps: { id: string; sockets: number }[] }>("/api/apps", {
      token: aliceToken,
    });
    expect(listed.data.apps.find((a) => a.id === app.id)!.sockets).toBe(10);
    const eleventh = (await open(app.appToken)).data.url!;
    expect(await upgradeOutcome(eleventh)).toBe(429);
    for (const client of clients) client.ws.close();
  });

  it("is closed, with Slack's link_disabled, when its token is revoked or replaced", async () => {
    const app = await socketApp("Revoked Bot");
    const first = await connectWith(app.appToken);
    await api(`/api/apps/${app.id}/app-token`, { method: "DELETE", token: aliceToken });
    expect(await first.next((f) => f.type === "disconnect")).toMatchObject({
      reason: "link_disabled",
    });
    await first.closed;

    const made = await api<{ token: string }>(`/api/apps/${app.id}/app-token`, {
      method: "POST",
      token: aliceToken,
    });
    const second = await connectWith(made.data.token);
    await api(`/api/apps/${app.id}/app-token`, { method: "POST", token: aliceToken });
    await second.closed;
    expect(second.frames.at(-1)).toMatchObject({ type: "disconnect", reason: "link_disabled" });
  });

  it("is closed when its app goes back to URLs or is deleted", async () => {
    const app = await socketApp("Leaving Bot");
    const client = await connectWith(app.appToken);
    await api(`/api/apps/${app.id}/receive`, {
      method: "PUT",
      token: aliceToken,
      body: { receive: "url" },
    });
    await client.closed;

    const gone = await socketApp("Deleted Bot");
    const other = await connectWith(gone.appToken);
    await api(`/api/apps/${gone.id}`, { method: "DELETE", token: aliceToken });
    await other.closed;
  });

  it("closes a socket that sends more than an app's answer may hold", async () => {
    const app = await socketApp("Chatty Bot");
    const client = await connectWith(app.appToken);
    client.ws.send("x".repeat(64 * 1024 + 1));
    expect(await client.closed).toBe(1009);
  });
});

describe("events over a socket", () => {
  /** A socket-mode app subscribed to messages, its bot in #general. */
  async function subscribedApp(name: string) {
    const app = await socketApp(name);
    const sub = await api<{ subscription: { id: string } }>(`/api/apps/${app.id}/subscriptions`, {
      token: aliceToken,
      body: { eventTypes: ["message.created"] },
    });
    expect(sub.status).toBe(201);
    server.store.channels.addMember(channelId, app.botUser.id);
    return { ...app, subscriptionId: sub.data.subscription.id };
  }

  const post = (text: string) =>
    api<{ message: Message }>(`/api/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { text },
    });

  const isEvent = (text: string) => (f: Frame) =>
    f.type === "events_api" && f.payload?.event?.text === text;

  const rawDb = () => (server.store as unknown as { db: { prepare: (s: string) => any } }).db;

  function queued(subscriptionId: string) {
    return rawDb()
      .prepare("SELECT attempts, last_error FROM event_deliveries WHERE subscription_id = ?")
      .all(subscriptionId) as { attempts: number; last_error: string | null }[];
  }

  function makeDue(subscriptionId: string) {
    rawDb()
      .prepare("UPDATE event_deliveries SET next_attempt_at = 0 WHERE subscription_id = ?")
      .run(subscriptionId);
  }

  /** Acknowledges everything the socket is sent, as Bolt does. */
  function acksAll(client: AppClient) {
    client.ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      if (frame.envelope_id) client.ack(frame.envelope_id);
    });
  }

  it("arrive in order, each in Slack's envelope, and are done once acknowledged", async () => {
    const app = await subscribedApp("Ordered Bot");
    const client = await connectWith(app.appToken);
    acksAll(client);
    await post("first");
    await post("second");
    await post("third");
    await client.next(isEvent("third"));
    const texts = client.frames
      .filter((f) => f.type === "events_api")
      .map((f) => f.payload.event.text as string);
    expect(texts).toEqual(["first", "second", "third"]);
    expect(client.frames.find(isEvent("first"))).toMatchObject({
      accepts_response_payload: false,
      retry_attempt: 0,
      retry_reason: "",
      payload: { type: "event_callback", event: { type: "message", text: "first" } },
    });
    await expect.poll(() => queued(app.subscriptionId)).toEqual([]);
    client.ws.close();
  });

  it("are sent again on the retry ladder when no socket acknowledges them", async () => {
    const app = await subscribedApp("Absent Bot");
    await post("while away");
    // No socket: a failed attempt, as for a URL that does not answer.
    await expect
      .poll(() => queued(app.subscriptionId))
      .toEqual([
        expect.objectContaining({
          attempts: 1,
          last_error: expect.stringContaining("not connected"),
        }),
      ]);

    const client = await connectWith(app.appToken);
    makeDue(app.subscriptionId);
    // Ends only once this delivery does, so it is waited on after the drop.
    const flushing = server.flushEventDeliveries();
    expect(await client.next(isEvent("while away"))).toMatchObject({
      retry_attempt: 1,
      retry_reason: "timeout",
    });
    // Dropped before acknowledging, as a bot that crashed: another failed
    // attempt, not a lost event.
    client.ws.terminate();
    await flushing;
    await expect
      .poll(() => queued(app.subscriptionId))
      .toEqual([
        expect.objectContaining({
          attempts: 2,
          last_error: expect.stringContaining("closed before it answered"),
        }),
      ]);

    const back = await connectWith(app.appToken);
    acksAll(back);
    makeDue(app.subscriptionId);
    await server.flushEventDeliveries();
    expect(await back.next(isEvent("while away"))).toMatchObject({ retry_attempt: 2 });
    await expect.poll(() => queued(app.subscriptionId)).toEqual([]);
    back.ws.close();
  });

  it("go to one socket each when an app has two", async () => {
    const app = await subscribedApp("Shared Bot");
    const one = await connectWith(app.appToken);
    const two = await connectWith(app.appToken);
    acksAll(one);
    acksAll(two);
    for (const text of ["a", "b", "c", "d"]) await post(text);
    const sent = () => [...one.frames, ...two.frames].filter((f) => f.type === "events_api");
    await expect.poll(() => sent().length).toBe(4);
    expect(new Set(sent().map((f) => f.envelope_id)).size).toBe(4);
    expect(one.frames.some((f) => f.type === "events_api")).toBe(true);
    expect(two.frames.some((f) => f.type === "events_api")).toBe(true);
    one.ws.close();
    two.ws.close();
  });
});

describe("commands and buttons over a socket", () => {
  async function commandApp(name: string, command: string) {
    const app = await socketApp(name);
    const made = await api(`/api/apps/${app.id}/commands`, {
      token: aliceToken,
      body: { command },
    });
    expect(made.status).toBe(201);
    return app;
  }

  const run = (text: string) =>
    api<{ ok: boolean; error?: string; message?: string }>(`/api/channels/${channelId}/commands`, {
      token: aliceToken,
      body: { text },
    });

  const ephemeralText = (text: string) => (m: ServerToClient) =>
    m.type === "ephemeral" && (m.event as { text?: string }).text === text;

  it("show an acknowledgement's payload as the command's reply", async () => {
    const app = await commandApp("Ping Bot", "ping");
    const client = await connectWith(app.appToken);
    client.ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      if (frame.type === "slash_commands")
        client.ack(frame.envelope_id!, { text: `pong ${frame.payload.text}` });
    });
    const alice = connectMember(aliceToken);
    await alice.next((m) => m.type === "ready");

    expect((await run("/ping now")).data.ok).toBe(true);
    const envelope = client.frames.find((f) => f.type === "slash_commands")!;
    expect(envelope).toMatchObject({
      accepts_response_payload: true,
      payload: { command: "/ping", text: "now", channel_id: channelId, api_app_id: app.id },
    });
    expect(envelope.payload.response_url).toMatch(/\/api\/commands\/response\//);
    await alice.next(ephemeralText("pong now"));
    alice.ws.close();
    client.ws.close();
  });

  it("fail with no socket connected the way a command whose URL is dead does", async () => {
    await commandApp("Asleep Bot", "asleep");
    const alice = connectMember(aliceToken);
    await alice.next((m) => m.type === "ready");
    const answered = await run("/asleep");
    expect(answered.data).toEqual({
      ok: false,
      error: "command_failed",
      message: "the app did not answer",
    });
    await alice.next(ephemeralText("`/asleep` failed: the app did not answer."));
    alice.ws.close();
  });

  it("send a button press over the socket, and show what the app answers", async () => {
    const app = await socketApp("Button Bot");
    server.store.channels.addMember(channelId, app.botUser.id);
    const posted = await api<{ ts: string }>("/api/chat.postMessage", {
      token: app.token,
      body: {
        channel: channelId,
        text: "Deploy?",
        blocks: [
          {
            type: "actions",
            block_id: "deploy",
            elements: [
              {
                type: "button",
                action_id: "go",
                text: { type: "plain_text", text: "Go" },
                value: "v1",
              },
            ],
          },
        ],
      },
    });
    const client = await connectWith(app.appToken);
    client.ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      if (frame.type === "interactive")
        client.ack(frame.envelope_id!, { text: `pressed ${frame.payload.actions[0].value}` });
    });
    const alice = connectMember(aliceToken);
    await alice.next((m) => m.type === "ready");

    const pressed = await api<{ ok: boolean }>(`/api/messages/${posted.data.ts}/actions`, {
      token: aliceToken,
      body: { actionId: "go" },
    });
    expect(pressed.data.ok).toBe(true);
    expect(client.frames.find((f) => f.type === "interactive")).toMatchObject({
      accepts_response_payload: true,
      payload: { type: "block_actions", actions: [{ action_id: "go", value: "v1" }] },
    });
    await alice.next(ephemeralText("pressed v1"));
    alice.ws.close();
    client.ws.close();
  });
});
