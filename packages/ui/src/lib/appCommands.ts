import {
  CHANNEL_TOPIC_MAX,
  STATUS_TEXT_MAX,
  IN_APP_COMMANDS,
  userMentionsIn,
  isRoom,
  type ID,
  type InAppCommandName,
  type RepeatRule,
  nextRepeat,
} from "@ownbase/protocol";
import type { ScheduledSends, WorkspaceClient } from "@ownbase/client-core";
import { failureText } from "./failure.js";
import { parseRemind } from "./remind.js";
import { deviceZone, describeRepeat } from "./repeat.js";
import { formatReminderTime } from "./schedule.js";

/**
 * What became of a command: done, with what to say; or not, with why. The box
 * keeps its words when not. One that asks first says what it will do, and
 * `go` does it once the person agrees.
 */
export type CommandOutcome =
  | { ok: true; said: string }
  | { ok: false; said: string }
  | { ok: "ask"; said: string; go: () => Promise<CommandOutcome> };

interface Context {
  client: WorkspaceClient;
  channelId: ID;
  /** Schedules what /remind asks for. */
  schedules?: ScheduledSends;
}

const firstGrapheme = (text: string) => {
  const [first] = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
  return first?.segment ?? "";
};

/** Runs one of the commands the app runs itself, all but /poll, which opens a window. */
export async function runAppCommand(
  name: Exclude<InAppCommandName, "poll">,
  args: string,
  { client, channelId, schedules }: Context,
): Promise<CommandOutcome> {
  const state = client.state;
  const channel = state.channels[channelId];
  const room = isRoom(channel?.type);
  const where = channel && room ? `#${channel.name}` : "this conversation";
  if (IN_APP_COMMANDS[name].roomOnly && !room)
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
      if (words.length > STATUS_TEXT_MAX)
        return { ok: false, said: `A status can be up to ${STATUS_TEXT_MAX} characters.` };
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
      if (args.length > CHANNEL_TOPIC_MAX)
        return { ok: false, said: `A topic can be up to ${CHANNEL_TOPIC_MAX} characters.` };
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
    case "remind": {
      if (!schedules) return { ok: false, said: `/remind could not start. ${offline}` };
      const timeZone = deviceZone();
      const parsed = parseRemind(args, { channelId, channels: state.channels, timeZone });
      if (!parsed.ok) return parsed;
      const rule: RepeatRule = { ...parsed.rule, timeZone };
      const firstFrom = (now: number) => nextRepeat(rule, now);
      const first = firstFrom(Date.now());
      if (first === null)
        return {
          ok: false,
          said: "That end date is before the first time it would post. Choose a later one.",
        };
      const target = state.channels[parsed.channelId];
      const place = target && isRoom(target.type) ? `#${target.name}` : "this conversation";
      const how = describeRepeat(rule);
      const shown = parsed.text.length > 80 ? `${parsed.text.slice(0, 79)}…` : parsed.text;
      return {
        ok: "ask",
        said: `Post "${shown}" in ${place} ${how.charAt(0).toLowerCase()}${how.slice(1)}, starting ${formatReminderTime(first)}?`,
        go: async () => {
          // Asked again from now: the first time may have passed while they read.
          const sendAt = firstFrom(Date.now());
          if (sendAt === null)
            return { ok: false, said: "That end date has passed. Choose a later one." };
          const answer = await schedules.repeat(parsed.channelId, {
            text: parsed.text,
            sendAt,
            repeat: rule,
          });
          if (!answer.ok) return { ok: false, said: answer.reason };
          return {
            ok: true,
            said: `Scheduled for ${place}, starting ${formatReminderTime(answer.scheduled.sendAt)}. Change or stop it in Scheduled.`,
          };
        },
      };
    }
    case "mute":
    case "unmute": {
      const error = await client.setChannelPrefs(channelId, { muted: name === "mute" });
      if (error) {
        const failure =
          name === "mute" ? `${cap(where)} was not muted.` : `${cap(where)} is still muted.`;
        return { ok: false, said: failureText(failure, error, offline) };
      }
      return {
        ok: true,
        said: name === "mute" ? `${cap(where)} is muted.` : `${cap(where)} is no longer muted.`,
      };
    }
  }
}

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
