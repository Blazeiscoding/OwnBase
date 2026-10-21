import { broadcastLabel, broadcastsIn, type ID, type Message } from "@slackoss/protocol";
import type { WorkspaceState } from "./workspace.js";

export type NotifyDecision =
  | {
      notify: false;
      reason:
        "own-message" | "not-a-member" | "muted" | "thread-muted" | "level" | "dnd" | "not-here";
    }
  | { notify: true; reason: "dm" | "mention" | "broadcast" | "all" };

export interface NotifyContext {
  now?: number;
  /**
   * Whether this message is arriving as it is sent, rather than being replayed
   * after a reconnect. `@here` asks the people who are around right now, so a
   * message caught up on an hour later must not ring.
   */
  live?: boolean;
}

/**
 * Whether an incoming message should raise a desktop notification.
 * Kept here rather than in the UI so the rules are testable and identical
 * on every client.
 */
export function decideNotification(
  state: WorkspaceState,
  message: Message,
  context: NotifyContext = {},
): NotifyDecision {
  const { now = Date.now(), live = true } = context;
  const self = state.self;
  if (!self || message.userId === self.id) return { notify: false, reason: "own-message" };

  const channel = state.channels[message.channelId];
  if (!channel || !(message.channelId in state.memberships)) {
    return { notify: false, reason: "not-a-member" };
  }

  const prefs = state.prefs[message.channelId] ?? { notifyLevel: "mentions", muted: false };
  if (prefs.muted) return { notify: false, reason: "muted" };
  if (prefs.notifyLevel === "nothing") return { notify: false, reason: "level" };

  // A reply that chose to notify the author of what it answers names them.
  const named =
    message.text.includes(`<@${self.id}>`) ||
    (message.replyTo?.ping === true && message.replyTo.userId === self.id);
  const broadcasts = broadcastsIn(message.text);
  // A room-wide mention only reaches a room: in a DM it is just words.
  const isDm = channel.type === "dm" || channel.type === "group_dm";
  const addressed = named || (!isDm && broadcasts.size > 0);

  // A muted thread speaks up only for what is addressed to this account, as
  // its mention badge counts it; in a DM, too, where everything else would.
  if (
    message.threadRootId !== null &&
    state.threadFollows[message.threadRootId]?.muted &&
    !addressed
  ) {
    return { notify: false, reason: "thread-muted" };
  }

  if (prefs.notifyLevel === "mentions" && !addressed && !isDm) {
    return { notify: false, reason: "level" };
  }

  // Do Not Disturb wins over everything except the decision to stay silent,
  // which is already settled above.
  if (self.dndUntil !== null && self.dndUntil > now) return { notify: false, reason: "dnd" };

  if (isDm) return { notify: true, reason: "dm" };
  if (named) return { notify: true, reason: "mention" };
  if (!isDm && broadcasts.size > 0) {
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
export function decideReminderNotification(
  state: WorkspaceState,
  now = Date.now(),
): { notify: false; reason: "dnd" } | { notify: true; reason: "reminder" } {
  const dndUntil = state.self?.dndUntil ?? null;
  if (dndUntil !== null && dndUntil > now) return { notify: false, reason: "dnd" };
  return { notify: true, reason: "reminder" };
}

/** Reminders come due, in conversations this client still has. */
export function dueReminderCount(state: Pick<WorkspaceState, "reminders" | "channels">): number {
  return Object.values(state.reminders ?? {}).filter(
    (reminder) => reminder.dueAt !== null && reminder.channelId in state.channels,
  ).length;
}

/**
 * What the person has on screen, as far as the app can tell. A conversation
 * can be selected without being seen: the window can be in the background or
 * minimised, a phone's drawer or side panel can cover the timeline, and a
 * huddle's video can cover the chat.
 */
export interface OnScreen {
  /** The window has focus and is visible. */
  focused: boolean;
  /** The conversation selected, if any. */
  channelId: ID | null;
  /** Whether its timeline can be seen, rather than being covered. */
  channelVisible: boolean;
  /** The thread open beside it, if any. */
  threadRootId: ID | null;
  /** Whether that thread can be seen, rather than being covered. */
  threadVisible: boolean;
}

/**
 * Whether a message arrives where the person is already looking, so that
 * telling them about it would only interrupt. A message shows in its channel's
 * timeline when it is top-level or a reply also sent to the channel, and in a
 * thread only when that exact thread is open. So a reply in a thread that is
 * not open, or in a different one, is not on screen just because its channel
 * is selected.
 *
 * Scrolled back through the channel's history, its newest messages are not in
 * view, but they are counted as on screen all the same: the timeline itself
 * shows that new messages have arrived below, which is enough for the
 * conversation someone is in the middle of.
 */
export function isMessageOnScreen(message: Message, screen: OnScreen): boolean {
  if (!screen.focused || message.channelId !== screen.channelId) return false;
  const inChannel = message.threadRootId === null || message.broadcast;
  const inThread = message.threadRootId !== null && message.threadRootId === screen.threadRootId;
  return (inChannel && screen.channelVisible) || (inThread && screen.threadVisible);
}

/** Text for a notification, with mention markup resolved to readable names. */
export function notificationBody(state: WorkspaceState, message: Message): string {
  // Deliberately permissive: an id format change should not silently stop
  // mentions from resolving to names.
  const text = message.text
    .replaceAll(/<@([A-Za-z0-9_-]+)>/g, (_all, id: ID) => {
      const user = state.users[id];
      return user ? `@${user.displayName}` : "@someone";
    })
    .replaceAll(/<!(channel|here|everyone)>/g, (_all, who: string) => broadcastLabel(who))
    // A labelled link reads as its label, and an unlabelled one as its address.
    .replaceAll(
      /<(https?:\/\/[^\s|<>]+)(?:\|([^<>\n]+))?>/g,
      (_all, url: string, label?: string) => label?.trim() || url,
    );
  if (text.trim()) return text;
  const count = message.files.length;
  return count === 1 ? "Sent a file" : `Sent ${count} files`;
}
