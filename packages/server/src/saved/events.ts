import type { DurableRegistry, EphemeralRegistry } from "../events/registry.js";

/** Pins are the channel's, heard by its readers; saving is an account's own. */
export const savedDurable = {
  "pin.added": {
    channel: (event) => event.channelId,
    app: {
      actor: (event) => event.userId,
      slack: (event) => ({
        type: "pin_added",
        user: event.userId,
        channel_id: event.channelId,
        item: { type: "message", channel: event.channelId, ts: event.messageId },
      }),
    },
  },
  "pin.removed": {
    channel: (event) => event.channelId,
    app: {
      actor: () => null,
      slack: (event) => ({
        type: "pin_removed",
        channel_id: event.channelId,
        item: { type: "message", channel: event.channelId, ts: event.messageId },
      }),
    },
  },
} satisfies Partial<DurableRegistry>;

export const savedEphemeral = {
  saved: "person",
} as const satisfies Partial<EphemeralRegistry>;
