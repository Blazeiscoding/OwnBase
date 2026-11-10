import { userMentionsIn, type ID } from "@ownbase/protocol";
import type { CommandHint, WorkspaceClient } from "@ownbase/client-core";
import { failureText } from "./failure.js";

/**
 * Slash commands the app runs itself, as Slack's built-in ones: the small
 * things otherwise a menu or two away. The server reserves their names, so no
 * app can claim one, and lists them; this list is for a server too old to.
 * An app's own command of the same name, kept from before, still wins.
 */
export const APP_COMMANDS: CommandHint[] = [
  { command: "away", description: "Show yourself as away", usageHint: "", builtin: true },
  { command: "active", description: "Show yourself as active", usageHint: "", builtin: true },
  {
    command: "status",
    description: "Set your status, or clear it",
    usageHint: "[emoji] [what you're doing] | clear",
    builtin: true,
  },
  {
    command: "topic",
    description: "Set this channel's topic",
    usageHint: "[topic]",
    builtin: true,
  },
  {
    command: "invite",
    description: "Add people to this channel",
    usageHint: "@person [@person…]",
    builtin: true,
  },
  { command: "leave", description: "Leave this channel", usageHint: "", builtin: true },
  { command: "mute", description: "Mute this conversation", usageHint: "", builtin: true },
  { command: "unmute", description: "Unmute this conversation", usageHint: "", builtin: true },
];

const NAMES = new Set(APP_COMMANDS.map((c) => c.command));
/** Commands that only mean something in a channel, not in a DM. */
const ROOM_ONLY = new Set(["topic", "invite", "leave"]);

/** The commands the hint list offers: the server's, and this app's it does not list yet. */
export function withAppCommands(fromServer: readonly CommandHint[], room: boolean) {
  const listed = new Set(fromServer.map((c) => c.command));
  const ours = APP_COMMANDS.filter((c) => !listed.has(c.command));
  return [...fromServer, ...ours].filter((c) => room || !ROOM_ONLY.has(c.command) || !c.builtin);
}

/** `/name args` when the name is one the app runs and no app of the server's has it. */
export function appCommand(text: string, fromServer: readonly CommandHint[]) {
  const m = /^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  if (!NAMES.has(name)) return null;
  if (fromServer.some((c) => c.command === name && !c.builtin)) return null;
  return { name, args: (m[2] ?? "").trim() };
}

/** What became of a command: done, with what to say; or not, with why. The box keeps its words when not. */
export type CommandOutcome = { ok: true; said: string } | { ok: false; said: string };

interface Context {
  client: WorkspaceClient;
  channelId: ID;
}

const firstGrapheme = (text: string) => {
  const [first] = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
  return first?.segment ?? "";
};

export async function runAppCommand(
  name: string,
  args: string,
  { client, channelId }: Context,
): Promise<CommandOutcome> {
  const state = client.state;
  const channel = state.channels[channelId];
  const room = channel?.type === "public" || channel?.type === "private";
  const where = channel && room ? `#${channel.name}` : "this conversation";
  if (ROOM_ONLY.has(name) && !room)
    return { ok: false, said: `/${name} works in channels, not in direct messages.` };
  const offline = "Check your connection and try again.";
  try {
    switch (name) {
      case "away":
      case "active": {
        const away = name === "away";
        const error = await client.setAway(away);
        if (error) return { ok: false, said: failureText("Your presence was not changed.", error) };
        return { ok: true, said: away ? "You are shown as away." : "You are shown as active." };
      }
      case "status": {
        if (!args)
          return { ok: false, said: "Say what you're doing after /status, or /status clear." };
        if (args.toLowerCase() === "clear") {
          const error = await client.updateProfile({
            statusEmoji: "",
            statusText: "",
            statusExpiresAt: null,
          });
          if (error) return { ok: false, said: `/status did not go through. ${offline}` };
          return { ok: true, said: "Your status was cleared." };
        }
        const first = firstGrapheme(args);
        const emoji = /\p{Extended_Pictographic}/u.test(first) ? first : "";
        const words = (emoji ? args.slice(first.length) : args).trim();
        if (words.length > 120) return { ok: false, said: "A status can be up to 120 characters." };
        const error = await client.updateProfile({
          statusEmoji: emoji,
          statusText: words,
          statusExpiresAt: null,
        });
        if (error) return { ok: false, said: `/status did not go through. ${offline}` };
        return { ok: true, said: `Your status is now ${`${emoji} ${words}`.trim()}.` };
      }
      case "topic": {
        if (!args) return { ok: false, said: "Write the new topic after /topic." };
        if (args.length > 250) return { ok: false, said: "A topic can be up to 250 characters." };
        await client.updateChannel(channelId, { topic: args });
        return { ok: true, said: `Topic of ${where} set.` };
      }
      case "invite": {
        const ids = [...userMentionsIn(args)];
        if (ids.length === 0)
          return { ok: false, said: "Mention the people to add after /invite, as /invite @Sam." };
        const added: string[] = [];
        const missed: string[] = [];
        for (const id of ids) {
          const person = state.users[id]?.displayName ?? "someone";
          try {
            await client.addToChannel(channelId, id);
            added.push(person);
          } catch {
            missed.push(person);
          }
        }
        if (missed.length)
          return {
            ok: false,
            said: `${added.length ? `Added ${added.join(", ")}. ` : ""}Could not add ${missed.join(", ")} to ${where}.`,
          };
        return { ok: true, said: `Added ${added.join(", ")} to ${where}.` };
      }
      case "leave": {
        await client.leaveChannel(channelId);
        return { ok: true, said: `You left ${where}.` };
      }
      case "mute":
      case "unmute": {
        client.setChannelPrefs(channelId, { muted: name === "mute" });
        return {
          ok: true,
          said: name === "mute" ? `${cap(where)} is muted.` : `${cap(where)} is no longer muted.`,
        };
      }
    }
  } catch {
    return {
      ok: false,
      said:
        name === "topic"
          ? `The topic was not changed. Only someone who can manage ${where} can set it, or the connection is down.`
          : name === "leave"
            ? `You are still in ${where}. ${offline}`
            : `/${name} did not go through. ${offline}`,
    };
  }
  return { ok: false, said: `/${name} is not a command here.` };
}

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
