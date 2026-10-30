import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  escapeMrkdwn,
  type Message,
  type EventSubscription,
  type ServerToClient,
  type User,
} from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";
import { isPrivateAddress } from "../src/outbound.js";

/** One request the stub app received, unpacked for assertions. */
interface Received {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Stands in for the third-party app a command or subscription points at. */
class StubApp {
  server: Server;
  port = 0;
  received: Received[] = [];
  /** Answers the next request; set per test. */
  handler: (req: Received) => { status?: number; body: string; contentType?: string } = () => ({
    body: "",
  });

  constructor() {
    this.server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const entry: Received = {
          url: req.url ?? "",
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, String(v ?? "")]),
          ),
          body: Buffer.concat(chunks).toString("utf8"),
        };
        this.received.push(entry);
        const out = this.handler(entry);
        res.writeHead(out.status ?? 200, {
          "content-type": out.contentType ?? "application/json",
        });
        res.end(out.body);
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
  }

  url(path = "/"): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

let server: WorkspaceServer;
let base: string;
let dataDir: string;
let stub: StubApp;
let aliceToken: string;
let alice: User;
let bobToken: string;
let bob: User;
let channelId: string;

async function api<T>(
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

function connectWs(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const received: ServerToClient[] = [];
  const waiters: ((msg: ServerToClient) => void)[] = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as ServerToClient;
    received.push(msg);
    waiters.splice(0).forEach((w) => w(msg));
  });
  ws.on("open", () => {
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    );
  });
  const next = (predicate: (m: ServerToClient) => boolean, timeoutMs = 3000) =>
    new Promise<ServerToClient>((resolve, reject) => {
      const hit = received.find(predicate);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error("ws wait timeout")), timeoutMs);
      const check = (m: ServerToClient) => {
        if (predicate(m)) {
          clearTimeout(timer);
          resolve(m);
        } else {
          waiters.push(check);
        }
      };
      waiters.push(check);
    });
  return { ws, received, next };
}

/** Waits for something the server does asynchronously, without a fixed sleep. */
async function eventually(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition never became true");
}

async function newApp(
  name: string,
): Promise<{ id: string; botUser: User; signingSecret: string; token: string }> {
  const { data } = await api<{
    app: { id: string };
    botUser: User;
    signingSecret: string;
    token: string;
  }>("/api/apps", { token: aliceToken, body: { name } });
  return {
    id: data.app.id,
    botUser: data.botUser,
    signingSecret: data.signingSecret,
    token: data.token,
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-integrations-"));
  stub = new StubApp();
  await stub.start();
  server = await createWorkspaceServer({
    dataDir,
    port: 0,
    workspaceName: "Integration Test",
    mdns: false,
    // The stub app lives on loopback, which the SSRF guard blocks by default —
    // exactly what a LAN-hosted bot looks like, so this is the flag a real
    // self-hoster would set. The guard itself is covered separately below.
    allowPrivateHooks: true,
    logger: false,
  });
  base = `http://127.0.0.1:${server.port}`;

  const a = await api<{ token: string; user: User }>("/api/auth/register", {
    body: { handle: "alice", displayName: "Alice", password: "password123" },
  });
  aliceToken = a.data.token;
  alice = a.data.user;
  const b = await api<{ token: string; user: User }>("/api/auth/register", {
    body: { handle: "bob", displayName: "Bob", password: "password123" },
  });
  bobToken = b.data.token;
  bob = b.data.user;
  channelId = server.store.getChannelByName("general")!.id;
  server.store.addMember(channelId, bob.id);
});

afterAll(async () => {
  await server.stop();
  await stub.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the SSRF guard", () => {
  it("recognises the address ranges an integration URL must not reach", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.169.254", // cloud metadata
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1", // the same loopback wearing an IPv6 hat
      "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "192.169.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("refuses a private endpoint unless the host opted in", async () => {
    const guardedDir = mkdtempSync(join(tmpdir(), "ownbase-guarded-"));
    const guarded = await createWorkspaceServer({
      dataDir: guardedDir,
      port: 0,
      mdns: false,
      logger: false,
    });
    const guardedBase = `http://127.0.0.1:${guarded.port}`;
    const reg = await fetch(`${guardedBase}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
    });
    const { token } = (await reg.json()) as { token: string };
    const created = await fetch(`${guardedBase}/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Local Bot" }),
    });
    const { app } = (await created.json()) as { app: { id: string } };

    const res = await fetch(`${guardedBase}/api/apps/${app.id}/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: stub.url("/events") }),
    });
    const body = (await res.json()) as { error: string; message: string };
    expect(res.status).toBe(400);
    expect(body.error).toBe("blocked_host");
    expect(body.message).toContain("allow-private-hooks");

    await guarded.stop();
    rmSync(guardedDir, { recursive: true, force: true });
  });

  it("rejects a URL that is not http(s), or that carries credentials", async () => {
    const created = await newApp("Scheme Bot");
    for (const url of ["file:///etc/passwd", "http://user:pass@example.com/hook"]) {
      const res = await api(`/api/apps/${created.id}/commands`, {
        token: aliceToken,
        body: { command: "nope", url },
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("slash commands", () => {
  it("answers built-ins without any app installed", async () => {
    const res = await api<{ ok: boolean }>(`/api/channels/${channelId}/commands`, {
      token: aliceToken,
      body: { text: "/shrug well then" },
    });
    expect(res.status).toBe(200);
    const messages = server.store.listMessages({ channelId, limit: 1 });
    // Stored pre-escaped for the renderer; the UI test pins how it displays.
    // Stored escaped for the renderer; the ui package pins how that displays.
    expect(messages[0]!.text).toBe(`well then ${escapeMrkdwn("¯\\_(ツ)_/¯")}`);
    expect(messages[0]!.userId).toBe(alice.id);
  });

  it("tells you when a command does not exist", async () => {
    const res = await api<{ error: string }>(`/api/channels/${channelId}/commands`, {
      token: aliceToken,
      body: { text: "/definitely-not-real" },
    });
    expect(res.status).toBe(404);
    expect(res.data.error).toBe("unknown_command");
  });

  it("sends Slack's form payload and shows the reply privately", async () => {
    const created = await newApp("Deploy Bot");
    const made = await api(`/api/apps/${created.id}/commands`, {
      token: aliceToken,
      body: { command: "/deploy", url: stub.url("/deploy"), description: "Ship it" },
    });
    expect(made.status).toBe(201);

    stub.received.length = 0;
    stub.handler = () => ({ body: JSON.stringify({ text: "deploying *staging*" }) });

    const a = connectWs(aliceToken);
    const b = connectWs(bobToken);
    await a.next((m) => m.type === "ready");
    await b.next((m) => m.type === "ready");

    const res = await api<{ ok: boolean }>(`/api/channels/${channelId}/commands`, {
      token: aliceToken,
      body: { text: "/deploy staging now" },
    });
    expect(res.data.ok).toBe(true);

    const sent = stub.received[0]!;
    expect(sent.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(sent.body);
    expect(form.get("command")).toBe("/deploy");
    expect(form.get("text")).toBe("staging now");
    expect(form.get("channel_id")).toBe(channelId);
    expect(form.get("channel_name")).toBe("general");
    expect(form.get("user_id")).toBe(alice.id);
    expect(form.get("user_name")).toBe("alice");
    expect(form.get("response_url")).toContain("/api/commands/response/");

    // Signed the way Slack signs, under both header names.
    const ts = sent.headers["x-slack-request-timestamp"]!;
    const expected = `v0=${createHmac("sha256", created.signingSecret)
      .update(`v0:${ts}:${sent.body}`)
      .digest("hex")}`;
    expect(sent.headers["x-slack-signature"]).toBe(expected);
    expect(sent.headers["x-ownbase-signature"]).toBe(expected);

    const ephemeral = (await a.next(
      (m) => m.type === "ephemeral" && m.event.type === "ephemeral.message",
    )) as { type: "ephemeral"; event: { type: "ephemeral.message"; text: string; userId: string } };
    expect(ephemeral.event.text).toBe("deploying *staging*");
    expect(ephemeral.event.userId).toBe(created.botUser.id);

    // Private means private: it is not in the channel, and Bob never saw it.
    expect(
      server.store.listMessages({ channelId, limit: 5 }).some((m) => m.text.includes("deploying")),
    ).toBe(false);
    expect(
      b.received.some((m) => m.type === "ephemeral" && m.event.type === "ephemeral.message"),
    ).toBe(false);

    a.ws.close();
    b.ws.close();
  });

  it("posts to the whole channel when the app says in_channel", async () => {
    stub.handler = () => ({
      body: JSON.stringify({ response_type: "in_channel", text: "build 412 is green" }),
    });
    await api(`/api/channels/${channelId}/commands`, {
      token: aliceToken,
      body: { text: "/deploy prod" },
    });
    const latest = server.store.listMessages({ channelId, limit: 1 })[0]!;
    expect(latest.text).toBe("build 412 is green");
    expect(server.store.getUser(latest.userId)!.isBot).toBe(true);
  });

  it("accepts a late reply on the response_url, then stops accepting them", async () => {
    let responseUrl = "";
    stub.handler = (req) => {
      responseUrl = new URLSearchParams(req.body).get("response_url") ?? "";
      return { body: "" }; // acknowledged silently, answer to follow
    };
    await api(`/api/channels/${channelId}/commands`, {
      token: aliceToken,
      body: { text: "/deploy later" },
    });
    expect(responseUrl).toContain("/api/commands/response/");

    const post = (text: string) =>
      fetch(responseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response_type: "in_channel", text }),
      });

    expect((await post("done, took 61s")).status).toBe(200);
    await eventually(
      () => server.store.listMessages({ channelId, limit: 1 })[0]!.text === "done, took 61s",
    );

    // Slack allows five; the sixth is gone.
    for (let i = 0; i < 4; i++) await post(`extra ${i}`);
    expect((await post("too late")).status).toBe(404);
  });

  it("reports a failing endpoint to the person who typed the command", async () => {
    stub.handler = () => ({ status: 500, body: "boom" });
    const a = connectWs(aliceToken);
    await a.next((m) => m.type === "ready");

    const res = await api<{ ok: boolean; error: string; message: string }>(
      `/api/channels/${channelId}/commands`,
      { token: aliceToken, body: { text: "/deploy broken" } },
    );
    expect(res.data.error).toBe("command_failed");
    // The answer says why too, for a test run from Apps and integrations.
    expect(res.data.message).toBe("the app answered 500");

    const note = (await a.next(
      (m) => m.type === "ephemeral" && m.event.type === "ephemeral.message",
    )) as { type: "ephemeral"; event: { text: string } };
    expect(note.event.text).toContain("500");
    a.ws.close();
  });

  it("says in its answer when the app could not be reached", async () => {
    const created = await newApp("Gone Bot");
    // A port that was free a moment ago: nothing answers there.
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    await api(`/api/apps/${created.id}/commands`, {
      token: aliceToken,
      body: { command: "/gone", url: `http://127.0.0.1:${port}/gone` },
    });

    const res = await api<{ ok: boolean; error: string; message: string }>(
      `/api/channels/${channelId}/commands`,
      { token: aliceToken, body: { text: "/gone test" } },
    );
    expect(res.data).toEqual({
      ok: false,
      error: "command_failed",
      message: "the app did not answer",
    });
  });

  it("refuses to register a command name twice, or over a built-in", async () => {
    const other = await newApp("Rival Bot");
    const clash = await api<{ error: string }>(`/api/apps/${other.id}/commands`, {
      token: aliceToken,
      body: { command: "deploy", url: stub.url("/x") },
    });
    expect(clash.status).toBe(409);
    const builtin = await api<{ error: string }>(`/api/apps/${other.id}/commands`, {
      token: aliceToken,
      body: { command: "/shrug", url: stub.url("/x") },
    });
    expect(builtin.status).toBe(409);
  });

  it("keeps command management to admins", async () => {
    const created = await newApp("Members Cannot");
    const denied = await api(`/api/apps/${created.id}/commands`, {
      token: bobToken,
      body: { command: "nope", url: stub.url("/x") },
    });
    expect(denied.status).toBe(403);
  });
});

describe("outgoing event subscriptions", () => {
  it("does not create a subscription after the verifying admin loses that role", async () => {
    const created = await newApp("Demoted Subscription Admin");
    server.store.updateUser(bob.id, { role: "admin" });
    stub.handler = (req) => {
      if (req.url === "/demoted-subscription") server.store.updateUser(bob.id, { role: "member" });
      return {
        body: JSON.stringify({
          challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
        }),
      };
    };

    try {
      const result = await api<{ error: string }>(`/api/apps/${created.id}/subscriptions`, {
        token: bobToken,
        body: { url: stub.url("/demoted-subscription") },
      });
      expect(result.status).toBe(403);
      expect(result.data.error).toBe("admin_only");
      expect(server.store.listSubscriptions(created.id)).toEqual([]);
    } finally {
      server.store.updateUser(bob.id, { role: "member" });
    }
  });

  it("does not create a subscription for an app deleted during verification", async () => {
    const created = await newApp("Deleted Subscription App");
    stub.handler = (req) => {
      if (req.url === "/deleted-subscription") server.store.deleteApp(created.id);
      return {
        body: JSON.stringify({
          challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
        }),
      };
    };

    const result = await api<{ error: string }>(`/api/apps/${created.id}/subscriptions`, {
      token: aliceToken,
      body: { url: stub.url("/deleted-subscription") },
    });
    expect(result.status).toBe(404);
    expect(result.data.error).toBe("not_found");
    expect(server.store.listSubscriptions(created.id)).toEqual([]);
  });

  it("requires the url_verification handshake before subscribing", async () => {
    const created = await newApp("Events Bot");

    stub.handler = () => ({ body: JSON.stringify({ challenge: "wrong" }) });
    const refused = await api<{ error: string }>(`/api/apps/${created.id}/subscriptions`, {
      token: aliceToken,
      body: { url: stub.url("/events") },
    });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toBe("challenge_failed");

    stub.handler = (req) => ({
      body: JSON.stringify({
        challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
      }),
    });
    const accepted = await api(`/api/apps/${created.id}/subscriptions`, {
      token: aliceToken,
      body: { url: stub.url("/events"), eventTypes: ["message.created"] },
    });
    expect(accepted.status).toBe(201);
  });

  it("delivers signed events for channels the bot is in, and never its own", async () => {
    const created = await newApp("Echo Bot");
    stub.handler = (req) => ({
      body: JSON.stringify({
        challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
      }),
    });
    const sub = await api<{ subscription: { id: string } }>(
      `/api/apps/${created.id}/subscriptions`,
      { token: aliceToken, body: { url: stub.url("/echo"), eventTypes: ["message.created"] } },
    );
    expect(sub.status).toBe(201);
    stub.handler = () => ({ body: "" });

    // Not a member yet: the app must not learn about the channel's traffic.
    stub.received.length = 0;
    await api(`/api/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { text: "before the bot joined" },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(stub.received.filter((r) => r.url === "/echo")).toHaveLength(0);

    server.store.addMember(channelId, created.botUser.id);
    stub.received.length = 0;
    await api(`/api/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { text: "hello robot" },
    });
    await eventually(() => stub.received.some((r) => r.url === "/echo"));

    const delivered = stub.received.find((r) => r.url === "/echo")!;
    const payload = JSON.parse(delivered.body) as {
      type: string;
      event: { type: string; text: string; channel: string; user: string; ts: string };
      ownbase: { type: string; seq: number };
    };
    expect(payload.type).toBe("event_callback");
    expect(payload.event.type).toBe("message");
    expect(payload.event.text).toBe("hello robot");
    expect(payload.event.channel).toBe(channelId);
    expect(payload.event.user).toBe(alice.id);
    expect(payload.ownbase.type).toBe("message.created");

    const ts = delivered.headers["x-ownbase-request-timestamp"]!;
    expect(delivered.headers["x-ownbase-signature"]).toBe(
      `v0=${createHmac("sha256", created.signingSecret).update(`v0:${ts}:${delivered.body}`).digest("hex")}`,
    );

    // The bot's own message must not come straight back to it — that is the
    // loop every chat integration eventually causes.
    stub.received.length = 0;
    const own = await api<{ ok: boolean }>("/api/chat.postMessage", {
      token: created.token,
      body: { channel: channelId, text: "I am the bot" },
    });
    expect(own.data.ok).toBe(true);
    // Then a message from a person, which must still arrive — proving the
    // silence above is the loop guard and not a broken subscription.
    await api(`/api/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { text: "and I am not" },
    });
    await eventually(() => stub.received.some((r) => r.body.includes("and I am not")));
    expect(stub.received.some((r) => r.body.includes("I am the bot"))).toBe(false);
  });

  it("only sends the event types a subscription asked for", async () => {
    const created = await newApp("Reactions Only");
    stub.handler = (req) => ({
      body: JSON.stringify({
        challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
      }),
    });
    await api(`/api/apps/${created.id}/subscriptions`, {
      token: aliceToken,
      body: { url: stub.url("/reactions"), eventTypes: ["reaction.added"] },
    });
    stub.handler = () => ({ body: "" });
    server.store.addMember(channelId, created.botUser.id);

    stub.received.length = 0;
    const posted = await api<{ message: { id: string } }>(`/api/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { text: "react to me" },
    });
    await fetch(
      `${base}/api/messages/${posted.data.message.id}/reactions/${encodeURIComponent("🎉")}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${aliceToken}` },
      },
    );
    await eventually(() => stub.received.some((r) => r.url === "/reactions"));

    const bodies = stub.received.filter((r) => r.url === "/reactions").map((r) => r.body);
    expect(bodies.every((b) => !b.includes("react to me"))).toBe(true);
    const event = JSON.parse(bodies[0]!) as { event: { type: string; reaction: string } };
    expect(event.event.type).toBe("reaction_added");
    expect(event.event.reaction).toBe("🎉");
  });

  it("stops delivering once the app is deleted", async () => {
    const created = await newApp("Short Lived");
    stub.handler = (req) => ({
      body: JSON.stringify({
        challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
      }),
    });
    await api(`/api/apps/${created.id}/subscriptions`, {
      token: aliceToken,
      body: { url: stub.url("/gone") },
    });
    stub.handler = () => ({ body: "" });
    server.store.addMember(channelId, created.botUser.id);

    await api(`/api/apps/${created.id}`, { token: aliceToken, method: "DELETE" });
    stub.received.length = 0;
    await api(`/api/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { text: "after deletion" },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(stub.received.filter((r) => r.url === "/gone")).toHaveLength(0);
  });
});

describe("durable event delivery", () => {
  interface Row {
    event_seq: number;
    attempts: number;
    failed_at: number | null;
  }

  /** The workspace database, for arranging queue state a test cannot wait for. */
  function rawDb() {
    return (
      server.store as unknown as {
        db: {
          prepare: (sql: string) => {
            run: (...a: unknown[]) => { changes: number };
            all: (...a: unknown[]) => unknown[];
          };
        };
      }
    ).db;
  }

  /** Brings every waiting attempt forward, standing in for hours of delay. */
  function makeDue(subscriptionId: string) {
    rawDb()
      .prepare("UPDATE event_deliveries SET next_attempt_at = 0 WHERE subscription_id = ?")
      .run(subscriptionId);
  }

  function queued(subscriptionId: string): Row[] {
    return rawDb()
      .prepare(
        `SELECT event_seq, attempts, failed_at FROM event_deliveries
         WHERE subscription_id = ? ORDER BY event_seq`,
      )
      .all(subscriptionId) as Row[];
  }

  function bodiesAt(path: string): { text?: string }[] {
    return stub.received
      .filter((r) => r.url === path)
      .map((r) => (JSON.parse(r.body) as { event: { text?: string } }).event);
  }

  /** An app subscribed to `path` whose bot is already in the channel. */
  async function subscribed(name: string, path: string) {
    const created = await newApp(name);
    stub.handler = (req) => ({
      body: JSON.stringify({
        challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
      }),
    });
    const sub = await api<{ subscription: { id: string } }>(
      `/api/apps/${created.id}/subscriptions`,
      { token: aliceToken, body: { url: stub.url(path), eventTypes: ["message.created"] } },
    );
    expect(sub.status).toBe(201);
    server.store.addMember(channelId, created.botUser.id);
    return { ...created, subscriptionId: sub.data.subscription.id };
  }

  /** Fails only the endpoint under test, so other subscriptions stay healthy. */
  function failOnly(path: string, status = 503) {
    stub.handler = (req) => (req.url === path ? { status, body: "" } : { body: "" });
  }

  async function post(text: string) {
    await api(`/api/channels/${channelId}/messages`, { token: aliceToken, body: { text } });
  }

  async function health(appId: string, subscriptionId: string) {
    const { data } = await api<{
      apps: {
        id: string;
        subscriptions: { id: string; delivery?: EventSubscription["delivery"] }[];
      }[];
    }>("/api/apps", { token: aliceToken });
    const sub = data.apps
      .find((a) => a.id === appId)!
      .subscriptions.find((x) => x.id === subscriptionId)!;
    return sub.delivery!;
  }

  it("retries a refused delivery without letting later events overtake it", async () => {
    const bot = await subscribed("Flaky Bot", "/flaky");
    failOnly("/flaky");
    stub.received.length = 0;

    await post("flaky one");
    await post("flaky two");
    await eventually(() => queued(bot.subscriptionId).length === 2);
    await server.flushEventDeliveries();

    // Only the oldest is ever in flight. The second waits behind it, so a
    // receiver is never shown events out of the order they happened in.
    const waiting = queued(bot.subscriptionId);
    expect(waiting).toHaveLength(2);
    expect(waiting[0]!.attempts).toBeGreaterThan(0);
    expect(waiting[1]!.attempts).toBe(0);
    expect(bodiesAt("/flaky").every((e) => e.text === "flaky one")).toBe(true);

    // A second attempt, still refused, so there is a retry to inspect. It says
    // it is one in the header Slack apps already look for.
    makeDue(bot.subscriptionId);
    await server.flushEventDeliveries();
    const retried = stub.received.filter(
      (r) => r.url === "/flaky" && r.headers["x-slack-retry-num"],
    );
    expect(retried.length).toBeGreaterThan(0);
    expect(retried[0]!.headers["x-slack-retry-reason"]).toBe("http_error");

    stub.handler = () => ({ body: "" });
    for (let i = 0; i < 3 && queued(bot.subscriptionId).length > 0; i++) {
      makeDue(bot.subscriptionId);
      await server.flushEventDeliveries();
    }
    expect(queued(bot.subscriptionId)).toHaveLength(0);
    const arrived = bodiesAt("/flaky").map((e) => e.text);
    expect(arrived.indexOf("flaky two")).toBeGreaterThan(arrived.indexOf("flaky one"));
    await api(`/api/apps/${bot.id}`, { token: aliceToken, method: "DELETE" });
  });

  it("signs every attempt afresh over a body that never changes", async () => {
    const bot = await subscribed("Resigning Bot", "/resign");
    failOnly("/resign");
    stub.received.length = 0;
    await post("sign me");
    const tries = () => stub.received.filter((r) => r.url === "/resign");
    await eventually(() => tries().length >= 1);
    // Looping rather than flushing once: a flush already running is joined
    // rather than restarted, so a single call is not guaranteed to be the one
    // that makes the next attempt.
    for (let i = 0; i < 10 && tries().length < 2; i++) {
      makeDue(bot.subscriptionId);
      await server.flushEventDeliveries();
    }

    const attempts = tries();
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    // One event, however many attempts it takes — which is what lets a receiver
    // that already handled it recognise the repeat.
    const ids = attempts.map((r) => (JSON.parse(r.body) as { event_id: string }).event_id);
    expect(new Set(ids).size).toBe(1);
    expect(new Set(attempts.map((r) => r.body)).size).toBe(1);
    for (const attempt of attempts) {
      const ts = attempt.headers["x-ownbase-request-timestamp"]!;
      expect(attempt.headers["x-ownbase-signature"]).toBe(
        `v0=${createHmac("sha256", bot.signingSecret).update(`v0:${ts}:${attempt.body}`).digest("hex")}`,
      );
    }
    await api(`/api/apps/${bot.id}`, { token: aliceToken, method: "DELETE" });
  });

  it("gives up on an endpoint that never answers, and on its backlog with it", async () => {
    const bot = await subscribed("Dead Bot", "/dead");
    failOnly("/dead", 500);
    stub.received.length = 0;

    await post("dead one");
    await post("dead two");
    await post("dead three");
    await eventually(() => queued(bot.subscriptionId).length === 3);

    for (let i = 0; i < 20 && queued(bot.subscriptionId).some((r) => r.failed_at === null); i++) {
      makeDue(bot.subscriptionId);
      await server.flushEventDeliveries();
    }

    const abandoned = queued(bot.subscriptionId);
    expect(abandoned).toHaveLength(3);
    expect(abandoned.every((r) => r.failed_at !== null)).toBe(true);
    // The two behind it were never tried. An endpoint that has used up a whole
    // ladder of attempts is down, and repeating that ladder per event would
    // keep a dead receiver under load for days while its queue only grew.
    expect(abandoned[0]!.attempts).toBeGreaterThanOrEqual(8);
    expect(abandoned[1]!.attempts).toBe(0);
    expect(abandoned[2]!.attempts).toBe(0);

    const stopped = await health(bot.id, bot.subscriptionId);
    expect(stopped.pending).toBe(0);
    expect(stopped.failed).toBe(3);
    expect(stopped.lastError).toContain("500");

    // Repairing the endpoint and retrying replays them, still in order.
    stub.handler = () => ({ body: "" });
    stub.received.length = 0;
    const retry = await api<{ retried: number }>(`/api/subscriptions/${bot.subscriptionId}/retry`, {
      method: "POST",
      token: aliceToken,
    });
    expect(retry.data.retried).toBe(3);
    await eventually(() => queued(bot.subscriptionId).length === 0, 5000);
    expect(bodiesAt("/dead").map((e) => e.text)).toEqual(["dead one", "dead two", "dead three"]);
    await api(`/api/apps/${bot.id}`, { token: aliceToken, method: "DELETE" });
  });

  it("keeps retrying to admins, and refuses a subscription that is gone", async () => {
    const bot = await subscribed("Guarded Bot", "/guarded");
    const refused = await api(`/api/subscriptions/${bot.subscriptionId}/retry`, {
      method: "POST",
      token: bobToken,
    });
    expect(refused.status).toBe(403);
    const missing = await api("/api/subscriptions/01MISSINGMISSINGMISSINGMISS/retry", {
      method: "POST",
      token: aliceToken,
    });
    expect(missing.status).toBe(404);
    await api(`/api/apps/${bot.id}`, { token: aliceToken, method: "DELETE" });
  });

  it("stops queueing for an endpoint too far behind, and reports what it dropped", async () => {
    const bot = await subscribed("Backlogged Bot", "/backlog");
    failOnly("/backlog", 500);

    // Filling the queue directly: five hundred real messages would prove the
    // same thing, only slower.
    const cap = 500;
    server.store.transaction(() => {
      for (let i = 0; i < cap; i++) {
        expect(
          server.store.enqueueEventDelivery(bot.subscriptionId, channelId, 900_000 + i, "{}"),
        ).toBe(true);
      }
    });
    expect(server.store.enqueueEventDelivery(bot.subscriptionId, channelId, 999_999, "{}")).toBe(
      false,
    );
    expect(queued(bot.subscriptionId)).toHaveLength(cap);
    expect((await health(bot.id, bot.subscriptionId)).dropped).toBe(1);

    // Once it is answering again the tally stops being current news, so an
    // endpoint that recovers on its own does not carry a warning for ever.
    rawDb()
      .prepare("DELETE FROM event_deliveries WHERE subscription_id = ?")
      .run(bot.subscriptionId);
    stub.handler = () => ({ body: "" });
    stub.received.length = 0;
    await post("backlog cleared");
    await eventually(() => queued(bot.subscriptionId).length === 0 && stub.received.length > 0);
    expect((await health(bot.id, bot.subscriptionId)).dropped).toBe(0);
    await api(`/api/apps/${bot.id}`, { token: aliceToken, method: "DELETE" });
  });

  it("discards queued events for a channel the bot has been removed from", async () => {
    const bot = await subscribed("Evicted Bot", "/evicted");
    failOnly("/evicted", 500);
    stub.received.length = 0;
    await post("said while a member");
    // Waiting for the refusal to be recorded, not merely for the row to exist,
    // so no attempt is still in flight when membership ends.
    await eventually(() => queued(bot.subscriptionId).some((r) => r.attempts > 0));

    server.store.removeMember(channelId, bot.botUser.id);
    // Emptied when membership ends rather than paused, so being added back
    // cannot replay what was said while the bot was out.
    expect(queued(bot.subscriptionId)).toHaveLength(0);

    // Refused attempts also land on the stub, so only what arrives from here on
    // could be a replay.
    stub.received.length = 0;
    stub.handler = () => ({ body: "" });
    server.store.addMember(channelId, bot.botUser.id);
    await server.flushEventDeliveries();
    expect(bodiesAt("/evicted")).toHaveLength(0);
    await api(`/api/apps/${bot.id}`, { token: aliceToken, method: "DELETE" });
  });

  describe("what an edit or a deletion takes out of events still waiting", () => {
    /** Every queued or given-up body for a subscription, as stored. */
    function storedBodies(subscriptionId: string): string {
      return JSON.stringify(
        rawDb()
          .prepare("SELECT body FROM event_deliveries WHERE subscription_id = ? ORDER BY event_seq")
          .all(subscriptionId),
      );
    }

    /** A bot told about new, edited and deleted messages, whose endpoint is down. */
    async function waitingBot(name: string, path: string) {
      const created = await newApp(name);
      stub.handler = (req) => ({
        body: JSON.stringify({
          challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
        }),
      });
      const sub = await api<{ subscription: { id: string } }>(
        `/api/apps/${created.id}/subscriptions`,
        {
          token: aliceToken,
          body: {
            url: stub.url(path),
            eventTypes: ["message.created", "message.updated", "message.deleted"],
          },
        },
      );
      expect(sub.status).toBe(201);
      server.store.addMember(channelId, created.botUser.id);
      failOnly(path);
      return { ...created, subscriptionId: sub.data.subscription.id };
    }

    async function posted(text: string) {
      const { data } = await api<{ message: { id: string } }>(
        `/api/channels/${channelId}/messages`,
        { token: aliceToken, body: { text } },
      );
      return data.message.id;
    }

    it("takes the first draft out of the queue when a message is edited", async () => {
      const bot = await waitingBot("Queue Editor", "/queue-edit");
      const id = await posted("the-first-draft-i-regret");
      await eventually(() => queued(bot.subscriptionId).length === 1);
      expect(storedBodies(bot.subscriptionId)).toContain("the-first-draft-i-regret");

      const edited = await api(`/api/messages/${id}`, {
        token: aliceToken,
        method: "PATCH",
        body: { text: "what I meant to say" },
      });
      expect(edited.status).toBe(200);
      await eventually(() => queued(bot.subscriptionId).length === 2);
      // It used to stay here, in a body waiting to leave for an app, long after
      // the event log had let go of it.
      expect(storedBodies(bot.subscriptionId)).not.toContain("the-first-draft-i-regret");
      expect(storedBodies(bot.subscriptionId)).toContain("what I meant to say");

      // Once the app answers, it is told in order: the message, without the
      // words it no longer has, then its edit. (Attempts refused before the
      // edit had already left; those are the app's, and are not counted here.)
      stub.handler = () => ({ body: "" });
      stub.received.length = 0;
      for (let i = 0; i < 4 && queued(bot.subscriptionId).length > 0; i++) {
        makeDue(bot.subscriptionId);
        await server.flushEventDeliveries();
      }
      const delivered = stub.received
        .filter((r) => r.url === "/queue-edit")
        .map((r) => JSON.parse(r.body) as { ownbase: { type: string }; event: any });
      expect(delivered.map((b) => b.ownbase.type)).toEqual(["message.created", "message.updated"]);
      expect(delivered[0]!.event.text).toBe("");
      expect(delivered[1]!.event.message.text).toBe("what I meant to say");
      await api(`/api/apps/${bot.id}`, { token: aliceToken, method: "DELETE" });
    });

    it("takes a deleted message's words out of the queue, and keeps the deletion", async () => {
      const bot = await waitingBot("Queue Deleter", "/queue-delete");
      const id = await posted("a-number-nobody-should-keep");
      await eventually(() => queued(bot.subscriptionId).length === 1);

      expect(
        (await api(`/api/messages/${id}`, { token: aliceToken, method: "DELETE" })).status,
      ).toBe(200);
      await eventually(() => queued(bot.subscriptionId).length === 2);
      const bodies = storedBodies(bot.subscriptionId);
      expect(bodies).not.toContain("a-number-nobody-should-keep");
      expect(bodies).toContain("message_deleted");
      await api(`/api/apps/${bot.id}`, { token: aliceToken, method: "DELETE" });
    });

    it("takes it out of an event that has given up too", async () => {
      const bot = await waitingBot("Queue Quitter", "/queue-quit");
      const id = await posted("words-in-a-failed-delivery");
      await eventually(() => queued(bot.subscriptionId).length === 1);
      rawDb()
        .prepare("UPDATE event_deliveries SET failed_at = 1 WHERE subscription_id = ?")
        .run(bot.subscriptionId);

      await api(`/api/messages/${id}`, { token: aliceToken, method: "DELETE" });
      expect(storedBodies(bot.subscriptionId)).not.toContain("words-in-a-failed-delivery");
      await api(`/api/apps/${bot.id}`, { token: aliceToken, method: "DELETE" });
    });
  });

  it("resumes an unfinished delivery after a restart", async () => {
    const restartDir = mkdtempSync(join(tmpdir(), "ownbase-delivery-restart-"));
    let current = await createWorkspaceServer({
      dataDir: restartDir,
      port: 0,
      mdns: false,
      allowPrivateHooks: true,
      logger: false,
    });
    try {
      const reg = await fetch(`http://127.0.0.1:${current.port}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "root", displayName: "Root", password: "password123" }),
      });
      const admin = ((await reg.json()) as { token: string }).token;
      const call = async <T>(path: string, body?: unknown): Promise<T> => {
        const res = await fetch(`http://127.0.0.1:${current.port}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${admin}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return (await res.json()) as T;
      };
      const made = await call<{ app: { id: string }; botUser: User }>("/api/apps", {
        name: "Restart Bot",
      });
      stub.handler = (req) => ({
        body: JSON.stringify({
          challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
        }),
      });
      await call(`/api/apps/${made.app.id}/subscriptions`, {
        url: stub.url("/restart"),
        eventTypes: ["message.created"],
      });
      const room = current.store.getChannelByName("general")!.id;
      current.store.addMember(room, made.botUser.id);

      failOnly("/restart", 500);
      stub.received.length = 0;
      await call(`/api/channels/${room}/messages`, { text: "survives a restart" });
      await eventually(() => stub.received.some((r) => r.url === "/restart"), 5000);

      await current.stop();
      stub.handler = () => ({ body: "" });
      stub.received.length = 0;
      current = await createWorkspaceServer({
        dataDir: restartDir,
        port: 0,
        mdns: false,
        allowPrivateHooks: true,
        logger: false,
      });
      // The queue is in the workspace file, so the event outlived the process
      // that could not deliver it.
      (current.store as unknown as { db: { prepare: (q: string) => { run: () => void } } }).db
        .prepare("UPDATE event_deliveries SET next_attempt_at = 0")
        .run();
      await current.flushEventDeliveries();
      await eventually(() => stub.received.some((r) => r.url === "/restart"), 5000);
      const payload = JSON.parse(stub.received.find((r) => r.url === "/restart")!.body) as {
        event: { text: string };
      };
      expect(payload.event.text).toBe("survives a restart");
    } finally {
      await current.stop();
      rmSync(restartDir, { recursive: true, force: true });
    }
  });
});

describe("interactive buttons", () => {
  /** Accepts the interactivity URL by echoing the verification challenge. */
  const acceptVerification = () => {
    stub.handler = (req) => {
      const body = JSON.parse(req.body) as { challenge?: string };
      return { body: JSON.stringify({ challenge: body.challenge }) };
    };
  };

  it("does not save an interactivity URL after the verifying admin loses that role", async () => {
    const created = await newApp("Demoted Interactivity Admin");
    const previousUrl = stub.url("/existing-interactivity");
    acceptVerification();
    const initial = await api(`/api/apps/${created.id}/interactivity`, {
      method: "PUT",
      token: aliceToken,
      body: { url: previousUrl },
    });
    expect(initial.status).toBe(200);

    server.store.updateUser(bob.id, { role: "admin" });
    stub.handler = (req) => {
      if (req.url === "/demoted-interactivity") server.store.updateUser(bob.id, { role: "member" });
      return {
        body: JSON.stringify({
          challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
        }),
      };
    };

    try {
      const result = await api<{ error: string }>(`/api/apps/${created.id}/interactivity`, {
        method: "PUT",
        token: bobToken,
        body: { url: stub.url("/demoted-interactivity") },
      });
      expect(result.status).toBe(403);
      expect(result.data.error).toBe("admin_only");
      expect(server.store.getApp(created.id)?.interactivityUrl).toBe(previousUrl);
    } finally {
      server.store.updateUser(bob.id, { role: "member" });
    }
  });

  it("does not save an interactivity URL for an app deleted during verification", async () => {
    const created = await newApp("Deleted Interactivity App");
    stub.handler = (req) => {
      if (req.url === "/deleted-interactivity") server.store.deleteApp(created.id);
      return {
        body: JSON.stringify({
          challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
        }),
      };
    };

    const result = await api<{ error: string }>(`/api/apps/${created.id}/interactivity`, {
      method: "PUT",
      token: aliceToken,
      body: { url: stub.url("/deleted-interactivity") },
    });
    expect(result.status).toBe(404);
    expect(result.data.error).toBe("not_found");
    expect(server.store.getApp(created.id)).toBeNull();
  });

  it("carries a Block Kit actions block through to a pressable button", async () => {
    const created = await newApp("Deploy Bot");
    acceptVerification();
    const set = await api(`/api/apps/${created.id}/interactivity`, {
      method: "PUT",
      token: aliceToken,
      body: { url: stub.url("/interactions") },
    });
    expect(set.status).toBe(200);

    const posted = await api<{ ok: boolean; ts: string; message: Message }>(
      "/api/chat.postMessage",
      {
        token: created.token,
        body: {
          channel: channelId,
          text: "Deploy 412 to production?",
          blocks: [
            {
              type: "actions",
              block_id: "deploy",
              elements: [
                {
                  type: "button",
                  action_id: "approve",
                  text: { type: "plain_text", text: "Approve" },
                  style: "primary",
                  value: "412",
                },
                {
                  type: "button",
                  action_id: "docs",
                  text: { type: "plain_text", text: "Docs" },
                  url: "https://example.com/docs",
                },
                // Not a button, and not something we can draw: dropped rather
                // than shown as something that does nothing.
                { type: "static_select", action_id: "pick" },
                // A button that would hand someone a javascript: URL to click.
                {
                  type: "button",
                  action_id: "sneaky",
                  text: { type: "plain_text", text: "Click" },
                  url: "javascript:alert(1)",
                },
              ],
            },
          ],
        },
      },
    );
    expect(posted.data.message.actions.map((a) => a.actionId)).toEqual([
      "approve",
      "docs",
      "sneaky",
    ]);
    expect(posted.data.message.actions[0]).toMatchObject({
      blockId: "deploy",
      text: "Approve",
      style: "primary",
      value: "412",
      url: null,
    });
    expect(posted.data.message.actions[1]!.url).toBe("https://example.com/docs");
    // The javascript: URL is dropped, so that button calls the app instead of
    // handing the browser a scheme it should never follow.
    expect(posted.data.message.actions[2]!.url).toBeNull();

    // Pressing it delivers Slack's block_actions payload, signed as Slack signs.
    stub.received.length = 0;
    stub.handler = () => ({
      body: JSON.stringify({ replace_original: true, text: "Approved by Bob" }),
    });
    const pressed = await api<{ ok: boolean }>(`/api/messages/${posted.data.ts}/actions`, {
      token: bobToken,
      body: { actionId: "approve" },
    });
    expect(pressed.data.ok).toBe(true);

    const delivered = stub.received[0]!;
    expect(delivered.url).toBe("/interactions");
    const ts = delivered.headers["x-slack-request-timestamp"]!;
    expect(delivered.headers["x-slack-signature"]).toBe(
      `v0=${createHmac("sha256", created.signingSecret).update(`v0:${ts}:${delivered.body}`).digest("hex")}`,
    );
    const payload = JSON.parse(new URLSearchParams(delivered.body).get("payload")!) as {
      type: string;
      user: { id: string };
      actions: { action_id: string; value: string; style?: string }[];
      response_url: string;
      message: { ts: string };
    };
    expect(payload.type).toBe("block_actions");
    expect(payload.user.id).toBe(bob.id);
    expect(payload.actions[0]).toMatchObject({
      action_id: "approve",
      value: "412",
      style: "primary",
    });
    expect(payload.message.ts).toBe(posted.data.ts);

    // replace_original rewrote the message it sat on, and took the buttons.
    const after = await api<{ messages: Message[] }>(`/api/channels/${channelId}/messages`, {
      token: bobToken,
    });
    const updated = after.data.messages.find((m) => m.id === posted.data.ts)!;
    expect(updated.text).toBe("Approved by Bob");
    expect(updated.actions).toEqual([]);

    // And the button is gone for good: pressing it again finds nothing.
    const again = await api<{ error?: string }>(`/api/messages/${posted.data.ts}/actions`, {
      token: bobToken,
      body: { actionId: "approve" },
    });
    expect(again.status).toBe(404);
  });

  /** A message with one button from an app that acknowledges presses with nothing. */
  async function buttonMessage(name: string) {
    const created = await newApp(name);
    acceptVerification();
    await api(`/api/apps/${created.id}/interactivity`, {
      method: "PUT",
      token: aliceToken,
      body: { url: stub.url("/interactions") },
    });
    server.store.addMember(channelId, created.botUser.id);
    const posted = await api<{ ts: string }>("/api/chat.postMessage", {
      token: created.token,
      body: {
        channel: channelId,
        text: "Ship 413?",
        blocks: [
          {
            type: "actions",
            elements: [
              { type: "button", action_id: "go", text: { type: "plain_text", text: "Go" } },
            ],
          },
        ],
      },
    });
    // Bolt's ack(): an empty 200, straight away, with the real answer to follow.
    stub.received.length = 0;
    stub.handler = () => ({ body: "" });
    const pressed = await api<{ ok: boolean }>(`/api/messages/${posted.data.ts}/actions`, {
      token: bobToken,
      body: { actionId: "go" },
    });
    expect(pressed.data.ok).toBe(true);
    const payload = JSON.parse(
      new URLSearchParams(stub.received.find((r) => r.url === "/interactions")!.body).get(
        "payload",
      )!,
    ) as { response_url: string };
    return { messageId: posted.data.ts, responseUrl: payload.response_url };
  }

  it("rewrites the message later through response_url, the way Bolt does", async () => {
    const { messageId, responseUrl } = await buttonMessage("Later Bot");
    // Bolt's respond({ replace_original: true }) goes to the response_url after
    // the acknowledgement, never in it.
    const res = await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replace_original: true, text: "Shipped 413." }),
    });
    expect(res.status).toBe(200);
    const updated = server.store.getMessage(messageId)!;
    expect(updated.text).toBe("Shipped 413.");
    expect(updated.actions).toEqual([]);
  });

  it("refreshes live mention counts when an app replaces its message", async () => {
    const { messageId, responseUrl } = await buttonMessage("Mention Update Bot");
    const reader = connectWs(bobToken);
    await reader.next((frame) => frame.type === "ready");
    const baseline = server.store.unreadMentionCounts(bob.id)[channelId] ?? 0;
    reader.received.length = 0;
    try {
      const replace = (text: string) =>
        fetch(responseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ replace_original: true, text }),
        });
      expect((await replace(`Please review <@${bob.id}>`)).status).toBe(200);
      await reader.next(
        (frame) =>
          frame.type === "ephemeral" &&
          frame.event.type === "mentions" &&
          frame.event.counts[channelId] === baseline + 1,
      );
      reader.received.length = 0;
      expect((await replace("Review no longer needed")).status).toBe(200);
      await reader.next(
        (frame) =>
          frame.type === "ephemeral" &&
          frame.event.type === "mentions" &&
          (frame.event.counts[channelId] ?? 0) === baseline,
      );
      expect(server.store.getMessage(messageId)?.text).toBe("Review no longer needed");
      expect(server.store.getMessage(messageId)?.actions).toEqual([]);
    } finally {
      reader.ws.terminate();
    }
  });

  it("removes the message later through response_url when asked to", async () => {
    const { messageId, responseUrl } = await buttonMessage("Cleanup Bot");
    const res = await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete_original: true }),
    });
    expect(res.status).toBe(200);
    expect(server.store.getMessage(messageId)).toBeNull();
  });

  it("refuses a button on a message the presser cannot see", async () => {
    const created = await newApp("Private Bot");
    acceptVerification();
    await api(`/api/apps/${created.id}/interactivity`, {
      method: "PUT",
      token: aliceToken,
      body: { url: stub.url("/interactions") },
    });
    const { data: madeChannel } = await api<{ channel: { id: string } }>("/api/channels", {
      token: aliceToken,
      body: { type: "private", name: "war-room" },
    });
    server.store.addMember(madeChannel.channel.id, created.botUser.id);

    const posted = await api<{ ts: string }>("/api/chat.postMessage", {
      token: created.token,
      body: {
        channel: madeChannel.channel.id,
        text: "ship it?",
        blocks: [
          {
            type: "actions",
            elements: [
              { type: "button", action_id: "yes", text: { type: "plain_text", text: "Ship" } },
            ],
          },
        ],
      },
    });

    stub.received.length = 0;
    const pressed = await api(`/api/messages/${posted.data.ts}/actions`, {
      token: bobToken,
      body: { actionId: "yes" },
    });
    expect(pressed.status).toBe(404);
    // Nothing was sent onward on behalf of someone who cannot see the message.
    expect(stub.received).toHaveLength(0);
  });

  it("does not accept an interactivity URL that will not answer the handshake", async () => {
    const created = await newApp("Silent Bot");
    stub.handler = () => ({ body: "" });
    const set = await api<{ error: string }>(`/api/apps/${created.id}/interactivity`, {
      method: "PUT",
      token: aliceToken,
      body: { url: stub.url("/nope") },
    });
    expect(set.status).toBe(400);
    expect(set.data.error).toBe("challenge_failed");
  });
});

describe("a deactivated app", () => {
  it("goes quiet without being deleted", async () => {
    const created = await newApp("Noisy Bot");
    const hook = await api<{ url: string }>(`/api/apps/${created.id}/webhooks`, {
      token: aliceToken,
      body: { channelId },
    });

    // It works to begin with, both ways in.
    const before = await api("/api/chat.postMessage", {
      token: created.token,
      body: { channel: channelId, text: "still here" },
    });
    expect(before.status).toBe(200);
    expect(
      (
        await fetch(`${base}${hook.data.url}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "via hook" }),
        })
      ).status,
    ).toBe(200);

    await api(`/api/admin/users/${created.botUser.id}`, {
      method: "PATCH",
      token: aliceToken,
      body: { deactivated: true },
    });

    // Its token and its webhooks both stop, and the app itself is still there
    // to be turned back on.
    const after = await api<{ error: string }>("/api/chat.postMessage", {
      token: created.token,
      body: { channel: channelId, text: "should not appear" },
    });
    // Slack answers a failed method with 200 and ok:false; see slackError.
    expect(after.status).toBe(200);
    expect(after.data.error).toBe("invalid_auth");
    expect(
      (
        await fetch(`${base}${hook.data.url}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "should not appear" }),
        })
      ).status,
    ).toBe(404);

    await api(`/api/admin/users/${created.botUser.id}`, {
      method: "PATCH",
      token: aliceToken,
      body: { deactivated: false },
    });
    const back = await api("/api/chat.postMessage", {
      token: created.token,
      body: { channel: channelId, text: "back on" },
    });
    expect(back.status).toBe(200);
  });
});

describe("revoking an app while it is being used", () => {
  /** An app with a slash command pointing at the stub, ready to be interrupted. */
  async function commandApp(name: string, commandName: string, path: string) {
    const created = await newApp(name);
    const registered = await api(`/api/apps/${created.id}/commands`, {
      token: aliceToken,
      body: { command: `/${commandName}`, url: stub.url(path), description: "test" },
    });
    expect(registered.status).toBe(201);
    return created;
  }

  async function run(commandName: string, room = channelId) {
    return api<{ ok: boolean }>(`/api/channels/${room}/commands`, {
      token: aliceToken,
      body: { text: `/${commandName} go` },
    });
  }

  function said(text: string, room = channelId) {
    return server.store.listMessages({ channelId: room, limit: 50 }).some((m) => m.text === text);
  }

  /** Captures what the command handed the app, then answers with nothing. */
  function capture(path: string, into: { url?: string; trigger?: string }) {
    stub.handler = (req) => {
      if (req.url === path) {
        const form = new URLSearchParams(req.body);
        into.url = form.get("response_url") ?? undefined;
        into.trigger = form.get("trigger_id") ?? undefined;
      }
      return { body: "" };
    };
  }

  /** The app answering later, on the url it was given. */
  async function late(url: string, text: string) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", text }),
    });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  }

  async function newRoom(name: string, type: "public" | "private") {
    const { data } = await api<{ channel: { id: string } }>("/api/channels", {
      token: aliceToken,
      body: { type, name },
    });
    return data.channel.id;
  }

  it("does not post an answer from an app deleted while it was answering", async () => {
    const created = await commandApp("Doomed Bot", "doomed", "/doomed");
    // Deleting from inside the handler is the race itself: the reply is already
    // on its way back at the moment the app stops existing.
    stub.handler = (req) => {
      if (req.url === "/doomed") {
        server.store.transaction(() => server.store.deleteApp(created.id));
        return { body: JSON.stringify({ response_type: "in_channel", text: "from a ghost" }) };
      }
      return { body: "" };
    };
    const out = await run("doomed");
    // The person who typed it is told it worked, because for them it did. The
    // app losing the right to answer is not their failure to see.
    expect(out.status).toBe(200);
    expect(out.data.ok).toBe(true);
    expect(said("from a ghost")).toBe(false);
  });

  it("stays quiet for an app deactivated while it was answering", async () => {
    const created = await commandApp("Muted Bot", "muted", "/muted");
    let silence = true;
    stub.handler = (req) => {
      if (req.url === "/muted") {
        if (silence) server.store.updateUser(created.botUser.id, { deactivated: true });
        return { body: JSON.stringify({ response_type: "in_channel", text: "while muted" }) };
      }
      return { body: "" };
    };
    const out = await run("muted");
    expect(out.data.ok).toBe(true);
    expect(said("while muted")).toBe(false);

    // Turning it back on is all it takes: deactivation silences the app, it
    // does not break the command.
    server.store.updateUser(created.botUser.id, { deactivated: false });
    silence = false;
    stub.handler = (req) =>
      req.url === "/muted"
        ? { body: JSON.stringify({ response_type: "in_channel", text: "and back on" }) }
        : { body: "" };
    await run("muted");
    expect(said("and back on")).toBe(true);
    await api(`/api/apps/${created.id}`, { token: aliceToken, method: "DELETE" });
  });

  it("spends a response_url once its channel has been archived", async () => {
    const room = await newRoom("late-archive", "public");
    const created = await commandApp("Late Bot", "late-archive", "/late-archive");
    const got: { url?: string } = {};
    capture("/late-archive", got);

    await run("late-archive", room);
    expect(got.url).toBeDefined();
    // Half an hour of posting rights is fine while the room is open.
    expect((await late(got.url!, "in good time")).status).toBe(200);
    await eventually(() => said("in good time", room));

    await api(`/api/channels/${room}`, {
      method: "PATCH",
      token: aliceToken,
      body: { archived: true },
    });
    const after = await late(got.url!, "after archiving");
    // Refused as a spent url, rather than failing somewhere further in.
    expect(after.status).toBe(404);
    expect(after.body.error).toBe("expired_url");
    expect(said("after archiving", room)).toBe(false);
    await api(`/api/apps/${created.id}`, { token: aliceToken, method: "DELETE" });
  });

  it("spends a response_url once its bot has been taken out of a private room", async () => {
    const room = await newRoom("late-private", "private");
    const created = await commandApp("Evicted Bot", "late-private", "/late-private");
    const got: { url?: string } = {};
    capture("/late-private", got);

    // Running the command puts the bot in the room, which is how it can answer.
    await run("late-private", room);
    expect(got.url).toBeDefined();
    expect((await late(got.url!, "while inside")).status).toBe(200);
    await eventually(() => said("while inside", room));

    server.store.removeMember(room, created.botUser.id);
    const after = await late(got.url!, "after eviction");
    expect(after.status).toBe(404);
    expect(after.body.error).toBe("expired_url");
    expect(said("after eviction", room)).toBe(false);
    await api(`/api/apps/${created.id}`, { token: aliceToken, method: "DELETE" });
  });

  it("spends a response_url once its app is gone", async () => {
    const created = await commandApp("Departed Bot", "departed", "/departed");
    const got: { url?: string } = {};
    capture("/departed", got);
    await run("departed");
    expect(got.url).toBeDefined();

    server.store.transaction(() => server.store.deleteApp(created.id));
    const after = await late(got.url!, "once the app had gone");
    expect(after.status).toBe(404);
    expect(after.body.error).toBe("expired_url");
    expect(said("once the app had gone")).toBe(false);
  });

  it("will not open a modal on a trigger whose room has since been archived", async () => {
    const room = await newRoom("trigger-archive", "public");
    const created = await commandApp("Modal Bot", "modal-archive", "/modal-archive");
    const got: { trigger?: string } = {};
    capture("/modal-archive", got);
    await run("modal-archive", room);
    expect(got.trigger).toBeDefined();

    await api(`/api/channels/${room}`, {
      method: "PATCH",
      token: aliceToken,
      body: { archived: true },
    });

    // The app is still installed and still authenticated, so its token is not
    // what stops this: the trigger names a room nobody can be shown a form in.
    const refused = await api<{ error: string }>("/api/views.open", {
      token: created.token,
      body: {
        trigger_id: got.trigger,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Too late" },
          blocks: [
            {
              type: "input",
              block_id: "b",
              label: { type: "plain_text", text: "Name" },
              element: { type: "plain_text_input", action_id: "a" },
            },
          ],
        },
      },
    });
    // Slack answers a failed method with 200 and ok:false; see slackError.
    expect(refused.status).toBe(200);
    expect(refused.data.error).toBe("expired_trigger_id");
    await api(`/api/apps/${created.id}`, { token: aliceToken, method: "DELETE" });
  });

  it("will not take a form submitted after its room was archived", async () => {
    const room = await newRoom("submit-archive", "public");
    const created = await commandApp("Form Bot", "form-archive", "/form-archive");
    const got: { trigger?: string } = {};
    // Set before the handshake below, which the interactivity URL has to answer
    // before it is accepted.
    stub.handler = (req) => {
      if (req.url === "/form-archive") {
        got.trigger = new URLSearchParams(req.body).get("trigger_id") ?? undefined;
        return { body: "" };
      }
      if (req.url === "/form-interact") {
        const parsed = JSON.parse(req.body) as { challenge?: string };
        return { body: parsed.challenge ? JSON.stringify({ challenge: parsed.challenge }) : "" };
      }
      return { body: "" };
    };
    const wired = await api(`/api/apps/${created.id}/interactivity`, {
      method: "PUT",
      token: aliceToken,
      body: { url: stub.url("/form-interact") },
    });
    expect(wired.status).toBe(200);

    await run("form-archive", room);
    expect(got.trigger).toBeDefined();
    const opened = await api<{ view: { id: string } }>("/api/views.open", {
      token: created.token,
      body: {
        trigger_id: got.trigger,
        view: {
          type: "modal",
          callback_id: "c",
          title: { type: "plain_text", text: "Fill in" },
          blocks: [
            {
              type: "input",
              block_id: "b",
              label: { type: "plain_text", text: "Name" },
              element: { type: "plain_text_input", action_id: "a" },
            },
          ],
        },
      },
    });
    expect(opened.status).toBe(200);

    // A form can sit open for half an hour, which is long enough for the room
    // it belongs to to be closed behind it. The app is never called.
    await api(`/api/channels/${room}`, {
      method: "PATCH",
      token: aliceToken,
      body: { archived: true },
    });
    stub.received.length = 0;
    const submitted = await api<{ error: string }>(`/api/views/${opened.data.view.id}/submit`, {
      token: aliceToken,
      body: { values: { b: { a: "anything" } } },
    });
    expect(submitted.status).toBe(404);
    expect(stub.received.filter((r) => r.url === "/form-interact")).toHaveLength(0);
    await api(`/api/apps/${created.id}`, { token: aliceToken, method: "DELETE" });
  });
});

describe("modals", () => {
  /** An app with a verified interactivity URL, ready to be pressed. */
  async function interactiveApp(name: string) {
    const created = await newApp(name);
    stub.handler = (req) => {
      const body = JSON.parse(req.body) as { challenge?: string };
      return { body: JSON.stringify({ challenge: body.challenge }) };
    };
    await api(`/api/apps/${created.id}/interactivity`, {
      method: "PUT",
      token: aliceToken,
      body: { url: stub.url("/interactions") },
    });
    return created;
  }

  /** Presses a button and returns the trigger_id the app was handed. */
  async function pressButton(created: { id: string; token: string }, presser: string) {
    const posted = await api<{ ts: string }>("/api/chat.postMessage", {
      token: created.token,
      body: {
        channel: channelId,
        text: "Open the form",
        blocks: [
          {
            type: "actions",
            elements: [
              { type: "button", action_id: "open", text: { type: "plain_text", text: "Open" } },
            ],
          },
        ],
      },
    });
    stub.received.length = 0;
    stub.handler = () => ({ body: "" });
    await api(`/api/messages/${posted.data.ts}/actions`, {
      token: presser,
      body: { actionId: "open" },
    });
    const payload = JSON.parse(new URLSearchParams(stub.received[0]!.body).get("payload")!) as {
      trigger_id: string;
    };
    return payload.trigger_id;
  }

  const view = {
    type: "modal",
    callback_id: "deploy_form",
    private_metadata: "build-412",
    title: { type: "plain_text", text: "Deploy" },
    submit: { type: "plain_text", text: "Ship it" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "Where is this going?" } },
      {
        type: "input",
        block_id: "where",
        label: { type: "plain_text", text: "Environment" },
        element: {
          type: "static_select",
          action_id: "env",
          options: [
            { text: { type: "plain_text", text: "Staging" }, value: "staging" },
            { text: { type: "plain_text", text: "Production" }, value: "production" },
          ],
        },
      },
      {
        type: "input",
        block_id: "why",
        optional: true,
        label: { type: "plain_text", text: "Notes" },
        element: { type: "plain_text_input", action_id: "notes", multiline: true },
      },
      // A control we cannot draw is dropped rather than shown as a dead field.
      {
        type: "input",
        block_id: "logs",
        label: { type: "plain_text", text: "Build logs" },
        element: { type: "file_input", action_id: "files" },
      },
    ],
  };

  it("opens a form on a trigger, pushes it to the presser, and delivers what they typed", async () => {
    const created = await interactiveApp("Form Bot");
    const trigger = await pressButton(created, bobToken);

    const socket = connectWs(bobToken);
    await socket.next((m) => m.type === "ready");

    const opened = await api<{ ok: boolean; view: { id: string } }>("/api/views.open", {
      token: created.token,
      body: { trigger_id: trigger, view },
    });
    expect(opened.data.ok).toBe(true);

    const pushed = (await socket.next(
      (m) => m.type === "ephemeral" && m.event.type === "view.open",
    )) as {
      type: "ephemeral";
      event: { type: "view.open"; view: PushedView };
    };
    const pushedView: PushedView = pushed.event.view;
    type PushedView = {
      id: string;
      title: string;
      submitLabel: string;
      text: string;
      fields: { blockId: string; type: string; optional: boolean; options: unknown[] }[];
    };
    expect(pushedView.title).toBe("Deploy");
    expect(pushedView.submitLabel).toBe("Ship it");
    expect(pushedView.text).toBe("Where is this going?");
    // The file input is gone; the two fields we can draw are not.
    expect(pushedView.fields.map((f) => f.blockId)).toEqual(["where", "why"]);
    expect(pushedView.fields[0]!.options).toHaveLength(2);
    expect(pushedView.fields[1]!.optional).toBe(true);

    // The app answers the submission with a field error; the form stays open.
    stub.received.length = 0;
    stub.handler = () => ({
      body: JSON.stringify({
        response_action: "errors",
        errors: { where: "Not on a Friday." },
      }),
    });
    const refused = await api<{ ok: boolean; errors: Record<string, string> }>(
      `/api/views/${pushedView.id}/submit`,
      { token: bobToken, body: { values: { where: { env: "production" }, why: { notes: "" } } } },
    );
    expect(refused.data).toEqual({ ok: false, errors: { where: "Not on a Friday." } });

    const delivered = JSON.parse(new URLSearchParams(stub.received[0]!.body).get("payload")!) as {
      type: string;
      user: { id: string };
      view: {
        callback_id: string;
        private_metadata: string;
        state: {
          values: Record<
            string,
            Record<string, { value?: string; selected_option?: { text: unknown; value: string } }>
          >;
        };
      };
    };
    expect(delivered.type).toBe("view_submission");
    expect(delivered.user.id).toBe(bob.id);
    expect(delivered.view.callback_id).toBe("deploy_form");
    expect(delivered.view.private_metadata).toBe("build-412");
    // As Slack sends it: the option's text beside its value.
    expect(delivered.view.state.values.where!.env!.selected_option).toEqual({
      text: { type: "plain_text", text: "Production" },
      value: "production",
    });

    // Accepting it closes the form for good.
    stub.handler = () => ({ body: "" });
    const accepted = await api<{ ok: boolean }>(`/api/views/${pushedView.id}/submit`, {
      token: bobToken,
      body: { values: { where: { env: "staging" }, why: { notes: "quick fix" } } },
    });
    expect(accepted.data.ok).toBe(true);
    const reused = await api(`/api/views/${pushedView.id}/submit`, {
      token: bobToken,
      body: { values: { where: { env: "staging" } } },
    });
    expect(reused.status).toBe(404);
    socket.ws.close();
  });

  it("holds back a submission that leaves a required field empty", async () => {
    const created = await interactiveApp("Strict Bot");
    const trigger = await pressButton(created, bobToken);
    const opened = await api<{ view: { id: string } }>("/api/views.open", {
      token: created.token,
      body: { trigger_id: trigger, view },
    });

    stub.received.length = 0;
    const result = await api<{ ok: boolean; errors: Record<string, string> }>(
      `/api/views/${opened.data.view.id}/submit`,
      { token: bobToken, body: { values: { where: { env: "  " }, why: { notes: "hi" } } } },
    );
    expect(result.data.ok).toBe(false);
    expect(result.data.errors.where).toBeTruthy();
    // The app is never asked about a form the form itself rejects.
    expect(stub.received).toHaveLength(0);
  });

  it("says the app's answer was unreadable, rather than that it never came", async () => {
    const created = await interactiveApp("Garbled Bot");
    const trigger = await pressButton(created, bobToken);
    const opened = await api<{ view: { id: string } }>("/api/views.open", {
      token: created.token,
      body: { trigger_id: trigger, view },
    });

    stub.handler = () => ({ body: "{not json" });
    const result = await api<{ ok: boolean; message?: string }>(
      `/api/views/${opened.data.view.id}/submit`,
      { token: bobToken, body: { values: { where: { env: "staging" } } } },
    );
    expect(result.data.ok).toBe(false);
    expect(result.data.message).toBe("The app answered with something that could not be read.");
  });

  it("will not pass on an answer the select never offered", async () => {
    const created = await interactiveApp("Picky Bot");
    const trigger = await pressButton(created, bobToken);
    const opened = await api<{ view: { id: string } }>("/api/views.open", {
      token: created.token,
      body: { trigger_id: trigger, view },
    });

    stub.received.length = 0;
    const result = await api<{ ok: boolean; errors: Record<string, string> }>(
      `/api/views/${opened.data.view.id}/submit`,
      { token: bobToken, body: { values: { where: { env: "the-moon" } } } },
    );
    expect(result.data.ok).toBe(false);
    expect(result.data.errors.where).toBeTruthy();
    // The app is entitled to trust its own options, so it is never told.
    expect(stub.received).toHaveLength(0);
  });

  it("will not open a form in front of someone who did not ask for one", async () => {
    const created = await interactiveApp("Pushy Bot");
    const trigger = await pressButton(created, bobToken);

    // Alice's socket must not receive Bob's form.
    const hers = connectWs(aliceToken);
    await hers.next((m) => m.type === "ready");
    await api("/api/views.open", { token: created.token, body: { trigger_id: trigger, view } });
    await new Promise((r) => setTimeout(r, 100));
    expect(hers.received.some((m) => m.type === "ephemeral" && m.event.type === "view.open")).toBe(
      false,
    );
    hers.ws.close();

    // And the trigger is spent: it cannot open a second form.
    const again = await api<{ error: string }>("/api/views.open", {
      token: created.token,
      body: { trigger_id: trigger, view },
    });
    // Slack answers a failed method with 200 and ok:false; see slackError.
    expect(again.status).toBe(200);
    expect(again.data.error).toBe("expired_trigger_id");
  });

  it("refuses a view with nothing it can draw", async () => {
    const created = await interactiveApp("Exotic Bot");
    const trigger = await pressButton(created, bobToken);
    const opened = await api<{ error: string }>("/api/views.open", {
      token: created.token,
      body: {
        trigger_id: trigger,
        view: {
          title: { type: "plain_text", text: "Send a file" },
          blocks: [
            {
              type: "input",
              block_id: "upload",
              label: { type: "plain_text", text: "File" },
              element: { type: "file_input", action_id: "file" },
            },
          ],
        },
      },
    });
    // Slack answers a failed method with 200 and ok:false; see slackError.
    expect(opened.status).toBe(200);
    expect(opened.data.error).toBe("unsupported_elements");
  });

  it("does not let one app open a form on another app's trigger", async () => {
    const mine = await interactiveApp("Mine");
    const theirs = await interactiveApp("Theirs");
    const trigger = await pressButton(mine, bobToken);
    const stolen = await api<{ error: string }>("/api/views.open", {
      token: theirs.token,
      body: { trigger_id: trigger, view },
    });
    // Slack answers a failed method with 200 and ok:false; see slackError.
    expect(stolen.status).toBe(200);
    expect(stolen.data.error).toBe("trigger_not_yours");
  });

  describe("controls beyond text and a static select", () => {
    const option = (text: string, value: string, description?: string) => ({
      text: { type: "plain_text", text },
      value,
      ...(description ? { description: { type: "mrkdwn", text: description } } : {}),
    });
    const input = (
      blockId: string,
      label: string,
      element: Record<string, unknown>,
      optional = false,
    ) => ({
      type: "input",
      block_id: blockId,
      optional,
      label: { type: "plain_text", text: label },
      element,
    });

    /** A private channel Bob is not in, one he is in, his DM with Alice, and an archived one. */
    let leads: string;
    let ops: string;
    let dm: string;
    let archived: string;
    let carol: User;

    beforeAll(async () => {
      const room = async (body: Record<string, unknown>) =>
        (await api<{ channel: { id: string } }>("/api/channels", { token: aliceToken, body })).data
          .channel.id;
      leads = await room({ type: "private", name: "leads" });
      ops = await room({ type: "private", name: "ops", memberIds: [bob.id] });
      dm = await room({ type: "dm", memberIds: [bob.id] });
      archived = await room({ type: "public", name: "old-news" });
      await api(`/api/channels/${archived}`, {
        method: "PATCH",
        token: aliceToken,
        body: { archived: true },
      });
      const c = await api<{ user: User }>("/api/auth/register", {
        body: { handle: "carol", displayName: "Carol", password: "password123" },
      });
      carol = c.data.user;
      await api(`/api/admin/users/${carol.id}`, {
        method: "PATCH",
        token: aliceToken,
        body: { deactivated: true },
      });
    });

    const triage = () => ({
      type: "modal",
      callback_id: "triage",
      title: { type: "plain_text", text: "Triage" },
      blocks: [
        input("labels", "Labels", {
          type: "multi_static_select",
          action_id: "pick",
          max_selected_items: 2,
          option_groups: [
            { label: { type: "plain_text", text: "Kind" }, options: [option("Bug", "bug")] },
            {
              label: { type: "plain_text", text: "Other" },
              options: [option("Docs", "docs"), option("Urgent", "urgent")],
            },
          ],
          // One the select never offered, which is left out.
          initial_options: [option("Docs", "docs"), option("Gone", "gone")],
        }),
        input("checks", "Before shipping", {
          type: "checkboxes",
          action_id: "done",
          options: [option("Tests pass", "tests", "On the main branch"), option("Notes", "notes")],
          initial_options: [option("Tests pass", "tests", "On the main branch")],
        }),
        input("size", "Size", {
          type: "radio_buttons",
          action_id: "size",
          options: [option("Small", "s"), option("Large", "l")],
          initial_option: option("Large", "l"),
        }),
        input("owner", "Owner", { type: "users_select", action_id: "who", initial_user: bob.id }),
        input(
          "reviewers",
          "Reviewers",
          { type: "multi_users_select", action_id: "who", max_selected_items: 3 },
          true,
        ),
        input("where", "Where", {
          type: "conversations_select",
          action_id: "conv",
          default_to_current_conversation: true,
          filter: { include: ["public", "private"] },
        }),
        input(
          "tell",
          "Tell",
          { type: "multi_conversations_select", action_id: "convs", filter: { include: ["im"] } },
          true,
        ),
        input("room", "Room", { type: "channels_select", action_id: "chan" }),
        input("rooms", "Also in", { type: "multi_channels_select", action_id: "chans" }, true),
        input("day", "Day", { type: "datepicker", action_id: "date", initial_date: "2026-11-02" }),
        // Not a time, so the picker starts empty rather than wrong.
        input("at", "Time", { type: "timepicker", action_id: "time", initial_time: "25:00" }),
      ],
    });

    /** Answers that are all acceptable, for a test to spoil one at a time. */
    const good = () => ({
      labels: { pick: ["bug", "urgent"] },
      checks: { done: ["tests"] },
      size: { size: "s" },
      owner: { who: alice.id },
      reviewers: { who: [alice.id, bob.id] },
      where: { conv: ops },
      tell: { convs: [dm] },
      room: { chan: channelId },
      rooms: { chans: [] as string[] },
      day: { date: "2026-11-02" },
      at: { time: "09:30" },
    });

    type Field = {
      blockId: string;
      type: string;
      initialValue: string;
      initialValues?: string[];
      options: { text: string; value: string; description?: string }[];
      maxSelected?: number;
      conversationTypes?: string[];
    };

    /** Opens the triage form in front of Bob and returns what his client was sent. */
    async function openTriage(created: { id: string; token: string }) {
      const trigger = await pressButton(created, bobToken);
      const socket = connectWs(bobToken);
      await socket.next((m) => m.type === "ready");
      const opened = await api<{ ok: boolean; error?: string }>("/api/views.open", {
        token: created.token,
        body: { trigger_id: trigger, view: triage() },
      });
      expect(opened.data).toMatchObject({ ok: true });
      const pushed = (await socket.next(
        (m) => m.type === "ephemeral" && m.event.type === "view.open",
      )) as { type: "ephemeral"; event: { view: { id: string; fields: Field[] } } };
      socket.ws.close();
      return pushed.event.view;
    }

    it("draws every kind it was sent, each starting where the app asked", async () => {
      const opened = await openTriage(await interactiveApp("Triage Bot"));
      const field = (blockId: string) => opened.fields.find((f) => f.blockId === blockId)!;

      expect(opened.fields.map((f) => [f.blockId, f.type])).toEqual([
        ["labels", "multiselect"],
        ["checks", "checkboxes"],
        ["size", "radio"],
        ["owner", "user"],
        ["reviewers", "users"],
        ["where", "conversation"],
        ["tell", "conversations"],
        ["room", "channel"],
        ["rooms", "channels"],
        ["day", "date"],
        ["at", "time"],
      ]);
      // Groups are run together, since they are not drawn.
      expect(field("labels").options.map((o) => o.value)).toEqual(["bug", "docs", "urgent"]);
      expect(field("labels").initialValues).toEqual(["docs"]);
      expect(field("labels").maxSelected).toBe(2);
      expect(field("checks").options[0]).toEqual({
        text: "Tests pass",
        value: "tests",
        description: "On the main branch",
      });
      expect(field("checks").initialValues).toEqual(["tests"]);
      expect(field("checks").maxSelected).toBeUndefined();
      expect(field("size").initialValue).toBe("l");
      expect(field("owner").initialValue).toBe(bob.id);
      expect(field("reviewers").maxSelected).toBe(3);
      // The conversation the button was pressed in.
      expect(field("where").initialValue).toBe(channelId);
      expect(field("where").conversationTypes).toEqual(["public", "private"]);
      expect(field("tell").conversationTypes).toEqual(["dm"]);
      expect(field("room").conversationTypes).toBeUndefined();
      expect(field("day").initialValue).toBe("2026-11-02");
      expect(field("at").initialValue).toBe("");
    });

    it("hands the app each answer under the key Slack uses", async () => {
      const opened = await openTriage(await interactiveApp("Answer Bot"));
      stub.received.length = 0;
      stub.handler = () => ({ body: "" });
      const sent = await api<{ ok: boolean }>(`/api/views/${opened.id}/submit`, {
        token: bobToken,
        body: { values: good() },
      });
      expect(sent.data.ok).toBe(true);

      const values = (
        JSON.parse(new URLSearchParams(stub.received[0]!.body).get("payload")!) as {
          view: { state: { values: Record<string, Record<string, unknown>> } };
        }
      ).view.state.values;
      const text = (t: string) => ({ type: "plain_text", text: t });
      expect(values).toEqual({
        labels: {
          pick: {
            type: "multi_static_select",
            selected_options: [
              { text: text("Bug"), value: "bug" },
              { text: text("Urgent"), value: "urgent" },
            ],
          },
        },
        checks: {
          done: {
            type: "checkboxes",
            selected_options: [
              { text: text("Tests pass"), value: "tests", description: text("On the main branch") },
            ],
          },
        },
        size: {
          size: { type: "radio_buttons", selected_option: { text: text("Small"), value: "s" } },
        },
        owner: { who: { type: "users_select", selected_user: alice.id } },
        reviewers: { who: { type: "multi_users_select", selected_users: [alice.id, bob.id] } },
        where: { conv: { type: "conversations_select", selected_conversation: ops } },
        tell: { convs: { type: "multi_conversations_select", selected_conversations: [dm] } },
        room: { chan: { type: "channels_select", selected_channel: channelId } },
        rooms: { chans: { type: "multi_channels_select", selected_channels: [] } },
        day: { date: { type: "datepicker", selected_date: "2026-11-02" } },
        at: { time: { type: "timepicker", selected_time: "09:30" } },
      });
    });

    it("takes one answer for a list from a client that drew the list as a text box", async () => {
      const opened = await openTriage(await interactiveApp("Older Client Bot"));
      stub.received.length = 0;
      stub.handler = () => ({ body: "" });
      // A client from before these kinds draws any it does not know as text.
      const sent = await api<{ ok: boolean }>(`/api/views/${opened.id}/submit`, {
        token: bobToken,
        body: { values: { ...good(), reviewers: { who: ` ${bob.id} ` } } },
      });
      expect(sent.data.ok).toBe(true);
      const values = (
        JSON.parse(new URLSearchParams(stub.received[0]!.body).get("payload")!) as {
          view: { state: { values: Record<string, Record<string, unknown>> } };
        }
      ).view.state.values;
      expect(values.reviewers!.who).toEqual({
        type: "multi_users_select",
        selected_users: [bob.id],
      });
    });

    it("refuses an answer the field never offered, without asking the app", async () => {
      const opened = await openTriage(await interactiveApp("Guarded Bot"));
      stub.received.length = 0;
      const cases: [string, string, unknown, string][] = [
        ["labels", "pick", ["bug", "made-up"], "Choose from the options given."],
        ["labels", "pick", ["bug", "docs", "urgent"], "Choose at most 2."],
        ["labels", "pick", [], "This is required."],
        ["checks", "done", ["shipped"], "Choose from the options given."],
        ["size", "size", "m", "Choose one of the options."],
        ["size", "size", ["s", "l"], "Choose only one."],
        ["owner", "who", "", "This is required."],
        ["owner", "who", "01NOSUCHPERSON0000000000000", "Choose someone in this workspace."],
        ["owner", "who", "carol", "Choose someone in this workspace."],
        ["reviewers", "who", [bob.id, "nobody"], "Choose someone in this workspace."],
        // Private, and Bob is not in it.
        ["where", "conv", "leads", "Choose a conversation you can see."],
        // Bob can see it, but the app asked for channels only.
        ["where", "conv", "dm", "Choose a conversation you can see."],
        ["where", "conv", "archived", "Choose a conversation you can see."],
        ["tell", "convs", ["ops"], "Choose a conversation you can see."],
        ["room", "chan", "ops", "Choose a public channel."],
        ["rooms", "chans", ["archived"], "Choose a public channel."],
        ["day", "date", "2026-02-30", "Enter a date such as 2026-10-31."],
        ["day", "date", "next tuesday", "Enter a date such as 2026-10-31."],
        ["at", "time", "24:00", "Enter a time such as 14:30."],
      ];
      const ids: Record<string, string> = { leads, ops, dm, archived, carol: carol.id };
      const resolve = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(resolve)
          : typeof value === "string"
            ? (ids[value] ?? value)
            : value;

      for (const [blockId, actionId, value, error] of cases) {
        const result = await api<{ ok: boolean; errors: Record<string, string> }>(
          `/api/views/${opened.id}/submit`,
          {
            token: bobToken,
            body: { values: { ...good(), [blockId]: { [actionId]: resolve(value) } } },
          },
        );
        expect(result.data, `${blockId} = ${JSON.stringify(value)}`).toEqual({
          ok: false,
          errors: { [blockId]: error },
        });
      }
      // The app is entitled to trust its own form, so it never heard of these.
      expect(stub.received).toHaveLength(0);
    });
  });
  describe("changing an open form, and stacking forms (E18b)", () => {
    /**
     * Each test's own person: every press and submission counts against the
     * account's app calls, and Bob has made plenty by now.
     */
    let personToken: string;
    let people = 0;
    beforeEach(async () => {
      people++;
      const made = await api<{ token: string; user: User }>("/api/auth/register", {
        body: {
          handle: `stacker${people}`,
          displayName: `Stacker ${people}`,
          password: "password123",
        },
      });
      personToken = made.data.token;
      server.store.addMember(channelId, made.data.user.id);
    });

    type ViewAnswer = {
      ok: boolean;
      error?: string;
      view: { id: string; hash: string; external_id: string; root_view_id: string };
    };
    type Shown = { id: string; hash?: string; fields: unknown[]; submitLabel: string };
    type Submitted = {
      ok: boolean;
      closedViewIds?: string[];
      errors?: Record<string, string>;
      message?: string;
    };

    const loading = (externalId?: string) => ({
      type: "modal",
      title: { type: "plain_text", text: "Deploy" },
      ...(externalId ? { external_id: externalId } : {}),
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Loading…" } }],
    });
    const confirm = (title: string) => ({
      type: "modal",
      callback_id: "confirm",
      title: { type: "plain_text", text: title },
      blocks: [
        {
          type: "input",
          block_id: "confirm",
          label: { type: "plain_text", text: "Type yes" },
          element: { type: "plain_text_input", action_id: "really" },
        },
      ],
    });
    const deployAnswer = { where: { env: "staging" } };
    const confirmAnswer = { confirm: { really: "yes" } };

    const submit = (id: string, values: Record<string, Record<string, string>>) =>
      api<Submitted>(`/api/views/${id}/submit`, { token: personToken, body: { values } });

    /** The next stack Bob's devices are sent that passes `check`. */
    const nextStack = (socket: ReturnType<typeof connectWs>, check: (stack: Shown[]) => boolean) =>
      socket
        .next((m) => {
          if (m.type !== "ephemeral" || m.event.type !== "view.open") return false;
          const event = m.event as { view: Shown; stack?: Shown[] };
          return check(event.stack ?? [event.view]);
        })
        .then((m) => {
          const event = (m as { event: { view: Shown; stack?: Shown[] } }).event;
          // The form to show is the top of the stack, for a client from before stacks.
          expect(event.view).toEqual(event.stack!.at(-1));
          return event.stack!;
        });

    /** The trigger the app was handed with its latest view_submission. */
    const lastSubmissionTrigger = () =>
      (
        JSON.parse(new URLSearchParams(stub.received.at(-1)!.body).get("payload")!) as {
          trigger_id: string;
        }
      ).trigger_id;

    it("shows text alone, then the form in its place, refusing a stale hash", async () => {
      const created = await interactiveApp("Loading Bot");
      const socket = connectWs(personToken);
      await socket.next((m) => m.type === "ready");
      const opened = await api<ViewAnswer>("/api/views.open", {
        token: created.token,
        body: { trigger_id: await pressButton(created, personToken), view: loading("deploy-412") },
      });
      expect(opened.data.ok).toBe(true);
      const { id, hash, external_id } = opened.data.view;
      expect(external_id).toBe("deploy-412");
      const [shown] = await nextStack(socket, (s) => s[0]?.id === id);
      // Text alone: nothing to fill in, and nothing to submit.
      expect(shown).toMatchObject({ fields: [], submitLabel: "" });
      expect((await submit(id, {})).status).toBe(400);

      socket.received.length = 0;
      const updated = await api<ViewAnswer>("/api/views.update", {
        token: created.token,
        body: { view_id: id, hash, view: view },
      });
      expect(updated.data.ok).toBe(true);
      expect(updated.data.view.id).toBe(id);
      expect(updated.data.view.hash).not.toBe(hash);
      const [form] = await nextStack(socket, (s) => s[0]?.hash === updated.data.view.hash);
      expect(form!.fields).toHaveLength(2);

      // A change made from the first answer's hash would undo the second.
      const stale = await api<ViewAnswer>("/api/views.update", {
        token: created.token,
        body: { view_id: id, hash, view: loading() },
      });
      expect(stale.status).toBe(200);
      expect(stale.data.error).toBe("hash_conflict");

      // By the name the app gave it, which an update without one keeps.
      const named = await api<ViewAnswer>("/api/views.update", {
        token: created.token,
        body: { external_id: "deploy-412", view: { ...view, title: "Deploy 412" } },
      });
      expect(named.data.view).toMatchObject({ id, external_id: "deploy-412" });

      // Another app's update is answered as if there were no such view.
      const other = await interactiveApp("Nosy Bot");
      for (const body of [
        { view_id: id, view },
        { external_id: "deploy-412", view },
        { view_id: "01NOSUCHVIEW00000000000000", view },
      ]) {
        const refused = await api<ViewAnswer>("/api/views.update", {
          token: (body.view_id === id || body.external_id ? other : created).token,
          body,
        });
        expect(refused.data.error, JSON.stringify(body)).toBe("not_found");
      }

      stub.handler = () => ({ body: "" });
      expect((await submit(id, deployAnswer)).data).toEqual({ ok: true, closedViewIds: [id] });
      socket.ws.close();
    });

    it("stacks a form on the one submitted, and goes back to it when that one closes", async () => {
      const created = await interactiveApp("Stacking Bot");
      const socket = connectWs(personToken);
      await socket.next((m) => m.type === "ready");
      const root = (
        await api<ViewAnswer>("/api/views.open", {
          token: created.token,
          body: { trigger_id: await pressButton(created, personToken), view },
        })
      ).data.view.id;

      stub.handler = () => ({
        body: JSON.stringify({ response_action: "push", view: confirm("Are you sure?") }),
      });
      const pushed = await submit(root, deployAnswer);
      expect(pushed.data).toEqual({ ok: true, closedViewIds: [] });
      const stack = await nextStack(socket, (s) => s.length === 2);
      expect(stack[0]!.id).toBe(root);
      const second = stack[1]!.id;
      // Only the form on top is in front of the person.
      expect((await submit(root, deployAnswer)).status).toBe(404);

      // The app sees where the submitted form sits.
      stub.received.length = 0;
      stub.handler = () => ({ body: "" });
      socket.received.length = 0;
      expect((await submit(second, confirmAnswer)).data).toEqual({
        ok: true,
        closedViewIds: [second],
      });
      const sent = JSON.parse(new URLSearchParams(stub.received[0]!.body).get("payload")!) as {
        view: { root_view_id: string; previous_view_id: string | null; hash: string };
      };
      expect(sent.view).toMatchObject({ root_view_id: root, previous_view_id: root });
      expect(sent.view.hash).toBeTruthy();
      await nextStack(socket, (s) => s.length === 1 && s[0]!.id === root);

      // views.push with that submission's trigger, until the stack is full.
      const pushes: string[] = [];
      for (const title of ["Second", "Third"]) {
        const answer = await api<ViewAnswer>("/api/views.push", {
          token: created.token,
          body: { trigger_id: lastSubmissionTrigger(), view: confirm(title) },
        });
        expect(answer.data.ok).toBe(true);
        expect(answer.data.view.root_view_id).toBe(root);
        pushes.push(answer.data.view.id);
        // Each push spends its trigger; a submission hands out the next.
        stub.handler = () => ({
          body: JSON.stringify({ errors: {}, response_action: "errors" }),
        });
        await submit(answer.data.view.id, confirmAnswer);
      }
      await nextStack(socket, (s) => s.length === 3);
      const fourth = await api<ViewAnswer>("/api/views.push", {
        token: created.token,
        body: { trigger_id: lastSubmissionTrigger(), view: confirm("Fourth") },
      });
      expect(fourth.data.error).toBe("push_limit_reached");

      // "clear" closes the whole stack, and every device is told.
      stub.handler = () => ({ body: JSON.stringify({ response_action: "clear" }) });
      expect((await submit(pushes[1]!, confirmAnswer)).data).toEqual({
        ok: true,
        closedViewIds: [root, ...pushes],
      });
      const closed = (await socket.next(
        (m) => m.type === "ephemeral" && m.event.type === "view.close",
      )) as { event: { viewIds: string[] } };
      expect(closed.event.viewIds).toEqual([root, ...pushes]);
      socket.ws.close();
    });

    it("changes the form in its answer and keeps it open", async () => {
      const created = await interactiveApp("Answer Update Bot");
      const opened = (
        await api<ViewAnswer>("/api/views.open", {
          token: created.token,
          body: { trigger_id: await pressButton(created, personToken), view },
        })
      ).data.view;
      stub.handler = () => ({
        body: JSON.stringify({ response_action: "update", view: confirm("Step two") }),
      });
      expect((await submit(opened.id, deployAnswer)).data).toEqual({
        ok: true,
        closedViewIds: [],
      });
      // Still open under the same id, now asking the new question.
      stub.received.length = 0;
      stub.handler = () => ({ body: "" });
      expect((await submit(opened.id, confirmAnswer)).data.ok).toBe(true);
      const sent = JSON.parse(new URLSearchParams(stub.received[0]!.body).get("payload")!) as {
        view: { callback_id: string; state: { values: Record<string, unknown> } };
      };
      expect(sent.view.callback_id).toBe("confirm");
      expect(Object.keys(sent.view.state.values)).toEqual(["confirm"]);
    });

    it("says so when the app answers with a form that cannot be shown", async () => {
      const created = await interactiveApp("Broken Update Bot");
      const opened = (
        await api<ViewAnswer>("/api/views.open", {
          token: created.token,
          body: { trigger_id: await pressButton(created, personToken), view },
        })
      ).data.view;
      stub.handler = () => ({ body: JSON.stringify({ response_action: "update", view: {} }) });
      const result = await submit(opened.id, deployAnswer);
      expect(result.data).toMatchObject({
        ok: false,
        message: "The app answered with a form that cannot be shown.",
      });
    });

    it("closes a form when its person does, and only for them", async () => {
      const created = await interactiveApp("Closable Bot");
      const opened = (
        await api<ViewAnswer>("/api/views.open", {
          token: created.token,
          body: { trigger_id: await pressButton(created, personToken), view },
        })
      ).data.view;
      // Someone else cannot close it.
      await api(`/api/views/${opened.id}/close`, { method: "POST", token: aliceToken });
      const hers = await api<ViewAnswer>("/api/views.update", {
        token: created.token,
        body: { view_id: opened.id, view },
      });
      expect(hers.data.ok).toBe(true);

      const socket = connectWs(personToken);
      await socket.next((m) => m.type === "ready");
      expect(
        (await api(`/api/views/${opened.id}/close`, { method: "POST", token: personToken })).status,
      ).toBe(200);
      const closed = (await socket.next(
        (m) => m.type === "ephemeral" && m.event.type === "view.close",
      )) as { event: { viewIds: string[] } };
      expect(closed.event.viewIds).toEqual([opened.id]);
      expect((await submit(opened.id, deployAnswer)).status).toBe(404);
      const gone = await api<ViewAnswer>("/api/views.update", {
        token: created.token,
        body: { view_id: opened.id, view },
      });
      expect(gone.data.error).toBe("not_found");
      socket.ws.close();
    });

    it("closes the form a person had open when another is opened for them", async () => {
      const first = await interactiveApp("First Form Bot");
      const second = await interactiveApp("Second Form Bot");
      const older = (
        await api<ViewAnswer>("/api/views.open", {
          token: first.token,
          body: { trigger_id: await pressButton(first, personToken), view },
        })
      ).data.view;
      const pushed = await api<ViewAnswer>("/api/views.push", {
        token: second.token,
        body: { trigger_id: await pressButton(second, personToken), view: confirm("Other app") },
      });
      // Not on another app's form: it opens as the first of a new stack.
      expect(pushed.data.view.root_view_id).toBe(pushed.data.view.id);
      expect((await submit(older.id, deployAnswer)).status).toBe(404);
    });
  });
});

describe("replacing an app's credentials", () => {
  const sign = (secret: string, ts: string, body: string) =>
    `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

  async function postAs(token: string, text: string) {
    return api<{ ok: boolean; error?: string }>("/api/chat.postMessage", {
      token,
      body: { channel: channelId, text },
    });
  }

  it("gives a working bot token and stops the old one at once", async () => {
    const created = await newApp("Rotating Bot");
    server.store.addMember(channelId, created.botUser.id);
    expect((await postAs(created.token, "before")).data.ok).toBe(true);

    const replaced = await api<{ token: string }>(`/api/apps/${created.id}/token`, {
      method: "POST",
      token: aliceToken,
    });
    expect(replaced.status).toBe(200);
    expect(replaced.data.token.startsWith("xoxb-")).toBe(true);
    expect(replaced.data.token).not.toBe(created.token);

    // No overlap: a token is replaced because it leaked, and a window in which
    // both work is a window in which the leaked one still does.
    const old = await postAs(created.token, "with the leaked token");
    // Slack answers a failed method with 200 and ok:false; see slackError.
    expect(old.status).toBe(200);
    expect(old.data.error).toBe("invalid_auth");
    expect((await postAs(replaced.data.token, "after")).data.ok).toBe(true);
  });

  it("signs the next request with a new signing secret, and not the old one", async () => {
    const created = await newApp("Secret Bot");
    stub.handler = () => ({ body: "" });
    const registered = await api(`/api/apps/${created.id}/commands`, {
      token: aliceToken,
      body: { command: "/rotated", url: stub.url("/rotated") },
    });
    expect(registered.status).toBe(201);

    const replaced = await api<{ signingSecret: string }>(
      `/api/apps/${created.id}/signing-secret`,
      { method: "POST", token: aliceToken },
    );
    expect(replaced.status).toBe(200);
    expect(replaced.data.signingSecret).not.toBe(created.signingSecret);

    stub.received.length = 0;
    await api(`/api/channels/${channelId}/commands`, {
      token: aliceToken,
      body: { text: "/rotated" },
    });
    const sent = stub.received.find((r) => r.url === "/rotated")!;
    const ts = sent.headers["x-slack-request-timestamp"]!;
    expect(sent.headers["x-slack-signature"]).toBe(
      sign(replaced.data.signingSecret, ts, sent.body),
    );
    expect(sent.headers["x-slack-signature"]).not.toBe(sign(created.signingSecret, ts, sent.body));

    // What an admin reads back is the secret now in use.
    const listed = await api<{ apps: { id: string; signingSecret: string }[] }>("/api/apps", {
      token: aliceToken,
    });
    expect(listed.data.apps.find((a) => a.id === created.id)!.signingSecret).toBe(
      replaced.data.signingSecret,
    );
  });

  it("signs an event already waiting in the queue with the new secret", async () => {
    // The body is queued; the signature is not. An endpoint whose secret leaked
    // should not keep receiving events signed with it after the replacement.
    const created = await newApp("Queued Secret Bot");
    stub.handler = (req) => ({
      body: JSON.stringify({
        challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
      }),
    });
    const sub = await api<{ subscription: { id: string } }>(
      `/api/apps/${created.id}/subscriptions`,
      {
        token: aliceToken,
        body: { url: stub.url("/queued-secret"), eventTypes: ["message.created"] },
      },
    );
    expect(sub.status).toBe(201);
    server.store.addMember(channelId, created.botUser.id);

    const db = (
      server.store as unknown as {
        db: {
          prepare: (q: string) => {
            run: (...a: unknown[]) => void;
            get: (...a: unknown[]) => unknown;
          };
        };
      }
    ).db;
    const attempts = () =>
      (
        db
          .prepare("SELECT attempts FROM event_deliveries WHERE subscription_id = ?")
          .get(sub.data.subscription.id) as { attempts: number } | undefined
      )?.attempts ?? 0;

    stub.handler = (req) =>
      req.url === "/queued-secret" ? { status: 503, body: "" } : { body: "" };
    await api(`/api/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { text: "waiting through a rotation" },
    });
    await eventually(() => attempts() > 0, 5000);

    const replaced = await api<{ signingSecret: string }>(
      `/api/apps/${created.id}/signing-secret`,
      { method: "POST", token: aliceToken },
    );
    stub.handler = () => ({ body: "" });
    stub.received.length = 0;
    db.prepare("UPDATE event_deliveries SET next_attempt_at = 0 WHERE subscription_id = ?").run(
      sub.data.subscription.id,
    );
    // A flush already running is joined rather than restarted, so keep asking
    // until the retry has actually gone out.
    while (!stub.received.some((r) => r.url === "/queued-secret"))
      await server.flushEventDeliveries();

    const retried = stub.received.find((r) => r.url === "/queued-secret")!;
    const ts = retried.headers["x-slack-request-timestamp"]!;
    expect(retried.headers["x-slack-retry-num"]).toBe("1");
    expect(retried.headers["x-slack-signature"]).toBe(
      sign(replaced.data.signingSecret, ts, retried.body),
    );
  });

  it("gives a webhook a new URL for the same channel, and refuses the old one", async () => {
    const created = await newApp("Hook Rotation Bot");
    const made = await api<{ webhook: { id: string }; url: string }>(
      `/api/apps/${created.id}/webhooks`,
      { token: aliceToken, body: { channelId } },
    );
    expect(made.status).toBe(201);
    const hook = (path: string, text: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    expect((await hook(made.data.url, "through the first url")).status).toBe(200);

    const replaced = await api<{ webhook: { id: string; channelId: string }; url: string }>(
      `/api/webhooks/${made.data.webhook.id}/url`,
      { method: "POST", token: aliceToken },
    );
    expect(replaced.status).toBe(200);
    expect(replaced.data.url).not.toBe(made.data.url);
    // Same webhook, same channel: nothing to choose again.
    expect(replaced.data.webhook.id).toBe(made.data.webhook.id);
    expect(replaced.data.webhook.channelId).toBe(channelId);

    expect((await hook(made.data.url, "through the leaked url")).status).toBe(404);
    expect((await hook(replaced.data.url, "through the new url")).status).toBe(200);
  });

  it("is for administrators only", async () => {
    const created = await newApp("Guarded Rotation Bot");
    const made = await api<{ webhook: { id: string } }>(`/api/apps/${created.id}/webhooks`, {
      token: aliceToken,
      body: { channelId },
    });
    for (const path of [
      `/api/apps/${created.id}/token`,
      `/api/apps/${created.id}/signing-secret`,
      `/api/webhooks/${made.data.webhook.id}/url`,
    ]) {
      const refused = await api(path, { method: "POST", token: bobToken });
      expect(refused.status, path).toBe(403);
    }
    // And a refusal replaced nothing.
    server.store.addMember(channelId, created.botUser.id);
    expect((await postAs(created.token, "still mine")).data.ok).toBe(true);
  });

  it("says so when there is nothing to replace", async () => {
    for (const path of [
      "/api/apps/01NOSUCHAPP000000000000000/token",
      "/api/apps/01NOSUCHAPP000000000000000/signing-secret",
      "/api/webhooks/01NOSUCHHOOK00000000000000/url",
    ]) {
      expect((await api(path, { method: "POST", token: aliceToken })).status, path).toBe(404);
    }
  });
});

describe("scopes on bot tokens (E18c)", () => {
  type Made = { app: { id: string; scopes: string[] }; botUser: User; token: string };
  const make = async (name: string, scopes?: string[]) =>
    (
      await api<Made>("/api/apps", {
        token: aliceToken,
        body: scopes ? { name, scopes } : { name },
      })
    ).data;

  /** A Web API call with its answer's scopes header. */
  async function slack(method: string, token: string, body: unknown) {
    const res = await fetch(`${base}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return {
      scopes: res.headers.get("x-oauth-scopes"),
      data: (await res.json()) as Record<string, unknown>,
    };
  }

  it("gives an app every scope when none are named, as before scopes", async () => {
    const made = await make("Unscoped Bot");
    expect(made.app.scopes).toEqual([
      "chat:write",
      "chat:write.public",
      "channels:history",
      "groups:history",
      "im:history",
      "mpim:history",
      "channels:read",
      "groups:read",
      "reactions:read",
      "pins:read",
      "users:read",
    ]);
    // Named, an app gets those alone, whatever order they came in.
    const narrow = await make("Narrow Bot", ["reactions:read", "chat:write", "chat:write"]);
    expect(narrow.app.scopes).toEqual(["chat:write", "reactions:read"]);
    const listed = await api<{ apps: { id: string; scopes: string[] }[] }>("/api/apps", {
      token: aliceToken,
    });
    expect(listed.data.apps.find((a) => a.id === narrow.app.id)!.scopes).toEqual([
      "chat:write",
      "reactions:read",
    ]);
  });

  it("refuses a method its scopes do not reach, naming the scope it needs", async () => {
    const made = await make("Mute Bot", []);
    const refused = await slack("chat.postMessage", made.token, {
      channel: channelId,
      text: "hello",
    });
    // Slack's shape, which its SDK reports by name.
    expect(refused.data).toEqual({
      ok: false,
      error: "missing_scope",
      needed: "chat:write",
      provided: "",
    });
    expect(refused.scopes).toBe("");
    // Methods that need no scope still answer, saying what the token holds.
    const who = await slack("auth.test", made.token, {});
    expect(who.data.ok).toBe(true);
    expect(who.scopes).toBe("");
  });

  it("posts where it was not added only with chat:write.public", async () => {
    const inside = await make("Member Bot", ["chat:write"]);
    const outside = await slack("chat.postMessage", inside.token, {
      channel: channelId,
      text: "not a member yet",
    });
    expect(outside.data).toMatchObject({
      ok: false,
      error: "not_in_channel",
      needed: "chat:write.public",
    });
    expect(outside.scopes).toBe("chat:write");
    server.store.addMember(channelId, inside.botUser.id);
    expect(
      (await slack("chat.postMessage", inside.token, { channel: channelId, text: "now a member" }))
        .data.ok,
    ).toBe(true);

    const everywhere = await make("Public Bot", ["chat:write", "chat:write.public"]);
    expect(
      (await slack("chat.postMessage", everywhere.token, { channel: channelId, text: "anywhere" }))
        .data.ok,
    ).toBe(true);
  });

  it("sends an app only the events its scopes let it read", async () => {
    const made = await make("Reading Bot", ["chat:write", "reactions:read"]);
    stub.handler = (req) => ({
      body: JSON.stringify({
        challenge: (JSON.parse(req.body) as { challenge: string }).challenge,
      }),
    });
    // Every event type, which is more than it may read.
    await api(`/api/apps/${made.app.id}/subscriptions`, {
      token: aliceToken,
      body: { url: stub.url("/scoped") },
    });
    stub.handler = () => ({ body: "" });
    server.store.addMember(channelId, made.botUser.id);
    stub.received.length = 0;
    const scoped = () =>
      stub.received
        .filter((r) => r.url === "/scoped")
        .map((r) => JSON.parse(r.body) as { event: { type: string; text?: string } });

    const unread = await api<{ message: { id: string } }>(`/api/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { text: "words it may not read" },
    });
    await api(`/api/messages/${unread.data.message.id}/reactions/${encodeURIComponent("👀")}`, {
      method: "PUT",
      token: aliceToken,
    });
    await eventually(() => scoped().some((e) => e.event.type === "reaction_added"));
    // Events go out in order, so the message would have come first.
    expect(scoped().map((e) => e.event.type)).toEqual(["reaction_added"]);

    await api(`/api/apps/${made.app.id}/scopes`, {
      method: "PUT",
      token: aliceToken,
      body: { scopes: ["chat:write", "reactions:read", "channels:history"] },
    });
    await api(`/api/channels/${channelId}/messages`, {
      token: aliceToken,
      body: { text: "words it may read" },
    });
    await eventually(() => scoped().some((e) => e.event.text === "words it may read"));
    expect(JSON.stringify(scoped())).not.toContain("words it may not read");
  });

  it("lets only an admin change what an app may do", async () => {
    const made = await make("Guarded Scopes Bot", ["chat:write"]);
    const refused = await api(`/api/apps/${made.app.id}/scopes`, {
      method: "PUT",
      token: bobToken,
      body: { scopes: ["chat:write", "users:read"] },
    });
    expect(refused.status).toBe(403);
    const unknown = await api(`/api/apps/${made.app.id}/scopes`, {
      method: "PUT",
      token: aliceToken,
      body: { scopes: ["admin"] },
    });
    expect(unknown.status).toBe(400);
    const changed = await api<{ app: { scopes: string[] } }>(`/api/apps/${made.app.id}/scopes`, {
      method: "PUT",
      token: aliceToken,
      body: { scopes: ["users:read"] },
    });
    expect(changed.data.app.scopes).toEqual(["users:read"]);
    // The token holds the new list from its next call.
    const after = await slack("chat.postMessage", made.token, { channel: channelId, text: "hi" });
    expect(after.data.error).toBe("missing_scope");
    expect(after.scopes).toBe("users:read");
  });
});
