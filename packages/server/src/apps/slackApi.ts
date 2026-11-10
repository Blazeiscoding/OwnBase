import { endpoints, type App, type AppScope, type ID } from "@ownbase/protocol";
import type { ServerContext } from "../core/context.js";
import { hashToken } from "../auth.js";
import { slackRefusal, type Posting } from "../messages/posting.js";
import { blocksToActions, payloadToText } from "./blockKit.js";

/**
 * A failed Slack Web API call, answered the way Slack answers one: HTTP 200
 * with `ok: false`. Slack's own SDK treats every status other than 200 and
 * 429 as a transport failure and never reads the body, so a 4xx here reaches
 * a bot as a generic HTTP error instead of the `channel_not_found` it checks
 * for. Rate limiting keeps its 429, which the SDK does understand.
 */
export const slackError = (error: string) => ({ ok: false as const, error });

/** Slack's refusal for a method this token's scopes do not reach, naming what would. */
const missingScope = (owner: App, needed: AppScope) => ({
  ok: false as const,
  error: "missing_scope",
  needed,
  provided: (owner.scopes ?? []).join(","),
});

/**
 * A structured argument. Slack's SDK sends every call form-encoded, with
 * anything that is not a plain value JSON-encoded into a string, so `blocks`
 * and `view` arrive as text from the most common client of all. Read as-is,
 * a message silently lost its buttons and no modal could be opened.
 */
export const structured = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * What an app calls in Slack's shape: posting through an incoming webhook,
 * and the Web API methods `auth.test` and `chat.postMessage`. The `views.*`
 * methods are with the forms they open (views.ts).
 */
export function registerSlackApi(ctx: ServerContext, { posting }: { posting: Posting }) {
  const { store, settings, route, ration, network } = ctx;

  route(endpoints.postToWebhook, async ({ req, reply, params }) => {
    // Before the lookup, so a wrong token costs as much as a right one.
    ration("hookByAddress", network.callerAddress(req));
    const found = store.apps.webhookForToken(hashToken(params.token));
    if (!found) return reply.status(404).send({ ok: false, error: "invalid_webhook" });

    let payload: { text?: unknown; blocks?: unknown } = {};
    const raw = req.body as Record<string, unknown> | string | undefined;
    if (typeof raw === "string") {
      try {
        payload = JSON.parse(raw) as typeof payload;
      } catch {
        return reply.status(400).send({ ok: false, error: "invalid_payload" });
      }
    } else if (raw && typeof raw === "object") {
      if (typeof raw.payload === "string") {
        try {
          payload = JSON.parse(raw.payload) as typeof payload;
        } catch {
          return reply.status(400).send({ ok: false, error: "invalid_payload" });
        }
      } else {
        payload = raw as typeof payload;
      }
    }

    try {
      posting.post({
        poster: { kind: "webhook", app: found.app, webhookId: found.webhook.id },
        channelId: found.webhook.channelId,
        text: payloadToText(payload),
        threadRootId: null,
        nonce: null,
        fileIds: [],
        actions: blocksToActions(payload.blocks),
      });
    } catch (err) {
      const refused = slackRefusal(err);
      return reply.status(refused.status).send({ ok: false, error: refused.error });
    }
    // Slack replies with the literal string "ok"; tools check for it.
    return reply.type("text/plain").send("ok");
  });

  route(endpoints.authTest, async ({ req, bot: owner }) => {
    const bot = store.people.get(owner.botUserId)!;
    return {
      ok: true,
      url: `${network.requestOrigin(req)}/`,
      team: settings.get("workspaceName"),
      user: bot.handle,
      team_id: settings.get("workspaceId"),
      user_id: bot.id,
      bot_id: owner.id,
      is_enterprise_install: false,
    };
  });

  route(endpoints.chatPostMessage, async ({ req, reply, bot: owner }) => {
    reply.header("x-accepted-oauth-scopes", "chat:write");
    const body = (req.body ?? {}) as {
      channel?: unknown;
      text?: unknown;
      blocks?: unknown;
      thread_ts?: unknown;
    };
    // Slack accepts an id or a #name; so do we.
    const named = typeof body.channel === "string" ? body.channel : "";
    const channel = named
      ? (store.channels.get(named) ?? store.channels.byName(named.replace(/^#/, "")))
      : null;

    let threadRootId: ID | null = null;
    if (channel && typeof body.thread_ts === "string" && body.thread_ts) {
      const root = store.messages.get(body.thread_ts);
      // An unknown thread parent is not worth failing the whole send over.
      if (root && root.channelId === channel.id && !root.threadRootId) threadRootId = root.id;
    }

    const blocks = structured(body.blocks);
    try {
      const message = posting.post({
        poster: { kind: "bot", app: owner },
        channelId: channel?.id ?? named,
        text: payloadToText({ text: body.text, blocks }),
        threadRootId,
        nonce: null,
        fileIds: [],
        actions: blocksToActions(blocks),
      });
      // `ts` is Slack's message identifier; ours is the message id.
      return { ok: true, channel: message.channelId, ts: message.id, message };
    } catch (err) {
      const { error, needed } = slackRefusal(err);
      if (error === "missing_scope" && needed) return missingScope(owner, needed);
      return needed ? { ...slackError(error), needed } : slackError(error);
    }
  });
}
