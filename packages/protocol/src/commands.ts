/** A command's name, as stored: lower-case letters, digits, `_` and `-`, not starting with `_` or `-`. */
export const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** A slash command typed as a message: its name, lower-cased, and what follows it. */
export interface ParsedCommand {
  name: string;
  args: string;
}

/**
 * `/name args` typed as a message, or null when the text is no command. The
 * space or end after the name matters: it keeps a pasted path such as
 * /Users/me/notes.txt an ordinary message.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim() };
}

export interface InAppCommand {
  description: string;
  usageHint: string;
  /** Means something in a channel only, not in a direct message. */
  roomOnly: boolean;
}

/**
 * Commands the app runs itself, as Slack's own are (U4): the small things
 * otherwise a menu or two away. The server lists them with its own and
 * reserves their names, so no app can claim one, but refuses to run them.
 */
export const IN_APP_COMMANDS = {
  poll: {
    description: "Ask a question with choices to vote on",
    usageHint: "[question]",
    roomOnly: false,
  },
  away: { description: "Show yourself as away", usageHint: "", roomOnly: false },
  active: { description: "Show yourself as active", usageHint: "", roomOnly: false },
  status: {
    description: "Set your status, or clear it",
    usageHint: "[emoji] [what you're doing] | clear",
    roomOnly: false,
  },
  topic: { description: "Set this channel's topic", usageHint: "[topic]", roomOnly: true },
  invite: {
    description: "Add people to this channel",
    usageHint: "@person [@person…]",
    roomOnly: true,
  },
  leave: { description: "Leave this channel", usageHint: "", roomOnly: true },
  mute: { description: "Mute this conversation", usageHint: "", roomOnly: false },
  unmute: { description: "Unmute this conversation", usageHint: "", roomOnly: false },
} as const satisfies Record<string, InAppCommand>;

export type InAppCommandName = keyof typeof IN_APP_COMMANDS;

export const isInAppCommand = (name: string): name is InAppCommandName =>
  Object.hasOwn(IN_APP_COMMANDS, name);
