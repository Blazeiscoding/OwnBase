import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { WebClient, type WebAPIPlatformError } from "@slack/web-api";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Slack's own SDK, pointed at this server. The API claims that an integration
 * written for Slack works by changing its URL; this is the client most of them
 * are written with, so it is the one that has to agree.
 */

let server: WorkspaceServer;
let base: string;
let ownerToken: string;
let bot: { appId: string; botUserId: string; token: string };
let channelId: string;
let client: WebClient;

/** An app endpoint that records slash command payloads and answers nothing. */
let appEndpoint: Server;
let lastCommand: URLSearchParams | null = null;

async function call<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/** The error a platform-level refusal surfaces as, or the first thing thrown. */
async function refusal(pending: Promise<unknown>): Promise<WebAPIPlatformError> {
  try {
    await pending;
  } catch (err) {
    return err as WebAPIPlatformError;
  }
  throw new Error("the call succeeded");
}

beforeAll(async () => {
  appEndpoint = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastCommand = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200);
      res.end("");
    });
  });
  await new Promise<void>((r) => appEndpoint.listen(0, "127.0.0.1", r));

  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    allowPrivateHooks: true,
    logger: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  const owner = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
  });
  ownerToken = ((await owner.json()) as { token: string }).token;
  const made = await call<{ app: { id: string }; botUser: { id: string }; token: string }>(
    "/api/apps",
    ownerToken,
    { name: "SDK Bot" },
  );
  bot = { appId: made.app.id, botUserId: made.botUser.id, token: made.token };
  channelId = server.store.getChannelByName("general")!.id;
  server.store.addMember(channelId, bot.botUserId);
  // No retries: a failure should be reported here, not retried into a timeout.
  client = new WebClient(bot.token, {
    slackApiUrl: `${base}/api/`,
    retryConfig: { retries: 0 },
  });
});

afterAll(async () => {
  await server.stop();
  await new Promise<void>((r) => appEndpoint.close(() => r()));
});

describe("Slack's SDK against this server", () => {
  it("can run auth.test, which Bolt calls before it will start", async () => {
    const result = await client.auth.test();
    expect(result.ok).toBe(true);
    // What Bolt reads to recognise its own messages.
    expect(result.user_id).toBe(bot.botUserId);
    expect(result.bot_id).toBe(bot.appId);
    expect(result.team_id).toBe(server.store.getMeta("workspace_id"));
    expect(result.url).toBe(`${base}/`);
  });

  it("keeps a message's buttons, which the SDK sends as a JSON string", async () => {
    const result = await client.chat.postMessage({
      channel: channelId,
      text: "Ship it?",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Ship it?" } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "approve",
              text: { type: "plain_text", text: "Approve" },
              value: "yes",
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    const stored = server.store.getMessage(result.ts!)!;
    expect(stored.actions.map((a) => a.actionId)).toEqual(["approve"]);
  });

  it("posts a message given only blocks, as Slack does", async () => {
    const result = await client.chat.postMessage({
      channel: channelId,
      text: "",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "from blocks alone" } }],
    });
    expect(server.store.getMessage(result.ts!)!.text).toBe("from blocks alone");
  });

  it("reports a refusal by name, not as a failure to connect", async () => {
    const err = await refusal(client.chat.postMessage({ channel: "#nowhere", text: "hello" }));
    // An HTTP 404 here would arrive as slack_webapi_http_error, with the error
    // code a bot checks for left unread in the body.
    expect(err.code).toBe("slack_webapi_platform_error");
    expect(err.data.error).toBe("channel_not_found");
  });

  it("reports a token it does not know as invalid_auth", async () => {
    const stranger = new WebClient("xoxb-not-a-real-token", {
      slackApiUrl: `${base}/api/`,
      retryConfig: { retries: 0 },
    });
    const err = await refusal(stranger.auth.test());
    expect(err.code).toBe("slack_webapi_platform_error");
    expect(err.data.error).toBe("invalid_auth");
  });

  it("names a method this server does not implement", async () => {
    const err = await refusal(client.chat.update({ channel: channelId, ts: "1", text: "x" }));
    expect(err.code).toBe("slack_webapi_platform_error");
    expect(err.data.error).toBe("unknown_method");
  });

  it("opens a modal, whose view the SDK also sends as a JSON string", async () => {
    await call(`/api/apps/${bot.appId}/commands`, ownerToken, {
      command: "/deploy",
      url: `http://127.0.0.1:${(appEndpoint.address() as { port: number }).port}/command`,
    });
    lastCommand = null;
    await call(`/api/channels/${channelId}/commands`, ownerToken, { text: "/deploy" });
    const triggerId = lastCommand!.get("trigger_id")!;
    expect(triggerId).toBeTruthy();

    const opened = await client.views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "deploy",
        title: { type: "plain_text", text: "Deploy" },
        submit: { type: "plain_text", text: "Go" },
        blocks: [
          {
            type: "input",
            block_id: "target",
            label: { type: "plain_text", text: "Where to" },
            element: { type: "plain_text_input", action_id: "value" },
          },
        ],
      },
    });
    expect(opened.ok).toBe(true);
    expect((opened.view as { callback_id?: string }).callback_id).toBe("deploy");
  });

  it("shows Loading at once and the form after, with views.update as the SDK sends it", async () => {
    lastCommand = null;
    await call(`/api/channels/${channelId}/commands`, ownerToken, { text: "/deploy" });
    const loading = await client.views.open({
      trigger_id: lastCommand!.get("trigger_id")!,
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Deploy" },
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "Loading…" } }],
      },
    });
    const { id, hash } = loading.view as { id: string; hash: string };

    const form = {
      type: "modal" as const,
      callback_id: "deploy",
      title: { type: "plain_text" as const, text: "Deploy" },
      submit: { type: "plain_text" as const, text: "Go" },
      blocks: [
        {
          type: "input" as const,
          block_id: "target",
          label: { type: "plain_text" as const, text: "Where to" },
          element: { type: "plain_text_input" as const, action_id: "value" },
        },
      ],
    };
    const updated = await client.views.update({ view_id: id, hash, view: form });
    expect(updated.ok).toBe(true);
    expect((updated.view as { id: string; hash: string }).id).toBe(id);
    expect((updated.view as { hash: string }).hash).not.toBe(hash);

    // The SDK reports a stale hash by name, as Slack's does.
    const stale = await refusal(client.views.update({ view_id: id, hash, view: form }));
    expect(stale.data.error).toBe("hash_conflict");
  });
});

describe("a token sent the other way Slack accepts", () => {
  it("works as a form field when there is no Authorization header", async () => {
    const res = await fetch(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: bot.token, channel: channelId, text: "form token" }),
    });
    const body = (await res.json()) as { ok: boolean; ts: string };
    expect(body.ok).toBe(true);
    expect(server.store.getMessage(body.ts)!.userId).toBe(bot.botUserId);
  });
});
