import {
  eventScope,
  isAppEventType,
  type EventEnvelope,
  type ID,
  type WorkspaceEvent,
} from "@ownbase/protocol";
import { Store } from "../store.js";
import { appDelivery, eventChannel } from "../events/registry.js";

/** An event's Slack Events API shape, or null when no app is told of it. */
export function toSlackEvent(event: WorkspaceEvent): Record<string, unknown> | null {
  return appDelivery(event)?.slack(event) ?? null;
}

/**
 * Queues an event for every subscription that may have it, inside the
 * transaction that records it. What does not depend on the subscription is
 * worked out once per event, however many subscriptions one bot has (F11):
 * whether each bot is in the conversation, the workspace's id and the
 * callback body every one of them gets.
 */
export function enqueueAppDeliveries(
  store: Store,
  envelope: EventEnvelope,
  dropped: (subscriptionId: ID) => void,
): void {
  const event = envelope.event;
  const type = event.type;
  if (!isAppEventType(type)) return;
  const subs = store.apps.allSubscriptions();
  if (subs.length === 0) return;
  const delivery = appDelivery(event)!;
  const payload = delivery.slack(event);
  if (!payload) return;
  const actor = delivery.actor(event);
  const channelId = eventChannel(event);
  // What an app must be allowed to read to be sent this (E18c).
  const needed = eventScope(
    type,
    channelId === null ? null : (store.channels.get(channelId)?.type ?? null),
  );
  const inChannel = new Map<ID, boolean>();
  const botInChannel = (botUserId: ID, channel: ID): boolean => {
    let member = inChannel.get(botUserId);
    if (member === undefined)
      inChannel.set(botUserId, (member = store.channels.isMember(channel, botUserId)));
    return member;
  };
  let body: string | null = null;
  const callback = (): string =>
    (body ??= JSON.stringify({
      type: "event_callback",
      event_id: `Ev${envelope.seq}`,
      event_time: Math.floor(Date.now() / 1000),
      team_id: store.settings.get("workspaceId"),
      event: payload,
      // Our own event beside Slack's shape, so a native app need not
      // reverse-engineer the mapping.
      ownbase: { type, seq: envelope.seq },
    }));

  for (const { subscription, app } of subs) {
    if (subscription.eventTypes.length > 0 && !subscription.eventTypes.includes(type)) continue;
    // Never hand an app back its own bot's actions — that is how a bot that
    // replies to messages ends up replying to itself forever.
    if (actor !== null && actor === app.botUserId) continue;
    // Nor what its scopes do not let it read, whatever it subscribed to.
    if (!app.scopes?.includes(needed)) continue;
    // An app sees a conversation only once its bot has been added to it, so
    // subscribing does not quietly expose every private conversation.
    if (channelId !== null && !botInChannel(app.botUserId, channelId)) continue;

    const queued = store.deliveries.enqueue(
      subscription.id,
      channelId,
      envelope.seq,
      callback(),
      Date.now(),
      Store.eventMessageId(event),
    );
    if (!queued) dropped(subscription.id);
  }
}
