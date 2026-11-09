import { endpoints, type ID, type Message } from "@ownbase/protocol";
import { hashToken } from "../auth.js";
import { requireChannelAccess, type ServerContext } from "../core/context.js";
import type { registerFiles } from "../files/feature.js";
import { HttpError } from "../httpError.js";
import { secretToken } from "../ids.js";
import { CAPABILITIES_ALIVE } from "../limits.js";
import type { registerMessages } from "../messages/feature.js";
import { requireMessageText, slackRefusal } from "../messages/posting.js";
import { blocksToActions, payloadToText } from "./blockKit.js";
import type { AppCalls } from "./calls.js";
import { CapabilityMap } from "../core/capabilities.js";
import type { NewTrigger } from "./views.js";

/**
 * Where a reply sent to a `response_url` lands. Slack allows up to thirty
 * minutes and five uses of a `response_url`; so do we. Purely in memory — a
 * reply that outlives a restart is not worth a table.
 */
export interface ResponseTarget {
  channelId: ID;
  invokerId: ID;
  botUserId: ID;
  threadRootId: ID | null;
  /**
   * The message whose button was pressed, when there was one. A later reply
   * may rewrite or remove it just as an immediate answer can: Bolt always
   * acknowledges a press at once with an empty body and rewrites the message
   * afterwards through this url, so honouring `replace_original` only in the
   * immediate answer turned "Approve" into a second message instead.
   */
  originMessageId?: ID;
  /** The version pressed: a delayed reply cannot replace a subsequent edit. */
  originRevision?: { value: string };
  expiresAt: number;
  usesLeft: number;
}

export type ReplyTarget = Omit<ResponseTarget, "expiresAt" | "usesLeft">;

/**
 * What an app answers with, now or later through a `response_url`, and the
 * buttons it put on its messages that people press.
 */
export function registerAppReplies(
  ctx: ServerContext,
  deps: {
    calls: AppCalls;
    newTrigger: NewTrigger;
    messages: Pick<
      ReturnType<typeof registerMessages>,
      "posting" | "updateMessage" | "removeMessage"
    >;
    files: Pick<ReturnType<typeof registerFiles>, "flushFileDeletions">;
  },
) {
  const { store, settings, route, network } = ctx;
  const { calls, newTrigger, messages, files } = deps;
  const { posting } = messages;

  const responseTargets = new CapabilityMap<ResponseTarget>(CAPABILITIES_ALIVE.responseUrls);
  const messageRevision = (message: Message): string =>
    hashToken(JSON.stringify([message.text, message.editedAt, message.actions]));

  const newResponseUrl = (target: ReplyTarget, origin: string): string => {
    const now = Date.now();
    const token = secretToken();
    responseTargets.set(token, { ...target, expiresAt: now + 30 * 60_000, usesLeft: 5 }, now);
    return `${origin}/api/commands/response/${token}`;
  };

  /**
   * Turns whatever an app answered with into a message. `in_channel` posts for
   * everyone as the bot; anything else stays private to the person who typed
   * the command, which is Slack's default and the safer one. An answer that
   * may not be posted throws its refusal, for the caller to answer in its
   * own shape.
   */
  const deliverReply = (
    target: ReplyTarget,
    raw: string,
    contentType: string,
    /** The message a button lives on, which the app may ask to replace. */
    originMessageId?: ID,
  ): void => {
    const trimmed = raw.trim();
    if (!trimmed) return; // an empty 200 is a silent acknowledgement
    // The app had its seconds to answer; a lot can be revoked in them.
    if (!calls.capabilityHolds(target)) return;

    let payload: {
      text?: unknown;
      blocks?: unknown;
      response_type?: unknown;
      replace_original?: unknown;
      delete_original?: unknown;
    } = {};
    if (contentType.includes("json") || trimmed.startsWith("{")) {
      try {
        payload = JSON.parse(trimmed) as typeof payload;
      } catch {
        payload = { text: trimmed };
      }
    } else {
      payload = { text: trimmed };
    }

    // Slack lets a button's handler rewrite the message it sits on, which is
    // how "Approve" becomes "Approved by @alice" with the buttons gone.
    if (
      originMessageId &&
      (payload.replace_original === true || payload.delete_original === true)
    ) {
      const existing = store.messages.get(originMessageId);
      // Replacement/deletion is a no-op when the origin disappeared or
      // changed while the app answered. Never reinterpret it as a new post.
      if (
        !existing ||
        (target.originRevision && target.originRevision.value !== messageRevision(existing))
      )
        return;
      if (payload.delete_original === true) {
        messages.removeMessage(existing);
        void files.flushFileDeletions();
        return;
      }
      const replacement = payloadToText(payload);
      if (replacement) {
        requireMessageText(replacement);
        const updated = messages.updateMessage(existing, replacement, true);
        // An app may use this response URL again to update its own result;
        // only intervening changes from another operation invalidate it.
        if (target.originRevision) target.originRevision.value = messageRevision(updated);
      }
      return;
    }

    const text = payloadToText(payload);
    if (!text) return;

    if (payload.response_type === "in_channel") {
      posting.post({
        poster: { kind: "appReply", botUserId: target.botUserId },
        channelId: target.channelId,
        text,
        threadRootId: target.threadRootId,
        nonce: null,
        fileIds: [],
        actions: blocksToActions(payload.blocks),
      });
    } else {
      calls.sayEphemeral(target.channelId, target.invokerId, target.botUserId, text);
    }
  };

  route(endpoints.commandResponse, async ({ req, reply, params }) => {
    const target = responseTargets.get(params.token);
    if (!target || target.expiresAt < Date.now() || !calls.capabilityHolds(target)) {
      // A url whose app, channel or audience has gone is spent, not merely
      // unusable this once: keeping it would only invite the same call again.
      responseTargets.delete(params.token);
      return reply.status(404).send({ ok: false, error: "expired_url" });
    }
    if (--target.usesLeft <= 0) responseTargets.delete(params.token);

    const raw = req.body;
    const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
    try {
      deliverReply(target, text, "application/json", target.originMessageId);
    } catch (err) {
      const refused = slackRefusal(err);
      return reply.status(refused.status).send({ ok: false, error: refused.error });
    }
    return { ok: true };
  });

  route(endpoints.runMessageAction, async ({ req, user: me, body, params }) => {
    const message = store.messages.get(params.id);
    if (!message) throw new HttpError(404, "message_not_found");
    const channel = requireChannelAccess(store, message.channelId, me);
    if (channel.archived) throw new HttpError(400, "channel_archived");

    const action = message.actions.find((a) => a.actionId === body.actionId);
    // A stale button — the message was edited or its buttons cleared — is a
    // 404 rather than a silent success, so the UI can say so.
    if (!action) throw new HttpError(404, "action_not_found");
    // A link button is handled entirely in the client; nothing to call.
    if (action.url) throw new HttpError(400, "link_action");

    const owner = store.apps.forBotUser(message.userId);
    if (!owner) throw new HttpError(400, "not_an_app_message");
    if (!owner.interactivityUrl) throw new HttpError(400, "no_interactivity_url");

    const release = calls.admit(me.id, owner.id);
    try {
      const target = {
        channelId: channel.id,
        invokerId: me.id,
        botUserId: owner.botUserId,
        threadRootId: message.threadRootId,
        originRevision: { value: messageRevision(message) },
      };
      const responseUrl = newResponseUrl(
        { ...target, originMessageId: message.id },
        network.requestOrigin(req),
      );
      const payload = JSON.stringify({
        type: "block_actions",
        // Slack sends this as a form field named payload; so do we below.
        team: { id: settings.get("workspaceId"), domain: settings.get("workspaceName") },
        user: { id: me.id, username: me.handle, name: me.displayName },
        api_app_id: owner.id,
        channel: { id: channel.id, name: channel.name },
        message: { ts: message.id, text: message.text, user: message.userId },
        container: { type: "message", message_ts: message.id, channel_id: channel.id },
        trigger_id: newTrigger({
          userId: me.id,
          channelId: channel.id,
          appId: owner.id,
          botUserId: owner.botUserId,
        }),
        response_url: responseUrl,
        actions: [
          {
            type: "button",
            action_id: action.actionId,
            block_id: action.blockId,
            text: { type: "plain_text", text: action.text },
            value: action.value,
            style: action.style === "default" ? undefined : action.style,
            action_ts: String(Date.now() / 1000),
          },
        ],
      });
      const form = new URLSearchParams({ payload }).toString();

      try {
        const res = await calls.postForm(owner.id, owner.interactivityUrl, form);
        if (res.status < 200 || res.status >= 300) {
          calls.sayEphemeral(
            channel.id,
            me.id,
            owner.botUserId,
            `That button failed: the app answered ${res.status}.`,
          );
          return { ok: false, error: "action_failed" };
        }
        deliverReply(target, res.body, res.contentType, message.id);
        return { ok: true };
      } catch (err) {
        const why = calls.whyFailed(err);
        calls.sayEphemeral(channel.id, me.id, owner.botUserId, `That button failed: ${why}.`);
        return { ok: false, error: "action_failed" };
      }
    } finally {
      release();
    }
  });

  return { newResponseUrl, deliverReply };
}

export type AppReplies = ReturnType<typeof registerAppReplies>;
