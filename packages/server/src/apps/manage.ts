import { endpoints } from "@ownbase/protocol";
import { hashPassword, hashToken } from "../auth.js";
import { requireChannelAccess, type ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";
import { secretToken } from "../ids.js";
import type { AppCalls } from "./calls.js";
import type { EventDeliveries } from "./deliveries.js";

/**
 * The host of a URL an admin gave an app, for the audit log. The whole URL
 * stays out: webhook and callback URLs often carry a secret in their path.
 */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/**
 * What an administrator does to apps: making them, their scopes and secrets,
 * their incoming webhooks, the URL their buttons and forms call, and the
 * event subscriptions they are sent.
 */
export function registerAppManagement(
  ctx: ServerContext,
  deps: {
    calls: AppCalls;
    deliveries: EventDeliveries;
  },
) {
  const { store, route, requireUser, mutate } = ctx;
  const { calls, deliveries } = deps;

  /** A handle for the app's bot user that cannot collide with a person's. */
  const botHandle = (name: string): string => {
    const base =
      name
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-|-$/g, "")
        .slice(0, 24) || "bot";
    let handle = `${base}-bot`;
    let n = 2;
    while (store.people.authByHandle(handle)) handle = `${base}-bot-${n++}`;
    return handle;
  };

  route(endpoints.createApp, async ({ req, user: me, body }) => {
    // A bot posts as a real (non-human) user, so messages render normally.
    const credentials = await hashPassword(secretToken());
    requireUser(req);
    return mutate((emit) => {
      const { hash, salt } = credentials;
      const bot = store.apps.createBotUser(botHandle(body.name), body.name, hash, salt);
      const signingSecret = secretToken();
      const created = store.apps.create({
        name: body.name,
        botUserId: bot.id,
        createdBy: me.id,
        signingSecret,
        scopes: body.scopes,
      });

      const token = secretToken("xoxb-");
      store.apps.addToken(created.id, hashToken(token));
      store.audit.record({
        actorId: me.id,
        action: "app.created",
        targetType: "app",
        targetId: created.id,
        details: { name: created.name, scopes: created.scopes.join(", ") },
      });
      emit({ type: "user.joined", user: bot });

      // The bot token is shown once and only stored hashed; the signing secret
      // stays readable to admins because verification needs the key itself.
      return { app: created, botUser: bot, token, signingSecret };
    });
  });

  route(endpoints.listApps, async () => ({
    apps: store.apps.list().map((a) => ({
      ...a,
      webhooks: store.apps.listWebhooks(a.id),
      commands: store.apps.listCommands(a.id),
      subscriptions: store.apps.listSubscriptions(a.id),
      signingSecret: store.apps.signingSecret(a.id) ?? "",
    })),
  }));

  route(endpoints.setAppScopes, async ({ user: me, body, params }) =>
    store.transaction(() => {
      const target = store.apps.get(params.id);
      if (!target) throw new HttpError(404, "not_found");
      const before = target.scopes;
      store.apps.setScopes(target.id, body.scopes);
      const after = store.apps.get(target.id)!;
      const added = after.scopes.filter((scope) => !before.includes(scope));
      const removed = before.filter((scope) => !after.scopes.includes(scope));
      if (added.length > 0 || removed.length > 0) {
        store.audit.record({
          actorId: me.id,
          action: "app.scopes_changed",
          targetType: "app",
          targetId: target.id,
          details: { name: target.name, added: added.join(", "), removed: removed.join(", ") },
        });
      }
      return { app: after };
    }),
  );

  route(endpoints.replaceAppToken, async ({ req, user: me, params }) => {
    const target = store.apps.get(params.id);
    if (!target) throw new HttpError(404, "not_found");
    const token = secretToken("xoxb-");
    store.transaction(() => {
      store.apps.replaceTokens(target.id, hashToken(token));
      store.audit.record({
        actorId: me.id,
        action: "app.token_replaced",
        targetType: "app",
        targetId: target.id,
        details: { name: target.name },
      });
    });
    req.log.info({ appId: target.id, by: me.id }, "app bot token replaced");
    return { token };
  });

  route(endpoints.replaceSigningSecret, async ({ req, user: me, params }) => {
    const target = store.apps.get(params.id);
    if (!target) throw new HttpError(404, "not_found");
    const signingSecret = secretToken();
    store.transaction(() => {
      store.apps.setSigningSecret(target.id, signingSecret);
      store.audit.record({
        actorId: me.id,
        action: "app.signing_secret_replaced",
        targetType: "app",
        targetId: target.id,
        details: { name: target.name },
      });
    });
    req.log.info({ appId: target.id, by: me.id }, "app signing secret replaced");
    return { signingSecret };
  });

  route(endpoints.deleteApp, async ({ user: me, params }) => {
    const target = store.apps.get(params.id);
    if (!target) throw new HttpError(404, "not_found");
    store.transaction(() => {
      store.apps.delete(target.id);
      store.audit.record({
        actorId: me.id,
        action: "app.deleted",
        targetType: "app",
        targetId: target.id,
        details: { name: target.name },
      });
    });
    return { ok: true };
  });

  // ---------- incoming webhooks ----------

  route(endpoints.createWebhook, async ({ user: me, body, params }) => {
    const owner = store.apps.get(params.id);
    if (!owner) throw new HttpError(404, "not_found");
    const channel = requireChannelAccess(store, body.channelId, me);

    const token = secretToken();
    const webhook = mutate((emit) => {
      const created = store.apps.createWebhook({
        appId: owner.id,
        channelId: channel.id,
        tokenHash: hashToken(token),
      });
      store.audit.record({
        actorId: me.id,
        action: "webhook.created",
        targetType: "webhook",
        targetId: created.id,
        details: { appId: owner.id, name: owner.name, channelId: channel.id },
      });
      // The bot must be in the channel to post to it.
      if (store.channels.addMember(channel.id, owner.botUserId)) {
        emit({ type: "member.joined", channelId: channel.id, userId: owner.botUserId });
      }
      return created;
    });
    return { webhook, url: `/hooks/${token}` };
  });

  route(endpoints.replaceWebhookUrl, async ({ req, user: me, params }) => {
    const token = secretToken();
    const webhook = store.transaction(() => {
      const replaced = store.apps.replaceWebhookToken(params.id, hashToken(token));
      if (replaced) {
        store.audit.record({
          actorId: me.id,
          action: "webhook.url_replaced",
          targetType: "webhook",
          targetId: replaced.id,
          details: {
            appId: replaced.appId,
            name: store.apps.get(replaced.appId)?.name ?? null,
            channelId: replaced.channelId,
          },
        });
      }
      return replaced;
    });
    if (!webhook) throw new HttpError(404, "not_found");
    req.log.info(
      { webhookId: webhook.id, appId: webhook.appId, by: me.id },
      "webhook url replaced",
    );
    return { webhook, url: `/hooks/${token}` };
  });

  route(endpoints.deleteWebhook, async ({ user: me, params }) => {
    const deleted = store.transaction(() => {
      const webhook = store.apps.getWebhook(params.id);
      if (!webhook || !store.apps.deleteWebhook(webhook.id)) return false;
      store.audit.record({
        actorId: me.id,
        action: "webhook.deleted",
        targetType: "webhook",
        targetId: webhook.id,
        details: {
          appId: webhook.appId,
          name: store.apps.get(webhook.appId)?.name ?? null,
          channelId: webhook.channelId,
        },
      });
      return true;
    });
    if (!deleted) throw new HttpError(404, "not_found");
    return { ok: true };
  });

  // ---------- where buttons and forms are sent ----------

  route(endpoints.setInteractivityUrl, async ({ req, body, params }) => {
    const owner = store.apps.get(params.id);
    if (!owner) throw new HttpError(404, "not_found");

    const record = (url: string) =>
      store.transaction(() => {
        // Verification waited on another server; access and the app may have
        // changed while this request was away from the event loop.
        const me = requireUser(req);
        const current = store.apps.get(owner.id);
        if (!current) throw new HttpError(404, "not_found");
        store.apps.setInteractivityUrl(current.id, url);
        store.audit.record({
          actorId: me.id,
          action: "app.interactivity_url_changed",
          targetType: "app",
          targetId: current.id,
          details: url
            ? { name: current.name, host: hostOf(url) }
            : { name: current.name, cleared: true },
        });
        return store.apps.get(current.id)!;
      });
    if (!body.url) {
      return { app: record("") };
    }
    await calls.verifyCallbackUrl(body.url, owner.id);
    return { app: record(body.url) };
  });

  // ---------- outgoing event subscriptions ----------

  route(endpoints.createSubscription, async ({ req, body, params }) => {
    const owner = store.apps.get(params.id);
    if (!owner) throw new HttpError(404, "not_found");

    await calls.verifyCallbackUrl(body.url, owner.id);

    const subscription = store.transaction(() => {
      const me = requireUser(req);
      const current = store.apps.get(owner.id);
      if (!current) throw new HttpError(404, "not_found");
      const created = store.apps.createSubscription({
        appId: current.id,
        url: body.url,
        eventTypes: body.eventTypes ?? [],
      });
      store.audit.record({
        actorId: me.id,
        action: "subscription.created",
        targetType: "subscription",
        targetId: created.id,
        details: { appId: current.id, name: current.name, host: hostOf(body.url) },
      });
      return created;
    });
    return { subscription };
  });

  route(endpoints.deleteSubscription, async ({ user: me, params }) => {
    const deleted = store.transaction(() => {
      const subscription = store.apps.getSubscription(params.id);
      if (!subscription || !store.apps.deleteSubscription(subscription.id)) return false;
      store.audit.record({
        actorId: me.id,
        action: "subscription.deleted",
        targetType: "subscription",
        targetId: subscription.id,
        details: {
          appId: subscription.appId,
          name: store.apps.get(subscription.appId)?.name ?? null,
          host: hostOf(subscription.url),
        },
      });
      return true;
    });
    if (!deleted) throw new HttpError(404, "not_found");
    return { ok: true };
  });

  route(endpoints.retrySubscription, async ({ user: me, params }) => {
    const subscription = store.apps.getSubscription(params.id);
    if (!subscription) throw new HttpError(404, "not_found");
    const { retried, waiting } = store.transaction(() => {
      const result = store.deliveries.retryFailed(subscription.id);
      store.audit.record({
        actorId: me.id,
        action: "subscription.retried",
        targetType: "subscription",
        targetId: subscription.id,
        details: {
          appId: subscription.appId,
          name: store.apps.get(subscription.appId)?.name ?? null,
          retried: result.retried,
          waiting: result.waiting,
        },
      });
      return result;
    });
    deliveries.soon();
    return { ok: true, retried, waiting };
  });
}
