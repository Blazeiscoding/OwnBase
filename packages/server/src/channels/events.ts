import type { DurableRegistry, EphemeralRegistry } from "../events/registry.js";

/**
 * The events of channels and who is in them. A conversation's own events are
 * heard by those who can read it; a private one's by its members, read after
 * the change commits, so someone just removed no longer hears them.
 */
export const channelDurable = {
  "channel.created": {
    channel: (event) => event.channel.id,
    app: {
      actor: (event) => event.channel.creatorId,
      slack: ({ channel }) => ({
        type: "channel_created",
        channel: {
          id: channel.id,
          name: channel.name,
          created: Math.floor(channel.createdAt / 1000),
          creator: channel.creatorId,
        },
      }),
    },
  },
  "channel.updated": {
    channel: (event) => event.channel.id,
    app: {
      actor: (event) => event.channel.creatorId,
      slack: ({ channel }) => ({
        type: "channel_rename",
        channel: {
          id: channel.id,
          name: channel.name,
          created: Math.floor(channel.createdAt / 1000),
        },
      }),
    },
  },
  "member.joined": {
    channel: (event) => event.channelId,
    app: {
      actor: (event) => event.userId,
      slack: (event) => ({
        type: "member_joined_channel",
        user: event.userId,
        channel: event.channelId,
      }),
    },
  },
  "member.left": {
    channel: (event) => event.channelId,
    app: {
      actor: (event) => event.userId,
      slack: (event) => ({
        type: "member_left_channel",
        user: event.userId,
        channel: event.channelId,
      }),
    },
  },
} satisfies Partial<DurableRegistry>;

export const channelEphemeral = {
  "channel.read": "person",
  "channel.unread": "person",
  "channel.access": "person",
  "channel.removal": "person",
  "channel.removals.read": "person",
  prefs: "person",
  "notify.default": "person",
  "sidebar.sections": "person",
  typing: "channel",
} as const satisfies Partial<EphemeralRegistry>;
