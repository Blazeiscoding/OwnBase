import { endpoints, escapeMrkdwn, type User } from "@ownbase/protocol";
import { requireChannelAccess, type ServerContext } from "../core/context.js";
import { HttpError } from "../httpError.js";
import type { Posting } from "../messages/posting.js";
import type { AppCalls } from "./calls.js";
import { hostOf } from "./manage.js";
import type { AppReplies } from "./replies.js";
import type { NewTrigger } from "./views.js";

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
  /** Run by the app itself: the server only lists the name and reserves it. */
  inApp?: true;
}

/**
 * Stored pre-escaped, so mrkdwn leaves the arms alone. Computed rather than
 * written out: counting backslashes by hand is how this gets broken.
 */
const SHRUG = escapeMrkdwn("¯\\_(ツ)_/¯");

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
      // The app opens its poll window for this.
      run: () => null,
      inApp: true,
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
      inApp: true,
    },
  ]),
]);

/** Slash commands: the ones apps add, and running any command, built in or an app's. */
export function registerCommands(
  ctx: ServerContext,
  deps: { calls: AppCalls; replies: AppReplies; newTrigger: NewTrigger; posting: Posting },
) {
  const { store, settings, route, mutate, network } = ctx;
  const { calls, replies, newTrigger, posting } = deps;

  route(endpoints.createCommand, async ({ user: me, body, params }) => {
    const owner = store.apps.get(params.id);
    if (!owner) throw new HttpError(404, "not_found");
    if (BUILTIN_COMMANDS.has(body.command) || store.apps.commandByName(body.command)) {
      throw new HttpError(409, "command_taken", `/${body.command} is already in use`);
    }
    const command = store.transaction(() => {
      const created = store.apps.createCommand({
        appId: owner.id,
        command: body.command,
        url: body.url,
        description: body.description ?? "",
        usageHint: body.usageHint ?? "",
      });
      store.audit.record({
        actorId: me.id,
        action: "command.created",
        targetType: "command",
        targetId: created.id,
        details: {
          appId: owner.id,
          name: owner.name,
          command: `/${body.command}`,
          host: hostOf(body.url),
        },
      });
      return created;
    });
    return { command };
  });

  route(endpoints.deleteCommand, async ({ user: me, params }) => {
    const deleted = store.transaction(() => {
      const command = store.apps.getCommand(params.id);
      if (!command || !store.apps.deleteCommand(command.id)) return false;
      store.audit.record({
        actorId: me.id,
        action: "command.deleted",
        targetType: "command",
        targetId: command.id,
        details: {
          appId: command.appId,
          name: store.apps.get(command.appId)?.name ?? null,
          command: `/${command.command}`,
        },
      });
      return true;
    });
    if (!deleted) throw new HttpError(404, "not_found");
    return { ok: true };
  });

  route(endpoints.listCommands, async () => {
    const builtins = [...BUILTIN_COMMANDS.entries()].map(([command, b]) => ({
      command,
      description: b.description,
      usageHint: b.usageHint,
      builtin: true,
    }));
    const fromApps = store.apps.listAllCommands().map((c) => ({
      command: c.command,
      description: c.description,
      usageHint: c.usageHint,
      builtin: false,
    }));
    return { commands: [...builtins, ...fromApps] };
  });

  route(endpoints.runCommand, async ({ req, user: me, body, params }) => {
    const channel = requireChannelAccess(store, params.id, me);
    if (channel.archived) throw new HttpError(400, "channel_archived");
    const threadRootId = body.threadRootId ?? null;

    const parsed = /^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/.exec(body.text.trim());
    if (!parsed) throw new HttpError(400, "not_a_command");
    const name = parsed[1]!.toLowerCase();
    const argText = parsed[2]!.trim();

    const builtin = BUILTIN_COMMANDS.get(name);
    if (builtin) {
      if (builtin.inApp)
        throw new HttpError(400, "in_app_command", `/${name} is run by the app, not the server.`);
      const text = builtin.run(argText, me);
      if (text === null)
        throw new HttpError(400, "usage", `Use it like this: /${name} ${builtin.usageHint}`);
      posting.post({
        poster: { kind: "person", userId: me.id },
        channelId: channel.id,
        text,
        threadRootId,
        nonce: null,
        fileIds: [],
      });
      return { ok: true };
    }

    const found = store.apps.commandByName(name);
    if (!found) throw new HttpError(404, "unknown_command", `/${name} is not a command here`);

    const release = calls.admit(me.id, found.app.id);
    try {
      // The bot has to be in the channel to answer in it.
      mutate((emit) => {
        if (store.channels.addMember(channel.id, found.app.botUserId)) {
          emit({ type: "member.joined", channelId: channel.id, userId: found.app.botUserId });
        }
      });

      const target = {
        channelId: channel.id,
        invokerId: me.id,
        botUserId: found.app.botUserId,
        threadRootId,
      };
      const form = new URLSearchParams({
        command: `/${name}`,
        text: argText,
        team_id: settings.get("workspaceId"),
        team_domain: settings.get("workspaceName"),
        channel_id: channel.id,
        channel_name: channel.name,
        user_id: me.id,
        user_name: me.handle,
        api_app_id: found.app.id,
        response_url: replies.newResponseUrl(target, network.requestOrigin(req)),
        trigger_id: newTrigger({
          userId: me.id,
          channelId: channel.id,
          appId: found.app.id,
          botUserId: found.app.botUserId,
        }),
      }).toString();

      let why: string;
      try {
        const res = await calls.postForm(found.app.id, found.command.url, form);
        if (res.status >= 200 && res.status < 300) {
          replies.deliverReply(target, res.body, res.contentType);
          return { ok: true };
        }
        why = `the app answered ${res.status}`;
      } catch (err) {
        why = calls.whyFailed(err);
      }
      // Why it failed goes in the answer as well as to the channel: a test
      // from Apps and integrations is drawn over the conversation the note
      // lands in.
      calls.sayEphemeral(channel.id, me.id, found.app.botUserId, `\`/${name}\` failed: ${why}.`);
      return { ok: false, error: "command_failed", message: why };
    } finally {
      release();
    }
  });
}
