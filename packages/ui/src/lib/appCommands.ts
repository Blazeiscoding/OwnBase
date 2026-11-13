import {
  IN_APP_COMMANDS,
  isInAppCommand,
  userMentionsIn,
  isRoom,
  type ID,
  type InAppCommandName,
} from "@ownbase/protocol";
import type { CommandHint, WorkspaceClient } from "@ownbase/client-core";
import { failureText } from "./failure.js";

const roomOnly = (name: string) => isInAppCommand(name) && IN_APP_COMMANDS[name].roomOnly;

/** The server's commands the hint list offers here: in a DM, not the built-in channel ones. */
export function offeredCommands(fromServer: readonly CommandHint[], room: boolean) {
  return fromServer.filter((c) => room || !c.builtin || !roomOnly(c.command));
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

/** Runs one of the commands the app runs itself, all but /poll, which opens a window. */
export async function runAppCommand(
  name: Exclude<InAppCommandName, "poll">,
  args: string,
  { client, channelId }: Context,
): Promise<CommandOutcome> {
  const state = client.state;
  const channel = state.channels[channelId];
  const room = isRoom(channel?.type);
  const where = channel && room ? `#${channel.name}` : "this conversation";
  if (roomOnly(name) && !room)
    return { ok: false, said: `/${name} works in channels, not in direct messages.` };
  const offline = "Check your connection and try again.";
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
      if (await client.updateChannel(channelId, { topic: args }))
        return {
          ok: false,
          said: `The topic was not changed. Only someone who can manage ${where} can set it, or the connection is down.`,
        };
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
        if (await client.addToChannel(channelId, id)) missed.push(person);
        else added.push(person);
      }
      if (missed.length)
        return {
          ok: false,
          said: `${added.length ? `Added ${added.join(", ")}. ` : ""}Could not add ${missed.join(", ")} to ${where}.`,
        };
      return { ok: true, said: `Added ${added.join(", ")} to ${where}.` };
    }
    case "leave": {
      if (await client.leaveChannel(channelId))
        return { ok: false, said: `You are still in ${where}. ${offline}` };
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
}

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
