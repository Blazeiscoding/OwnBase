import {
  effectiveNotifyLevel,
  isDirect,
  type ChannelPrefs,
  type ChannelType,
  type ID,
  type Message,
  type NotifyLevel,
} from "./entities.js";
import { broadcastsIn, plainText, userMentionsIn, type MentionLabels } from "./format.js";

export type NotifyDecision =
  | {
      notify: false;
      reason:
        | "own-message"
        | "blocked"
        | "not-a-member"
        | "muted"
        | "thread-muted"
        | "level"
        | "dnd"
        | "not-here";
    }
  | { notify: true; reason: "dm" | "mention" | "broadcast" | "all" };

/**
 * Everything the notify rule weighs for one message and one person, as plain
 * values. The client reads them from its workspace state and the server from
 * its tables, so the rule itself is the same on both sides.
 */
export interface NotifyInputs {
  /** Who would be notified; null when nobody is signed in. */
  selfId: ID | null;
  message: Pick<Message, "userId" | "text" | "threadRootId" | "replyTo">;
  /** Whether this person blocked the sender. */
  senderBlocked: boolean;
  /** The conversation's kind, or null when this person is not in it. */
  channelType: ChannelType | null;
  prefs: Pick<ChannelPrefs, "muted" | "notifyLevel" | "notifyChosen"> | undefined;
  notifyDefault: NotifyLevel | null | undefined;
  /** Whether this person muted the thread the message replies in. */
  threadMuted: boolean;
  dndUntil: number | null | undefined;
  now: number;
  /**
   * Whether the person is around as the message arrives, rather than
   * catching up on it later. `@here` asks only the people who are around.
   */
  live: boolean;
}

const snoozed = (dndUntil: number | null | undefined, now: number) =>
  dndUntil != null && dndUntil > now;

/** Whether a message should notify one person. */
export function notifyDecision(inputs: NotifyInputs): NotifyDecision {
  const { selfId, message, now, live } = inputs;
  if (selfId === null || message.userId === selfId) return { notify: false, reason: "own-message" };
  // Someone this account blocked never reaches it, whatever they write (E12).
  if (inputs.senderBlocked) return { notify: false, reason: "blocked" };
  if (inputs.channelType === null) return { notify: false, reason: "not-a-member" };

  const { prefs } = inputs;
  if (prefs?.muted) return { notify: false, reason: "muted" };
  // Its own level, or the account's default where it follows that (v53).
  const level = effectiveNotifyLevel(prefs, inputs.notifyDefault);
  if (level === "nothing") return { notify: false, reason: "level" };

  // A reply that chose to notify the author of what it answers names them.
  const named =
    userMentionsIn(message.text).has(selfId) ||
    (message.replyTo?.ping === true && message.replyTo.userId === selfId);
  const broadcasts = broadcastsIn(message.text);
  // A room-wide mention only reaches a room: in a DM it is just words.
  const isDm = isDirect(inputs.channelType);
  const addressed = named || (!isDm && broadcasts.size > 0);

  // A muted thread speaks up only for what is addressed to this account, as
  // its mention badge counts it; in a DM, too, where everything else would.
  if (message.threadRootId !== null && inputs.threadMuted && !addressed) {
    return { notify: false, reason: "thread-muted" };
  }

  if (level === "mentions" && !addressed && !isDm) {
    return { notify: false, reason: "level" };
  }

  // Do Not Disturb wins over everything except the decision to stay silent,
  // which is already settled above.
  if (snoozed(inputs.dndUntil, now)) return { notify: false, reason: "dnd" };

  if (isDm) return { notify: true, reason: "dm" };
  if (named) return { notify: true, reason: "mention" };
  if (broadcasts.size > 0) {
    // @channel reaches everyone in it; @here only the people who are here.
    if (broadcasts.has("channel") || live) return { notify: true, reason: "broadcast" };
    return { notify: false, reason: "not-here" };
  }
  return { notify: true, reason: "all" };
}

/**
 * Whether a reminder that came due should raise a notification. The person
 * asked for it, so a muted or quiet conversation does not hold it back; Do Not
 * Disturb does, and it waits in Activity.
 */
export function reminderNotifyDecision(
  dndUntil: number | null | undefined,
  now: number,
): { notify: false; reason: "dnd" } | { notify: true; reason: "reminder" } {
  if (snoozed(dndUntil, now)) return { notify: false, reason: "dnd" };
  return { notify: true, reason: "reminder" };
}

/**
 * What a notification says of a message: its words with mention markup read
 * out by `labels`. A code block's fences are markup, so only what is inside
 * them is kept. A message with no words says what it carries.
 */
export function notificationWords(
  message: Pick<Message, "text" | "files" | "forwardedFrom">,
  labels: MentionLabels,
): string {
  const text = plainText(message.text, labels);
  const words = text.replaceAll(/```\n?/g, "");
  if (words.trim()) return words;
  if (text.trim()) return text;
  const count = message.files.length;
  // A forward with no words of its own carries neither words nor files.
  if (count === 0) return message.forwardedFrom ? "Forwarded a message" : "Sent a message";
  return count === 1 ? "Sent a file" : `Sent ${count} files`;
}
