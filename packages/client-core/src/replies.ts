import {
  replyExcerpt,
  type ForwardReference,
  type ID,
  type Message,
  type ReplyReference,
  type WorkspaceEvent,
} from "@slackoss/protocol";

/** What a reply to `message` shows of it, as the server would quote it. */
export function quoteOf(message: Message, ping: boolean): ReplyReference {
  return {
    id: message.id,
    userId: message.userId,
    text: replyExcerpt(message.text),
    fileCount: message.files.length,
    deleted: false,
    ping,
  };
}

/** The parts of a message a forward passes on. */
export type ForwardSource = Pick<
  Message,
  "id" | "channelId" | "userId" | "text" | "files" | "createdAt"
>;

/**
 * What forwarding `message` passes on, as the server chooses it: the message
 * itself, or what it forwards when it has no words or files of its own. Null
 * when that is hidden here or deleted, which the server would refuse.
 */
export function forwardSource(message: Message): ForwardSource | null {
  const ref = message.forwardedFrom;
  if (!ref || message.text.trim() !== "" || message.files.length > 0) return message;
  if (ref.hidden || ref.deleted) return null;
  return {
    id: ref.id,
    channelId: ref.channelId,
    userId: ref.userId,
    text: ref.text,
    files: ref.files,
    createdAt: ref.createdAt,
  };
}

/**
 * What a forward of `message` into `intoChannelId` shows of it, as the
 * server would, until the server's answer takes its place: everything when
 * the original is in a public channel (`fromPublic`) or the same
 * conversation, and nothing but where it is otherwise.
 */
export function forwardOf(
  message: ForwardSource,
  intoChannelId: ID,
  fromPublic: boolean,
): ForwardReference {
  const shown = fromPublic || message.channelId === intoChannelId;
  return {
    id: message.id,
    channelId: message.channelId,
    userId: shown ? message.userId : "",
    text: shown ? message.text : "",
    files: shown ? message.files : [],
    createdAt: shown ? message.createdAt : 0,
    deleted: false,
    hidden: !shown,
  };
}

/**
 * The messages an event changes for anything quoting them: an edit's new
 * version, or null for those deleted or removed with older history. Null when
 * it changes no message's words.
 */
export function quoteChanges(event: WorkspaceEvent): ReadonlyMap<ID, Message | null> | null {
  if (event.type === "message.updated") return new Map([[event.message.id, event.message]]);
  if (event.type === "message.deleted") return new Map([[event.messageId, null]]);
  if (event.type === "history.removed") return new Map(event.rootIds.map((id) => [id, null]));
  return null;
}

/**
 * Brings the quotes and forwarded cards in `items` up to date with
 * `changes`, for each message `newer` says the change came after. The same
 * array back when nothing in it quotes or forwards a changed message, so a
 * list it does not touch does not render again. A hidden card stays hidden.
 */
export function requote(
  items: Message[],
  changes: ReadonlyMap<ID, Message | null>,
  newer: (id: ID) => boolean = () => true,
): Message[] {
  let changed = false;
  const next = items.map((message) => {
    const quote = message.replyTo;
    const forward = message.forwardedFrom;
    const quoted = !!quote && changes.has(quote.id);
    // An edit changes nothing on a card that shows nothing of it.
    const forwarded =
      !!forward &&
      changes.has(forward.id) &&
      !(changes.get(forward.id) && (forward.hidden || forward.deleted));
    if ((!quoted && !forwarded) || !newer(message.id)) return message;
    changed = true;
    let out = message;
    if (quote && quoted) {
      const now = changes.get(quote.id);
      out = {
        ...out,
        replyTo: now
          ? quoteOf(now, quote.ping)
          : { ...quote, userId: "", text: "", fileCount: 0, deleted: true },
      };
    }
    if (forward && forwarded) {
      const now = changes.get(forward.id);
      out = {
        ...out,
        forwardedFrom: now
          ? forward.hidden || forward.deleted
            ? forward
            : { ...forward, userId: now.userId, text: now.text, files: now.files }
          : { ...forward, userId: "", text: "", files: [], createdAt: 0, deleted: true },
      };
    }
    return out;
  });
  return changed ? next : items;
}
