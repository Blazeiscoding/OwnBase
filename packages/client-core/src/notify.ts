import {
  notifyDecision,
  plainText,
  reminderNotifyDecision,
  type ID,
  type Message,
  type NotifyDecision,
} from "@ownbase/protocol";
import type { WorkspaceState } from "./workspace.js";

export type { NotifyDecision } from "@ownbase/protocol";

interface NotifyContext {
  now?: number;
  /**
   * Whether this message is arriving as it is sent, rather than being replayed
   * after a reconnect. `@here` asks the people who are around right now, so a
   * message caught up on an hour later must not ring.
   */
  live?: boolean;
}

/**
 * Whether an incoming message should raise a desktop notification. The rule
 * is protocol's `notifyDecision`, which the server also follows for pushes to
 * a closed browser; this reads its inputs from the workspace state.
 */
export function decideNotification(
  state: WorkspaceState,
  message: Message,
  context: NotifyContext = {},
): NotifyDecision {
  const { now = Date.now(), live = true } = context;
  const self = state.self;
  const channel = state.channels[message.channelId];
  const member = channel !== undefined && message.channelId in state.memberships;
  return notifyDecision({
    selfId: self?.id ?? null,
    message,
    senderBlocked: state.blocked.includes(message.userId),
    channelType: member ? channel.type : null,
    prefs: state.prefs[message.channelId],
    notifyDefault: state.notifyDefault,
    threadMuted:
      message.threadRootId !== null && state.threadFollows[message.threadRootId]?.muted === true,
    dndUntil: self?.dndUntil,
    now,
    live,
  });
}

/** Whether a reminder that came due should raise a notification; see `reminderNotifyDecision`. */
export function decideReminderNotification(
  state: WorkspaceState,
  now = Date.now(),
): { notify: false; reason: "dnd" } | { notify: true; reason: "reminder" } {
  return reminderNotifyDecision(state.self?.dndUntil, now);
}

/** Reminders come due, in conversations this client still has. */
export function dueReminderCount(state: Pick<WorkspaceState, "reminders" | "channels">): number {
  return Object.values(state.reminders).filter(
    (reminder) => reminder.dueAt !== null && reminder.channelId in state.channels,
  ).length;
}

/** Notes that someone removed this account from channels, waiting in Activity. */
export function unreadRemovalCount(state: Pick<WorkspaceState, "channelRemovals">): number {
  return Object.keys(state.channelRemovals).length;
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

/** Message text with mention markup resolved to readable names, as a notification shows it. */
export function readableText(state: WorkspaceState, text: string): string {
  return plainText(text, {
    user: (id) => {
      const user = state.users[id];
      return user ? `@${user.displayName}` : "@someone";
    },
    channel: (id) => `#${state.channels[id]?.name || "unknown"}`,
  });
}

/**
 * Text for a notification, with mention markup resolved to readable names.
 * A code block's fences are markup, so only what is inside them is kept.
 */
export function notificationBody(state: WorkspaceState, message: Message): string {
  const text = readableText(state, message.text);
  const words = text.replaceAll(/```\n?/g, "");
  if (words.trim()) return words;
  if (text.trim()) return text;
  const count = message.files.length;
  // A forward with no words of its own carries neither words nor files.
  if (count === 0) return message.forwardedFrom ? "Forwarded a message" : "Sent a message";
  return count === 1 ? "Sent a file" : `Sent ${count} files`;
}
