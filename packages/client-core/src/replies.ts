import {
  replyExcerpt,
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
 * Brings the quotes in `items` up to date with `changes`, for each message
 * `newer` says the change came after. The same array back when nothing in it
 * quotes a changed message, so a list it does not touch does not render again.
 */
export function requote(
  items: Message[],
  changes: ReadonlyMap<ID, Message | null>,
  newer: (id: ID) => boolean = () => true,
): Message[] {
  let changed = false;
  const next = items.map((message) => {
    const quote = message.replyTo;
    if (!quote || !changes.has(quote.id) || !newer(message.id)) return message;
    const now = changes.get(quote.id);
    changed = true;
    return {
      ...message,
      replyTo: now
        ? quoteOf(now, quote.ping)
        : { ...quote, userId: "", text: "", fileCount: 0, deleted: true },
    };
  });
  return changed ? next : items;
}
