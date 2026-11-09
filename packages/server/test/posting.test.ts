import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGE_TEXT_MAX } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/index.js";

/** Every way into a conversation meets the same rules (untangle U4). */

let server: WorkspaceServer | undefined;
let app: StubApp | undefined;
let dataDir: string | undefined;
let base = "";

afterEach(async () => {
  await server?.stop();
  await app?.stop();
  server = undefined;
  app = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

/** The app a command or button calls: it passes the handshake and answers with `answer`. */
class StubApp {
  server: Server;
  port = 0;
  /** Each request's body, after the handshake. */
  received: string[] = [];
  answer = "";

  constructor() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if (body.includes("url_verification")) {
          res.end(
            JSON.stringify({ challenge: (JSON.parse(body) as { challenge: string }).challenge }),
          );
          return;
        }
        this.received.push(body);
        res.end(this.answer);
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

  /** The `response_url` the last call carried, a form field or inside a button's payload. */
  get responseUrl(): string {
    const form = new URLSearchParams(this.received.at(-1)!);
    const payload = form.get("payload");
    return payload
      ? (JSON.parse(payload) as { response_url: string }).response_url
      : form.get("response_url")!;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

async function start(rateLimits?: Parameters<typeof createWorkspaceServer>[0]["rateLimits"]) {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-posting-"));
  app = new StubApp();
  await app.start();
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits,
    // The stub app listens on loopback.
    allowPrivateHooks: true,
  });
  base = `http://127.0.0.1:${server.port}`;
  const owner = (
    await call<{ token: string }>("/api/auth/register", {
      body: { handle: "owner", displayName: "Owner", password: "password123" },
    })
  ).data.token;
  const channelId = server.store.getChannelByName("general")!.id;
  const made = await call<{ app: { id: string }; botUser: { id: string }; token: string }>(
    "/api/apps",
    { token: owner, body: { name: "Deployer" } },
  );
  const appId = made.data.app.id;
  await call(`/api/apps/${appId}/commands`, {
    token: owner,
    body: { command: "/deploy", url: app.url("/deploy") },
  });
  await call(`/api/apps/${appId}/interactivity`, {
    method: "PUT",
    token: owner,
    body: { url: app.url("/interact") },
  });
  const hook = (
    await call<{ url: string }>(`/api/apps/${appId}/webhooks`, {
      token: owner,
      body: { channelId },
    })
  ).data.url;
  return { owner, channelId, appId, bot: made.data.token, botUserId: made.data.botUser.id, hook };
}

async function call<T>(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; data: T }> {
  const res = await fetch(path.startsWith("http") ? path : `${base}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text.startsWith("{") ? JSON.parse(text) : text) as T };
}

const texts = (channelId: string) =>
  server!.store.messages.list({ channelId, limit: 50 }).map((m) => m.text);

const tooLong = "x".repeat(MESSAGE_TEXT_MAX + 1);

describe("the message length limit", () => {
  it("refuses an over-long message every way in, each in its own shape", async () => {
    const { owner, channelId, bot, hook } = await start();

    const rest = await call<{ error: string }>(`/api/channels/${channelId}/messages`, {
      token: owner,
      body: { text: tooLong },
    });
    expect(rest.status).toBe(400);
    expect(rest.data.error).toBe("invalid_request");

    const scheduled = await call<{ error: string }>(`/api/channels/${channelId}/scheduled`, {
      token: owner,
      body: { text: tooLong, sendAt: Date.now() + 60_000 },
    });
    expect(scheduled.status).toBe(400);

    // Slack's own word, with the 200 its SDK reads.
    const web = await call("/api/chat.postMessage", {
      token: bot,
      body: { channel: channelId, text: tooLong },
    });
    expect(web).toEqual({ status: 200, data: { ok: false, error: "msg_too_long" } });

    const webhook = await call(hook, { body: { text: tooLong } });
    expect(webhook).toEqual({ status: 400, data: { ok: false, error: "msg_too_long" } });

    // An app's answer to a command, at once and later through its response_url.
    app!.answer = JSON.stringify({ response_type: "in_channel", text: tooLong });
    const command = await call<{ ok: boolean; error: string; message: string }>(
      `/api/channels/${channelId}/commands`,
      { token: owner, body: { text: "/deploy" } },
    );
    expect(command.data).toMatchObject({ ok: false, error: "command_failed" });
    expect(command.data.message).toContain("12,000 characters");
    const late = await call(app!.responseUrl, {
      body: { response_type: "in_channel", text: tooLong },
    });
    expect(late).toEqual({ status: 400, data: { ok: false, error: "msg_too_long" } });

    expect(texts(channelId)).toEqual([]);
  });

  it("takes a message of exactly the limit from an app", async () => {
    const { channelId, bot } = await start();
    const full = "y".repeat(MESSAGE_TEXT_MAX);
    const web = await call<{ ok: boolean }>("/api/chat.postMessage", {
      token: bot,
      body: { channel: channelId, text: full },
    });
    expect(web.data.ok).toBe(true);
    expect(texts(channelId)).toEqual([full]);
  });

  it("will not let an app rewrite the message a button sits on past the limit", async () => {
    const { owner, channelId, hook } = await start();
    await call(hook, {
      body: {
        text: "Ship it?",
        blocks: [
          {
            type: "actions",
            elements: [
              { type: "button", text: { type: "plain_text", text: "Ship" }, action_id: "ship" },
            ],
          },
        ],
      },
    });
    const [message] = server!.store.messages.list({ channelId, limit: 1 });
    app!.answer = JSON.stringify({ replace_original: true, text: tooLong });
    const pressed = await call<{ ok: boolean; error: string }>(
      `/api/messages/${message!.id}/actions`,
      { token: owner, body: { actionId: "ship" } },
    );
    expect(pressed.data).toEqual({ ok: false, error: "action_failed" });
    const late = await call(app!.responseUrl, { body: { replace_original: true, text: tooLong } });
    expect(late).toEqual({ status: 400, data: { ok: false, error: "msg_too_long" } });
    expect(server!.store.messages.get(message!.id)!.text).toBe("Ship it?");
  });
});

describe("the rate limit", () => {
  it("charges an app's answers in the channel to its bot's post budget", async () => {
    const { owner, channelId } = await start({ post: { burst: 1, perMinute: 1 } });
    app!.answer = JSON.stringify({ response_type: "in_channel", text: "deploying" });
    const first = await call<{ ok: boolean }>(`/api/channels/${channelId}/commands`, {
      token: owner,
      body: { text: "/deploy" },
    });
    expect(first.data.ok).toBe(true);
    const second = await call<{ ok: boolean; message: string }>(
      `/api/channels/${channelId}/commands`,
      { token: owner, body: { text: "/deploy" } },
    );
    expect(second.data).toMatchObject({ ok: false, error: "command_failed" });
    const late = await call<{ error: string }>(app!.responseUrl, {
      body: { response_type: "in_channel", text: "still deploying" },
    });
    expect(late.status).toBe(429);
    expect(texts(channelId)).toEqual(["deploying"]);

    // The person who ran it spends their own budget, which the app's answers left alone.
    const own = await call(`/api/channels/${channelId}/messages`, {
      token: owner,
      body: { text: "thanks" },
    });
    expect(own.status).toBe(201);
  });
});

describe("an incoming webhook", () => {
  it("answers a refusal as Slack's webhooks do", async () => {
    const { owner, appId, botUserId, hook } = await start();
    expect(await call(hook, { body: { text: "  " } })).toEqual({
      status: 400,
      data: { ok: false, error: "no_text" },
    });

    const room = (
      await call<{ channel: { id: string } }>("/api/channels", {
        token: owner,
        body: { name: "ops", type: "private" },
      })
    ).data.channel.id;
    const roomHook = (
      await call<{ url: string }>(`/api/apps/${appId}/webhooks`, {
        token: owner,
        body: { channelId: room },
      })
    ).data.url;
    server!.store.removeMember(room, botUserId);
    expect(await call(roomHook, { body: { text: "hello" } })).toEqual({
      status: 403,
      data: { ok: false, error: "not_in_channel" },
    });

    server!.store.addMember(room, botUserId);
    server!.store.updateChannel(room, { archived: true });
    expect(await call(roomHook, { body: { text: "hello" } })).toEqual({
      status: 404,
      data: { ok: false, error: "channel_not_found" },
    });
    expect(texts(room)).toEqual([]);
  });
});
