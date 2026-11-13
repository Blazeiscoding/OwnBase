import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  endpoints,
  isDirect,
  notificationWords,
  notifyDecision,
  reminderNotifyDecision,
  type Channel,
  type EventEnvelope,
  type Message,
  type PushPreview,
  type User,
} from "@ownbase/protocol";
import { hashToken } from "../auth.js";
import type { ServerContext } from "../core/context.js";
import { bearerToken } from "../core/network.js";
import { HttpError } from "../httpError.js";
import { isPrivateAddress, postBytes } from "../outbound.js";
import { PUSH_LIMITS, PushSender } from "./sender.js";
import type { PushSubscription } from "./store.js";
import { MAX_PUSH_PLAINTEXT, validSubscriptionKeys, type VapidKeys } from "./webPush.js";

/** Who runs the server, as push services are told, unless `--push-contact` says. */
export const DEFAULT_PUSH_CONTACT = "https://ownbase.site";
/** The most of a message's words a push carries. */
export const PUSH_BODY_LENGTH = 180;

/** What the service worker is handed: what to show, and where a click goes. */
export interface PushPayload {
  title: string;
  body: string;
  /** One notification per conversation: a newer push replaces the one before. */
  tag: string;
  channelId: string;
  messageId: string;
}

/** Cut at a whole character, with an ellipsis, so a long message stays one line or two. */
export function cutWords(text: string, max = PUSH_BODY_LENGTH): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * The words of a push, as the page's own notification would say them under
 * each choice of how much to show (ui's notificationContent and
 * reminderContent).
 */
export function pushWords(
  preview: PushPreview,
  kind: "message" | "reminder",
  message: { from: string; channelName?: string; body: string },
): { title: string; body: string } {
  if (preview === "none")
    return kind === "message"
      ? { title: "New message", body: "Open OwnBase to read it." }
      : { title: "Reminder", body: "Open OwnBase to see it." };
  const where = `${message.from}${message.channelName ? ` in #${message.channelName}` : ""}`;
  if (kind === "reminder")
    return {
      title: `Reminder: ${where}`,
      body: preview === "full" ? message.body : "About a message",
    };
  return { title: where, body: preview === "full" ? message.body : "New message" };
}

/**
 * Pushes to browsers that are closed (G09): the server's key, each session's
 * subscription, and a push for each message or reminder the notify rule says
 * should reach someone with no open connection. The page notifies while it
 * is open, so a person online gets nothing from here.
 */
export function registerPush(ctx: ServerContext) {
  const { store, route, opts, gateway, lifecycle, log } = ctx;
  const limits = { ...PUSH_LIMITS, ...opts.pushLimits };
  let keys: VapidKeys | null = null;
  const serverKeys = () => (keys ??= store.settings.get("pushKeys"));

  const sender = new PushSender({
    post: (url, body, headers) =>
      postBytes(url, body, headers, {
        allowPrivate: opts.allowPrivateHooks,
        signal: lifecycle.signal,
        timeoutMs: limits.timeoutMs,
        maxBytes: 4096,
      }),
    keys: serverKeys,
    subject: opts.pushContact ?? DEFAULT_PUSH_CONTACT,
    limits,
    log,
    gone: (endpoint) => store.push.removeEndpoint(endpoint),
  });
  lifecycle.onClose(() => sender.close());

  /** When each person last had a push about each conversation. */
  const lastPushed = new Map<string, number>();
  lifecycle.hourly(() => {
    const now = Date.now();
    for (const [key, at] of lastPushed) if (now - at >= limits.gapMs) lastPushed.delete(key);
  });
  const spaced = (userId: string, channelId: string, now: number) => {
    const key = `${userId} ${channelId}`;
    const last = lastPushed.get(key);
    if (last !== undefined && now - last < limits.gapMs) return false;
    lastPushed.set(key, now);
    return true;
  };

  const nameOf = (id: string) => store.people.get(id)?.displayName;
  const labels = {
    user: (id: string) => {
      const name = nameOf(id);
      return name ? `@${name}` : "@someone";
    },
    channel: (id: string) => `#${store.channels.get(id)?.name || "unknown"}`,
  };

  const deliver = (
    user: User,
    kind: "message" | "reminder",
    message: Message,
    channel: Channel,
    tag: string,
  ) => {
    const from = nameOf(message.userId) ?? "Someone";
    const channelName = isDirect(channel.type) ? undefined : channel.name || undefined;
    const body = cutWords(notificationWords(message, labels));
    for (const subscription of store.push.forUser(user.id)) {
      const words = pushWords(subscription.preview, kind, { from, channelName, body });
      const payload: PushPayload = {
        ...words,
        tag,
        channelId: message.channelId,
        messageId: message.id,
      };
      const json = JSON.stringify(payload);
      if (Buffer.byteLength(json) > MAX_PUSH_PLAINTEXT) continue;
      sender.send(subscription, json, kind === "reminder" ? "high" : "normal");
    }
  };

  /** Whom one new message pushes to, and the pushes, after it was committed. */
  const messagePosted = (message: Message) => {
    const channel = store.channels.get(message.channelId);
    if (!channel) return;
    const now = Date.now();
    let recipients = 0;
    for (const userId of store.push.membersWithSubscriptions(message.channelId)) {
      if (recipients >= limits.recipientsPerMessage) break;
      // Someone with the app open is notified by it.
      if (userId === message.userId || gateway.isOnline(userId)) continue;
      const user = store.people.get(userId);
      if (!user || user.deactivated) continue;
      const prefs = store.channels.prefs(message.channelId, userId);
      const decision = notifyDecision({
        selfId: userId,
        message,
        senderBlocked: store.people.blockedIds(userId).includes(message.userId),
        channelType: prefs ? channel.type : null,
        prefs: prefs ?? undefined,
        notifyDefault: store.channels.notifyDefault(userId),
        threadMuted:
          message.threadRootId !== null &&
          store.threads.follow(userId, message.threadRootId)?.muted === true,
        dndUntil: user.dndUntil,
        now,
        // Nobody without an open connection is "here".
        live: false,
      });
      if (!decision.notify) continue;
      recipients++;
      if (!spaced(userId, message.channelId, now)) continue;
      deliver(user, "message", message, channel, `c:${message.channelId}`);
    }
  };

  // An isolated copy is someone's look at a backup: it must not ring the real people.
  const pushing = !opts.isolated;
  /** New messages committed since the last turn, worked through on the next. */
  const posted: Message[] = [];
  const later = lifecycle.laterTurn(() => {
    for (const message of posted.splice(0))
      ctx.background.afterCommitted("push a new message", () => messagePosted(message));
  });
  ctx.onPublished((events: readonly EventEnvelope[]) => {
    if (!pushing) return;
    for (const { event } of events)
      if (event.type === "message.created") posted.push(event.message);
    if (posted.length > 0) later();
  });

  route(endpoints.pushKey, async () => ({ publicKey: serverKeys().publicKey }));

  route(endpoints.addPushSubscription, async ({ req, user: me, body }) => {
    const { endpoint, keys: subscriptionKeys, preview } = body;
    await checkEndpoint(endpoint, opts.allowPrivateHooks === true);
    if (!validSubscriptionKeys(subscriptionKeys.p256dh, subscriptionKeys.auth))
      throw new HttpError(400, "push_keys_invalid", "The browser's push keys could not be read.");
    const subscription: PushSubscription = {
      endpoint,
      userId: me.id,
      p256dh: subscriptionKeys.p256dh,
      auth: subscriptionKeys.auth,
      preview,
    };
    store.push.add(hashToken(bearerToken(req)!), subscription);
    return { ok: true as const };
  });

  route(endpoints.removePushSubscription, async ({ req }) => {
    store.push.removeSession(hashToken(bearerToken(req)!));
    return { ok: true as const };
  });

  return {
    /** A reminder came due for someone: pushed when they have no connection open. */
    reminderDue: (userId: string, message: Message) => {
      if (!pushing || gateway.isOnline(userId)) return;
      const user = store.people.get(userId);
      const channel = store.channels.get(message.channelId);
      if (!user || user.deactivated || !channel) return;
      if (!reminderNotifyDecision(user.dndUntil, Date.now()).notify) return;
      deliver(user, "reminder", message, channel, `r:${message.id}`);
    },
    /** Resolves once every push asked for so far has been sent or given up. */
    settled: () => sender.settled(),
    counts: () => ({ ...sender.counts, subscriptions: store.push.count() }),
  };
}

/**
 * A push service is a public host reached over HTTPS. One on a private
 * network is refused here, when it is kept, as well as by the outbound guard
 * when a push goes, unless the server allows private hooks.
 */
async function checkEndpoint(endpoint: string, allowPrivate: boolean): Promise<void> {
  const refuse = (message: string) => {
    throw new HttpError(400, "push_endpoint_refused", message);
  };
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return refuse("That push address could not be read.");
  }
  if (url.username || url.password) refuse("A push address cannot carry a name or password.");
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:"))
    refuse("A push address must use HTTPS.");
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host) !== 0) addresses = [host];
  else {
    try {
      addresses = (await lookup(host, { all: true })).map((found) => found.address);
    } catch {
      return refuse("That push address could not be found.");
    }
  }
  if (addresses.some(isPrivateAddress))
    refuse("That push address is on a private network, which this server does not send to.");
}
