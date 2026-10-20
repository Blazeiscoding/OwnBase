import { createHmac } from "node:crypto";
import type { ID, WorkspaceEvent } from "@slackoss/protocol";

/**
 * Signs an outbound request the way Slack does: HMAC-SHA256 over
 * `v0:<timestamp>:<body>` with the app's signing secret. Receivers compare
 * against the header and reject anything older than a few minutes, which stops
 * a captured request from being replayed at them later.
 *
 * The Slack-named headers are sent alongside ours so a library written against
 * Slack verifies our requests without changes.
 */
export function signatureHeaders(
  secret: string,
  body: string,
  now = Date.now(),
): Record<string, string> {
  const ts = String(Math.floor(now / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
  return {
    "x-slackoss-request-timestamp": ts,
    "x-slackoss-signature": signature,
    "x-slack-request-timestamp": ts,
    "x-slack-signature": signature,
  };
}

/** The person who caused an event, when there is one. Used to avoid feeding an app its own actions. */
export function eventActorId(event: WorkspaceEvent): ID | null {
  switch (event.type) {
    case "message.created":
    case "message.updated":
      return event.message.userId;
    case "reaction.added":
    case "reaction.removed":
    case "pin.added":
    case "member.joined":
    case "member.left":
      return event.userId;
    case "channel.created":
    case "channel.updated":
      return event.channel.creatorId;
    case "user.joined":
    case "user.updated":
      return event.user.id;
    default:
      return null;
  }
}

/**
 * Re-shapes a native event into the Slack Events API payload an existing
 * integration expects. `ts` is our message id — Slack treats it as opaque, and
 * ours sorts the same way theirs does.
 */
export function toSlackEvent(event: WorkspaceEvent): Record<string, unknown> | null {
  switch (event.type) {
    case "message.created": {
      const m = event.message;
      return {
        type: "message",
        channel: m.channelId,
        user: m.userId,
        text: m.text,
        ts: m.id,
        ...(m.threadRootId ? { thread_ts: m.threadRootId } : {}),
      };
    }
    case "message.updated":
      // Previews found or removed change nothing an app was told (E2).
      if (event.previewsOnly) return null;
      return {
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
      };
    case "message.deleted":
      return {
        type: "message",
        subtype: "message_deleted",
        channel: event.channelId,
        deleted_ts: event.messageId,
      };
    case "reaction.added":
    case "reaction.removed":
      return {
        type: event.type === "reaction.added" ? "reaction_added" : "reaction_removed",
        user: event.userId,
        // Slack sends the name without colons; ours is the emoji itself.
        reaction: event.emoji,
        item: { type: "message", channel: event.channelId, ts: event.messageId },
      };
    case "pin.added":
      return {
        type: "pin_added",
        user: event.userId,
        channel_id: event.channelId,
        item: { type: "message", channel: event.channelId, ts: event.messageId },
      };
    case "pin.removed":
      return {
        type: "pin_removed",
        channel_id: event.channelId,
        item: { type: "message", channel: event.channelId, ts: event.messageId },
      };
    case "member.joined":
    case "member.left":
      return {
        type: event.type === "member.joined" ? "member_joined_channel" : "member_left_channel",
        user: event.userId,
        channel: event.channelId,
      };
    case "channel.created":
      return {
        type: "channel_created",
        channel: {
          id: event.channel.id,
          name: event.channel.name,
          created: Math.floor(event.channel.createdAt / 1000),
          creator: event.channel.creatorId,
        },
      };
    case "channel.updated":
      return {
        type: "channel_rename",
        channel: {
          id: event.channel.id,
          name: event.channel.name,
          created: Math.floor(event.channel.createdAt / 1000),
        },
      };
    case "user.joined":
    case "user.updated":
      return {
        type: event.type === "user.joined" ? "team_join" : "user_change",
        user: {
          id: event.user.id,
          name: event.user.handle,
          real_name: event.user.displayName,
          is_bot: event.user.isBot,
          deleted: event.user.deactivated,
        },
      };
    default:
      return null;
  }
}
