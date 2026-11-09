import type { DurableRegistry, EphemeralRegistry } from "../events/registry.js";

/**
 * The events of messages, reactions and threads. `ts` in a Slack shape
 * is our message id: Slack treats it as opaque, and ours sorts the same way
 * theirs does.
 */
export const messageDurable = {
  "message.created": {
    channel: (event) => event.message.channelId,
    effects(event, seq, store) {
      const message = event.message;
      store.stampMessageSeq(
        message.id,
        message.channelId,
        seq,
        !message.threadRootId || message.broadcast === true,
      );
      message.seq = seq;
      if (message.threadRootId) {
        // Every way a reply can be written arrives here, so following belongs
        // here too rather than in each of the routes that can create one.
        store.threads.autoFollow(message.threadRootId, message.userId, seq);
        const root = store.getMessage(message.threadRootId);
        store.threads.tellFollowers(message.threadRootId, [
          message.userId,
          ...(root ? [root.userId] : []),
        ]);
      }
      const named = store.mentionedMemberIds(message.channelId, message.text, message.userId);
      // A reply that notified the author of what it answers counts for them.
      const pinged = message.replyTo?.ping ? message.replyTo.userId : null;
      store.outbox.mentions(
        pinged && !named.includes(pinged) && store.isMember(message.channelId, pinged)
          ? [...named, pinged]
          : named,
      );
    },
    app: {
      actor: (event) => event.message.userId,
      slack: ({ message: m }) => ({
        type: "message",
        channel: m.channelId,
        user: m.userId,
        text: m.text,
        ts: m.id,
        ...(m.threadRootId ? { thread_ts: m.threadRootId } : {}),
      }),
    },
  },
  "message.updated": {
    channel: (event) => event.message.channelId,
    app: {
      actor: (event) => event.message.userId,
      slack: (event) =>
        // Previews found or removed, and a poll's votes, change nothing an app was told (E2, E6).
        event.previewsOnly || event.pollOnly
          ? null
          : {
              type: "message",
              subtype: "message_changed",
              channel: event.message.channelId,
              ts: event.message.id,
              message: {
                type: "message",
                user: event.message.userId,
                text: event.message.text,
                ts: event.message.id,
              },
            },
    },
  },
  "message.deleted": {
    channel: (event) => event.channelId,
    effects(event, _seq, store) {
      store.reminders.dropForMessage(event.messageId);
      store.outbox.mentionsIn(event.channelId);
    },
    app: {
      actor: () => null,
      slack: (event) => ({
        type: "message",
        subtype: "message_deleted",
        channel: event.channelId,
        deleted_ts: event.messageId,
      }),
    },
  },
  "history.removed": {
    channel: (event) => event.channelId,
    // A removed mention no longer counts.
    effects: (event, _seq, store) => store.outbox.mentionsIn(event.channelId),
  },
  "reaction.added": {
    channel: (event) => event.channelId,
    app: {
      actor: (event) => event.userId,
      slack: (event) => ({
        type: "reaction_added",
        user: event.userId,
        // Slack sends the name without colons; ours is the emoji itself.
        reaction: event.emoji,
        item: { type: "message", channel: event.channelId, ts: event.messageId },
      }),
    },
  },
  "reaction.removed": {
    channel: (event) => event.channelId,
    app: {
      actor: (event) => event.userId,
      slack: (event) => ({
        type: "reaction_removed",
        user: event.userId,
        reaction: event.emoji,
        item: { type: "message", channel: event.channelId, ts: event.messageId },
      }),
    },
  },
} satisfies Partial<DurableRegistry>;

export const messageEphemeral = {
  mentions: "person",
} as const satisfies Partial<EphemeralRegistry>;
