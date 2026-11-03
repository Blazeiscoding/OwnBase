import { escapeMrkdwn, type User } from "@ownbase/protocol";

/**
 * Commands the server answers itself. They exist because a workspace with no
 * apps installed should still do the small things Slack does, and because they
 * reserve the names before an app can claim them.
 *
 * `run` returns the message text to post, or null when the arguments are wrong.
 */
export interface BuiltinCommand {
  description: string;
  usageHint: string;
  run: (text: string, user: User) => string | null;
  /**
   * Set for a command the app runs itself, which the server only lists and
   * reserves: what it says to a client that sends the command here instead.
   */
  inApp?: string;
}

/** What it must look like on screen. */
const SHRUG_ART = "¯\\_(ツ)_/¯";
/**
 * Stored pre-escaped, so mrkdwn leaves the arms alone. Computed rather than
 * written out: counting backslashes by hand is how this gets broken.
 */
const SHRUG = escapeMrkdwn(SHRUG_ART);

export const BUILTIN_COMMANDS = new Map<string, BuiltinCommand>([
  [
    "shrug",
    {
      description: "Append ¯\\_(ツ)_/¯ to your message",
      usageHint: "[message]",
      run: (text) => `${text} ${SHRUG}`.trim(),
    },
  ],
  [
    "me",
    {
      description: "Speak in the third person",
      usageHint: "<message>",
      // Italics are how Slack renders these, and our mrkdwn already has them.
      run: (text) => (text ? `_${text}_` : null),
    },
  ],
  [
    "poll",
    {
      description: "Ask a question with choices to vote on",
      usageHint: "[question]",
      // The app opens its poll window for this; only an older one sends it here.
      run: () => null,
      inApp: "Polls are made in the poll window. Update OwnBase to open it with /poll.",
    },
  ],
  // Run by the app itself, as Slack's own are (U4): listed and reserved here,
  // so no app can claim them.
  ...(
    [
      ["away", "Show yourself as away", ""],
      ["active", "Show yourself as active", ""],
      ["status", "Set your status, or clear it", "[emoji] [what you're doing] | clear"],
      ["topic", "Set this channel's topic", "[topic]"],
      ["invite", "Add people to this channel", "@person [@person…]"],
      ["leave", "Leave this channel", ""],
      ["mute", "Mute this conversation", ""],
      ["unmute", "Unmute this conversation", ""],
    ] as const
  ).map(([command, description, usageHint]): [string, BuiltinCommand] => [
    command,
    {
      description,
      usageHint,
      run: () => null,
      inApp: `Update OwnBase to use /${command}.`,
    },
  ]),
]);
