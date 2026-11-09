import type { Message, Reminder } from "@ownbase/protocol";
import type { IconName } from "../components/Icon.js";
import type { MenuItem } from "../components/Menu.js";

/** One message as its actions see it, and what the row does for each. */
export interface MessageActionContext {
  message: Message;
  /** Shown inside its thread's panel. */
  inThread: boolean;
  /** Written by this account. */
  mine: boolean;
  editable: boolean;
  canReply: boolean;
  canDelete: boolean;
  /** Pinning changes the channel for everyone, which a guest may not. */
  canPin: boolean;
  /** A forward of something hidden here or deleted has nothing to pass on. */
  canForward: boolean;
  saved: boolean;
  threadMuted: boolean;
  reminder: Reminder | null;
  deleting: boolean;
  /** `ping`: Shift, as in Discord, answers without notifying the author. */
  reply: (ping: boolean) => void;
  openThread: () => void;
  pickReaction: () => void;
  copyText: () => void;
  copyLink: () => void;
  forward: () => void;
  toggleSaved: () => void;
  remind: () => void;
  finishReminder: () => void;
  markUnread: () => void;
  toggleThreadMute: () => void;
  togglePin: () => void;
  edit: () => void;
  report: () => void;
  delete: () => void;
}

type Text = string | ((ctx: MessageActionContext) => string);

export interface MessageAction {
  id: string;
  label: Text;
  /** The toolbar's tooltip, where it differs from the menus' words. */
  title?: string;
  icon: IconName | ((ctx: MessageActionContext) => IconName);
  /** The key that does it while the message itself has focus, as the shortcut list names it. */
  key?: string;
  /** Every key that does it, lower case as `KeyboardEvent.key` gives them. */
  keys?: string[];
  /** What the shortcut list says the key does. */
  keyHelp?: string;
  destructive?: true;
  available: (ctx: MessageActionContext) => boolean;
  /** `shift`: the toolbar's button was pressed with Shift held. */
  run: (ctx: MessageActionContext, shift: boolean) => void;
}

const always = () => true;

/** Every action on one message, each declared once, in the order the shortcut list gives their keys. */
export const MESSAGE_ACTIONS = [
  {
    id: "edit",
    label: "Edit message",
    icon: "edit",
    key: "E",
    keyHelp: "Edit your message",
    available: (ctx) => ctx.editable,
    run: (ctx) => ctx.edit(),
  },
  {
    id: "thread",
    label: "Reply in thread",
    icon: "thread",
    key: "T",
    keyHelp: "Reply in thread",
    available: (ctx) => !ctx.inThread,
    run: (ctx) => ctx.openThread(),
  },
  {
    // Answered in place in the conversation it is shown in: the channel, or
    // inside a thread its replies. The thread's first message is the thread.
    id: "answer",
    label: "Reply",
    icon: "reply",
    key: "Q",
    keyHelp: "Reply, quoting it",
    available: (ctx) => ctx.canReply,
    run: (ctx, shift) => ctx.reply(!shift),
  },
  {
    id: "react",
    label: "Add a reaction…",
    title: "Add a reaction",
    icon: "smile",
    key: "R",
    keyHelp: "Add a reaction",
    available: always,
    run: (ctx) => ctx.pickReaction(),
  },
  {
    id: "save",
    label: (ctx) => (ctx.saved ? "Remove from Saved" : "Save for later"),
    icon: "bookmark",
    key: "A",
    keyHelp: "Save for later, or stop saving",
    available: always,
    run: (ctx) => ctx.toggleSaved(),
  },
  {
    id: "unread",
    label: (ctx) =>
      ctx.inThread ? "Mark unread from this reply" : "Mark unread from this message",
    icon: "markUnread",
    key: "U",
    keyHelp: "Mark unread from here",
    available: always,
    run: (ctx) => ctx.markUnread(),
  },
  {
    id: "pin",
    label: (ctx) => (ctx.message.pinned ? "Unpin from channel" : "Pin to channel"),
    icon: "pin",
    key: "P",
    keyHelp: "Pin or unpin",
    available: (ctx) => ctx.canPin,
    run: (ctx) => ctx.togglePin(),
  },
  {
    id: "forward",
    label: "Forward…",
    icon: "forward",
    key: "F",
    keyHelp: "Forward",
    available: (ctx) => ctx.canForward,
    run: (ctx) => ctx.forward(),
  },
  {
    id: "delete",
    label: "Delete message",
    icon: "trash",
    key: "Delete",
    keys: ["delete", "backspace"],
    keyHelp: "Delete the message",
    destructive: true,
    available: (ctx) => ctx.canDelete,
    run: (ctx) => ctx.delete(),
  },
  {
    // What the message says as shown, names rather than ids. Holding a message
    // opens the touch menu rather than selecting its words.
    id: "copy-text",
    label: "Copy text",
    icon: "fileText",
    available: (ctx) => !!ctx.message.text,
    run: (ctx) => ctx.copyText(),
  },
  {
    id: "copy-link",
    label: "Copy link to message",
    icon: "link",
    available: always,
    run: (ctx) => ctx.copyLink(),
  },
  {
    id: "remind",
    label: (ctx) => (ctx.reminder ? "Change reminder…" : "Remind me about this…"),
    icon: "clock",
    available: always,
    run: (ctx) => ctx.remind(),
  },
  {
    id: "remind-done",
    label: (ctx) => (ctx.reminder?.dueAt === null ? "Cancel reminder" : "Mark reminder done"),
    icon: (ctx) => (ctx.reminder?.dueAt === null ? "close" : "check"),
    available: (ctx) => !!ctx.reminder,
    run: (ctx) => ctx.finishReminder(),
  },
  {
    // A thread is muted from its first message in the channel once it has
    // replies, and unmuted there whatever it has; the thread's own header has both.
    id: "mute-thread",
    label: (ctx) => (ctx.threadMuted ? "Unmute thread" : "Mute thread"),
    icon: "bellOff",
    available: (ctx) => !ctx.inThread && (ctx.message.replyCount > 0 || ctx.threadMuted),
    run: (ctx) => ctx.toggleThreadMute(),
  },
  {
    // Someone else's message, to the workspace's admins (E12).
    id: "report",
    label: "Report message…",
    icon: "flag",
    available: (ctx) => !ctx.mine,
    run: (ctx) => ctx.report(),
  },
] as const satisfies readonly MessageAction[];

export type MessageActionId = (typeof MESSAGE_ACTIONS)[number]["id"];

const BY_ID = new Map<string, MessageAction>(MESSAGE_ACTIONS.map((a) => [a.id, a]));

/** The toolbar's buttons after its quick reactions; the rest are behind its More. */
export const TOOLBAR: readonly MessageActionId[] = ["react", "answer", "thread", "save", "edit"];

/** What the toolbar keeps behind its last button: the less frequent half. */
const MORE: readonly MessageActionId[] = [
  "copy-link",
  "forward",
  "remind",
  "remind-done",
  "unread",
  "mute-thread",
  "pin",
  "report",
  "delete",
];

/** Everything, named, for a touchscreen, where there is no toolbar. */
const TOUCH: readonly MessageActionId[] = [
  "answer",
  "thread",
  "react",
  "copy-text",
  "copy-link",
  "forward",
  "save",
  "remind",
  "remind-done",
  "unread",
  "mute-thread",
  "pin",
  "edit",
  "report",
  "delete",
];

export function messageAction(id: MessageActionId): MessageAction {
  return BY_ID.get(id)!;
}

export function actionLabel(action: MessageAction, ctx: MessageActionContext): string {
  return typeof action.label === "function" ? action.label(ctx) : action.label;
}

export function actionIcon(action: MessageAction, ctx: MessageActionContext): IconName {
  return typeof action.icon === "function" ? action.icon(ctx) : action.icon;
}

function items(ids: readonly MessageActionId[], ctx: MessageActionContext, keys: boolean) {
  return ids
    .map(messageAction)
    .filter((a) => a.available(ctx))
    .map((a): MenuItem => ({
      id: a.id,
      label: actionLabel(a, ctx),
      icon: actionIcon(a, ctx),
      ...(keys && a.key ? { keys: [a.key] } : {}),
      ...(a.destructive ? { destructive: true, disabled: ctx.deleting } : {}),
      // In the More menu, deleting stands apart from the rest.
      ...(keys && a.destructive ? { section: true as const } : {}),
      onSelect: () => a.run(ctx, false),
    }));
}

/** The toolbar's More menu, naming the key for each that has one. */
export function moreItems(ctx: MessageActionContext): MenuItem[] {
  return items(MORE, ctx, true);
}

/** The touch menu: a touchscreen has no keys to name. */
export function touchItems(ctx: MessageActionContext): MenuItem[] {
  return items(TOUCH, ctx, false);
}

/** The action a key does while the message itself has focus, if any. */
export function keyAction(key: string, ctx: MessageActionContext): MessageAction | null {
  const lower = key.toLowerCase();
  const found = (MESSAGE_ACTIONS as readonly MessageAction[]).find((a) =>
    (a.keys ?? (a.key ? [a.key.toLowerCase()] : [])).includes(lower),
  );
  if (!found || !found.available(ctx)) return null;
  if (found.destructive && ctx.deleting) return null;
  return found;
}

/** The message keys, for the shortcut list. */
export function messageKeys(): [string, string][] {
  return (MESSAGE_ACTIONS as readonly MessageAction[]).flatMap((a) =>
    a.key && a.keyHelp ? [[a.key, a.keyHelp] as [string, string]] : [],
  );
}
