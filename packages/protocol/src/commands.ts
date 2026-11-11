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
