import {
  MESSAGE_TEXT_MAX,
  type App,
  type AppScope,
  type CallNotice,
  type Channel,
  type EventEnvelope,
  type ID,
  type Message,
  type MessageAction,
  type ScheduledMessage,
  type WorkspaceEvent,
} from "@ownbase/protocol";
import { hashToken } from "../auth.js";
import { HttpError } from "../httpError.js";
import type { Limits } from "../limits.js";
import type { Store } from "../store.js";

/**
 * Who a message is from, which decides the rules it meets. Every way into a
 * conversation names one: the app's own composer and built-in commands post
 * as a person; Slack's chat.postMessage as an app's bot, by its token; an
 * incoming webhook as its app's bot, for whoever holds its url; and an app's
 * answer to a command or a button as its bot, through what that person did.
 */
export type Poster =
  | { kind: "person"; userId: ID }
  | { kind: "bot"; app: App }
  | { kind: "webhook"; app: App; webhookId: ID }
  | { kind: "appReply"; botUserId: ID };

export interface PostInput {
  poster: Poster;
  channelId: ID;
  text: string;
  threadRootId: ID | null;
  nonce: string | null;
  fileIds: ID[];
  actions?: MessageAction[];
  /** For a reply: show it in the channel's own timeline as well. */
  broadcast?: boolean;
  /** The message this one answers in place, in the same conversation. */
  replyToId?: ID | null;
  /** Notify that message's author. */
  replyPing?: boolean;
  /** A message to pass on under this one, from anywhere the sender can read. */
  forwardFromId?: ID | null;
  /** Makes it a poll, its words the question (E6). */
  poll?: { options: string[]; multiple: boolean; anonymous: boolean } | null;
  /** Delivers this queue row, marked sent in the same transaction as the message. */
  scheduledId?: ID;
  /** Makes it the server's note about a call (E10); never from a request. */
  call?: CallNotice;
}

export interface ScheduleInput {
  userId: ID;
  channelId: ID;
  text: string;
  threadRootId: ID | null;
  fileIds: ID[];
  sendAt: number;
  broadcast: boolean;
  nonce: string | null;
}

/** A refusal that names the scope the app's token would need, as Slack's does. */
export class ScopeNeeded extends HttpError {
  constructor(
    code: "missing_scope" | "not_in_channel",
    readonly needed: AppScope,
  ) {
    super(403, code);
  }
}

/** The words of a message, posted or rewritten by an app, fit within the limit. */
export function requireMessageText(text: string): void {
  if (text.length > MESSAGE_TEXT_MAX)
    throw new HttpError(
      400,
      "msg_too_long",
      `A message can be at most ${MESSAGE_TEXT_MAX.toLocaleString("en-US")} characters.`,
    );
}

export interface PostingDeps {
  store: Store;
  /** Runs `work` in one transaction and publishes the events it records once committed. */
  mutate<T>(work: (record: (event: WorkspaceEvent) => EventEnvelope) => T): T;
  /** Spends one unit of a limit, or throws the 429 that says when to come back. */
  ration(name: keyof Limits, key: string): void;
  queuePreviews(message: Message): void;
  scheduledLimits: { perAccount: number; perWorkspace: number };
}

export interface Posting {
  /** Posts a message from anyone, under every rule a message meets, and fans it out. */
  post(input: PostInput): Message;
  /** Queues a message for later, refusing now what sending would refuse then. */
  schedule(input: ScheduleInput): { scheduled: ScheduledMessage; replayed: boolean };
}

const userIdOf = (poster: Poster): ID =>
  poster.kind === "person"
    ? poster.userId
    : poster.kind === "appReply"
      ? poster.botUserId
      : poster.app.botUserId;

export function createPosting({
  store,
  mutate,
  ration,
  queuePreviews,
  scheduledLimits,
}: PostingDeps): Posting {
  /**
   * The budget a post spends: the account's or bot's, not its address's, so a
   * whole office behind one address does not share one person's allowance.
   * A webhook has one of its own: whoever holds its url posts with no account
   * behind them, so it neither spends a person's nor starves the app's other
   * webhooks.
   */
  const spend = (poster: Poster): void => {
    if (poster.kind === "webhook") ration("hook", poster.webhookId);
    else ration("post", userIdOf(poster));
  };

  /** Where the poster may write: the conversation, or why not. */
  const writableChannel = (poster: Poster, channelId: ID): Channel => {
    const userId = userIdOf(poster);
    const channel = store.getChannel(channelId);
    if (!channel) throw new HttpError(404, "channel_not_found");
    if (poster.kind === "person" && !store.canAccess(channel.id, userId))
      throw new HttpError(404, "channel_not_found");
    if (store.getUser(userId)?.deactivated) throw new HttpError(403, "account_deactivated");
    if (channel.archived) throw new HttpError(400, "channel_archived");
    // An app's bot posts where it was added. A public channel it was never
    // added to takes Slack's chat:write.public through the Web API; a webhook
    // or an answer to someone there is posting where it was asked to.
    if (poster.kind !== "person" && !store.isMember(channel.id, userId)) {
      if (channel.type !== "public") throw new HttpError(403, "not_in_channel");
      if (poster.kind === "bot" && !poster.app.scopes?.includes("chat:write.public"))
        throw new ScopeNeeded("not_in_channel", "chat:write.public");
    }
    return channel;
  };

  const requireThreadRoot = (channel: Channel, threadRootId: ID | null): void => {
    if (!threadRootId) return;
    const root = store.getMessage(threadRootId);
    if (!root || root.channelId !== channel.id || root.threadRootId)
      throw new HttpError(400, "bad_thread_root");
  };

  const requireText = (text: string, carriesMore: boolean): void => {
    requireMessageText(text);
    if (!text.trim() && !carriesMore) throw new HttpError(400, "empty_message");
  };

  const post = (input: PostInput): Message => {
    const { poster } = input;
    if (poster.kind === "bot" && !poster.app.scopes?.includes("chat:write"))
      throw new ScopeNeeded("missing_scope", "chat:write");
    // Queuing a message spent the budget once, so its delivery is never held
    // back; a note about a call is the server's, not a request.
    if (!input.scheduledId && !input.call) spend(poster);
    const userId = userIdOf(poster);

    const message = mutate((record) => {
      const channel = writableChannel(poster, input.channelId);
      // As with uploads: a guest takes part, and votes, but does not make polls.
      if (input.poll && store.getUser(userId)?.role === "guest")
        throw new HttpError(
          403,
          "guest_not_allowed",
          "Guests cannot make polls. Create an account to make one.",
        );
      requireText(input.text, input.fileIds.length > 0 || !!input.forwardFromId);
      const requestHash = hashToken(
        JSON.stringify([
          input.channelId,
          input.text,
          input.threadRootId,
          input.broadcast ?? false,
          [...input.fileIds].sort(),
          // Absent unless it answers something, so a request recorded before still matches.
          ...(input.replyToId ? [input.replyToId, input.replyPing ?? false] : []),
          ...(input.forwardFromId ? [{ forward: input.forwardFromId }] : []),
          ...(input.poll ? [{ poll: input.poll }] : []),
        ]),
      );
      if (input.nonce !== null) {
        const previous = store.messageRequest(userId, input.nonce);
        if (previous) {
          const existing = store.getMessage(previous.messageId);
          if (!existing) throw new HttpError(409, "message_deleted");
          if (
            (previous.requestHash !== null && previous.requestHash !== requestHash) ||
            existing.channelId !== input.channelId ||
            existing.threadRootId !== input.threadRootId
          ) {
            throw new HttpError(409, "nonce_conflict");
          }
          return existing;
        }
        // Posted once, then removed with the workspace's older history.
        if (store.messageRequestPurged(userId, input.nonce))
          throw new HttpError(
            409,
            "message_deleted",
            "This was already sent, and has since been removed with older messages.",
          );
      }
      // A poll is a question and its choices; files or a forward would be a second message.
      if (input.poll && (input.fileIds.length > 0 || input.forwardFromId))
        throw new HttpError(400, "bad_poll", "A poll cannot carry files or a forwarded message.");
      requireThreadRoot(channel, input.threadRootId);
      // A reply answers something in its own conversation: in a channel, what
      // the channel shows; in a thread, its first message or another reply.
      // Deleted since it was chosen, it still goes and says so; removed with
      // older history, it goes as an ordinary message.
      const target = input.replyToId ? store.replyTarget(input.replyToId) : null;
      if (
        target &&
        (target.channelId !== channel.id ||
          (input.threadRootId
            ? input.replyToId !== input.threadRootId && target.threadRootId !== input.threadRootId
            : target.threadRootId !== null && !target.broadcast))
      )
        throw new HttpError(400, "bad_reply_target");
      if (channel.type === "public" && !store.isMember(channel.id, userId)) {
        store.addMember(channel.id, userId);
        record({ type: "member.joined", channelId: channel.id, userId });
      }
      // A file a scheduled message is waiting to send is already promised.
      if (store.files.heldBySchedule(input.fileIds, input.scheduledId ?? null))
        throw new HttpError(
          409,
          "attachments_scheduled",
          "One of these files is part of a scheduled message. Cancel that message to use it here.",
        );
      // A forward passes on something its sender can read now, wherever it is.
      // A forward with nothing of its own passes on what it forwards instead,
      // so a message forwarded twice still shows itself rather than an empty card.
      let forwardedFromId: ID | null = null;
      if (input.forwardFromId) {
        const readable = (id: ID) => {
          const found = store.forwardSource(id);
          return found && !found.deleted && store.canAccess(found.channelId, userId) ? found : null;
        };
        const picked = readable(input.forwardFromId);
        if (!picked)
          throw new HttpError(
            404,
            "message_not_found",
            "That message is no longer there to forward.",
          );
        // One whose original its sender cannot read, or that is gone, has
        // nothing to pass on: its own card is all it shows.
        const source =
          picked.bare && picked.forwardedFromId ? readable(picked.forwardedFromId) : picked;
        if (!source)
          throw new HttpError(
            409,
            "forward_unavailable",
            "What that message forwards is private or deleted, so it cannot be passed on.",
          );
        forwardedFromId = source.id;
      }
      const created = store.createMessage({
        channelId: input.channelId,
        userId,
        text: input.text,
        threadRootId: input.threadRootId,
        nonce: input.nonce,
        actions: input.actions,
        broadcast: input.broadcast,
        replyToId: target ? input.replyToId : null,
        replyPing: input.replyPing,
        forwardedFromId,
        call: input.call,
      });
      if (input.poll) store.polls.create(created.id, input.poll);
      if (
        !store.files.attach(
          input.fileIds,
          created.id,
          input.channelId,
          userId,
          input.scheduledId ?? null,
        )
      )
        throw new HttpError(400, "invalid_attachments");
      const hydrated = store.getMessage(created.id)!;
      if (input.nonce !== null)
        store.recordMessageRequest(userId, input.nonce, created.id, requestHash);
      if (input.scheduledId) store.scheduled.markSent(input.scheduledId, created.id);
      record({ type: "message.created", message: hydrated });
      return hydrated;
    });
    queuePreviews(message);
    return message;
  };

  const schedule = (input: ScheduleInput) => {
    const poster: Poster = { kind: "person", userId: input.userId };
    const requestHash = hashToken(
      JSON.stringify([
        input.channelId,
        input.text,
        input.threadRootId,
        [...input.fileIds].sort(),
        input.sendAt,
        // Absent when false, so a request recorded before this existed still matches.
        ...(input.broadcast ? [true] : []),
      ]),
    );
    return mutate(() => {
      const channel = writableChannel(poster, input.channelId);
      if (input.nonce) {
        const previous = store.scheduled.request(input.userId, input.nonce);
        if (previous) {
          if (previous.requestHash !== requestHash) throw new HttpError(409, "nonce_conflict");
          const scheduled = store.scheduled.get(previous.scheduledId);
          if (!scheduled)
            throw new HttpError(
              410,
              "scheduled_removed",
              "This message was already scheduled, and has since been removed. OwnBase will not schedule it again.",
            );
          return { scheduled, replayed: true };
        }
      }
      if (input.sendAt <= Date.now()) {
        throw new HttpError(400, "send_at_in_past", "Choose a time in the future.");
      }
      // Queuing validates what sending validates, so a message cannot sit in the
      // queue for hours only to be rejected when it comes due.
      requireText(input.text, input.fileIds.length > 0);
      requireThreadRoot(channel, input.threadRootId);
      if (
        new Set(input.fileIds).size !== input.fileIds.length ||
        !store.files.unattached(input.fileIds, channel.id, input.userId)
      ) {
        throw new HttpError(400, "invalid_attachments");
      }
      if (store.files.heldBySchedule(input.fileIds)) {
        throw new HttpError(
          409,
          "attachments_scheduled",
          "One of these files is already part of another scheduled message.",
        );
      }
      if (store.scheduled.outstanding(input.userId) >= scheduledLimits.perAccount) {
        throw new HttpError(
          409,
          "scheduled_limit",
          `You already have ${scheduledLimits.perAccount} messages waiting to be sent. Send or cancel some before scheduling more.`,
        );
      }
      if (store.scheduled.outstanding() >= scheduledLimits.perWorkspace) {
        throw new HttpError(
          409,
          "scheduled_limit",
          "This workspace has as many scheduled messages waiting as it holds. Try again once some have been sent.",
        );
      }
      // Spent here, once: a replay has already returned, and delivery spends nothing.
      spend(poster);
      const scheduled = store.scheduled.schedule({
        channelId: channel.id,
        userId: input.userId,
        text: input.text,
        threadRootId: input.threadRootId,
        fileIds: input.fileIds,
        sendAt: input.sendAt,
        broadcast: input.broadcast,
      });
      if (input.nonce)
        store.scheduled.recordRequest(input.userId, input.nonce, scheduled.id, requestHash);
      return { scheduled, replayed: false };
    });
  };

  return { post, schedule };
}

/**
 * A refusal as Slack words it, for everything an app or a webhook posts
 * through: the status an incoming webhook or a response url answers with, and
 * the `error` all of them carry. Where Slack's word differs from ours, theirs
 * is what its SDKs and existing integrations check for.
 *
 * Anything else is thrown on, as is a rate limit: Slack's SDKs read a 429
 * and its retry-after, which the REST answer already carries.
 */
export function slackRefusal(err: unknown): {
  status: number;
  error: string;
  needed?: AppScope;
} {
  if (!(err instanceof HttpError) || err.statusCode === 429) throw err;
  const needed = err instanceof ScopeNeeded ? { needed: err.needed } : {};
  switch (err.code) {
    // Slack's answer for an archived channel would be is_archived; this
    // server has always said channel_not_found, and integrations handle that.
    case "channel_archived":
      return { status: 404, error: "channel_not_found" };
    case "empty_message":
      return { status: 400, error: "no_text" };
    default:
      return { status: err.statusCode, error: err.code, ...needed };
  }
}
