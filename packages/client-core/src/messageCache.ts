import type { EventEnvelope, ID, Message, WorkspaceEvent } from "@ownbase/protocol";
import { quoteChanges, requote } from "./replies.js";

export interface ChannelTimeline {
  /** Channel message watermark represented by this loaded tail, not future arrivals. */
  readThroughSeq?: number;
  /** Creation events through this seq are already represented by `ids`. */
  snapshotSeq?: number;
  /** Oldest → newest: top-level messages, and replies also sent to the channel. */
  ids: ID[];
  /** More history exists before the first loaded message. */
  hasMore: boolean;
  /**
   * True when the view is anchored mid-history (after a jump) rather than at
   * the tail. Live messages are not appended while this holds, since they are
   * not actually adjacent to what is on screen.
   */
  hasMoreNewer: boolean;
  loaded: boolean;
}

export interface ThreadPage {
  channelId: ID;
  /** The first message is deleted, removed with older history, or was never found. */
  rootGone: boolean;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

/**
 * Every message this client holds, each once. Timelines and threads list ids
 * into `messages`; a message no list names is let go.
 */
export interface MessageCache {
  messages: Record<ID, Message>;
  /**
   * The seq through which each held message reflects every event about it.
   * A page read at a later seq replaces it; an event at or below it is
   * already in it.
   */
  messageSeqs: Record<ID, number>;
  timelines: Record<ID, ChannelTimeline>;
  /** threadRootId -> reply ids, oldest → newest. */
  threads: Record<ID, ID[]>;
  threadPages: Record<ID, ThreadPage>;
}

/**
 * The most messages one channel keeps loaded, and therefore the most rows the
 * timeline ever renders. History is unbounded on the server, so without a cap
 * a long scrollback, or a long sitting in a busy channel, grows one flat list
 * until every keystroke restyles thousands of nodes.
 */
const MAX_TIMELINE_ITEMS = 300;
export const THREAD_WINDOW = 300;

export type MessageEvent = Extract<
  WorkspaceEvent,
  {
    type:
      | "message.created"
      | "message.updated"
      | "message.deleted"
      | "reaction.added"
      | "reaction.removed"
      | "pin.added"
      | "pin.removed"
      | "history.removed";
  }
>;

export function isMessageEvent(event: WorkspaceEvent): event is MessageEvent {
  switch (event.type) {
    case "message.created":
    case "message.updated":
    case "message.deleted":
    case "reaction.added":
    case "reaction.removed":
    case "pin.added":
    case "pin.removed":
    case "history.removed":
      return true;
    case "channel.created":
    case "channel.updated":
    case "member.joined":
    case "member.left":
    case "user.joined":
    case "user.updated":
      return false;
    default:
      return unhandled(event);
  }
}

/** Fails to compile where a switch leaves out one of a union's members. */
export function unhandled(value: never): never {
  throw new Error(`Unhandled ${JSON.stringify(value)}`);
}

export function messageEventChannel(event: MessageEvent): ID {
  return "message" in event ? event.message.channelId : event.channelId;
}

/** Oldest → newest by id, which the server orders by time. */
function insertId(ids: ID[], id: ID): ID[] {
  if (ids.length === 0 || ids[ids.length - 1]! < id) return [...ids, id];
  if (ids.includes(id)) return ids;
  return [...ids, id].sort();
}

export function withReaction(message: Message, emoji: string, userId: ID, on: boolean): Message {
  const had = message.reactions.find((group) => group.emoji === emoji)?.userIds ?? [];
  if (had.includes(userId) === on) return message;
  const userIds = on ? [...had, userId] : had.filter((id) => id !== userId);
  const reactions = message.reactions.filter((group) => group.emoji !== emoji);
  if (userIds.length > 0) reactions.push({ emoji, userIds });
  return { ...message, reactions };
}

/** Every id some list still names, so the message stays held. */
function referenced(cache: MessageCache): Set<ID> {
  const ids = new Set<ID>();
  for (const timeline of Object.values(cache.timelines)) for (const id of timeline.ids) ids.add(id);
  for (const replies of Object.values(cache.threads)) for (const id of replies) ids.add(id);
  for (const [rootId, page] of Object.entries(cache.threadPages))
    if (!page.rootGone) ids.add(rootId);
  return ids;
}

export function forgetUnlisted(cache: MessageCache, ids: Iterable<ID>): MessageCache {
  const candidates = [...ids].filter((id) => id in cache.messages);
  if (candidates.length === 0) return cache;
  const kept = referenced(cache);
  const gone = candidates.filter((id) => !kept.has(id));
  if (gone.length === 0) return cache;
  const messages = { ...cache.messages };
  const messageSeqs = { ...cache.messageSeqs };
  for (const id of gone) {
    delete messages[id];
    delete messageSeqs[id];
  }
  return { ...cache, messages, messageSeqs };
}

export function forgetAllUnlisted(cache: MessageCache): MessageCache {
  return forgetUnlisted(cache, Object.keys(cache.messages));
}

/**
 * Keeps messages read at `seq`. A held copy that already reflects a later
 * event stays; any other is replaced, so what a page says wins over what it
 * was read after.
 */
export function keepMessages(
  cache: MessageCache,
  incoming: readonly Message[],
  seq: number | undefined,
): MessageCache {
  if (incoming.length === 0) return cache;
  const messages = { ...cache.messages };
  const messageSeqs = { ...cache.messageSeqs };
  for (const message of incoming) {
    if (seq !== undefined && (messageSeqs[message.id] ?? 0) > seq) continue;
    messages[message.id] = message;
    messageSeqs[message.id] = seq ?? 0;
  }
  return { ...cache, messages, messageSeqs };
}

/** Marks every event through `seq` as reflected in these held messages. */
export function stampMessages(cache: MessageCache, ids: readonly ID[], seq: number): MessageCache {
  let messageSeqs: Record<ID, number> | null = null;
  for (const id of ids) {
    if (!(id in cache.messages) || (cache.messageSeqs[id] ?? 0) >= seq) continue;
    (messageSeqs ??= { ...cache.messageSeqs })[id] = seq;
  }
  return messageSeqs ? { ...cache, messageSeqs } : cache;
}

/** One held message changed here, not by an event: a choice shown before the server has it. */
export function patchMessage(
  cache: MessageCache,
  id: ID,
  change: (message: Message) => Message,
): MessageCache {
  const message = cache.messages[id];
  if (!message) return cache;
  const next = change(message);
  return next === message ? cache : { ...cache, messages: { ...cache.messages, [id]: next } };
}

/**
 * Trims a timeline back to the cap from one end, and marks that end pageable
 * again so scrolling back toward it refetches what was dropped. Six pages is
 * several screens either way, so the trim happens far outside the viewport.
 */
export function windowTimeline(
  cache: MessageCache,
  channelId: ID,
  drop: "oldest" | "newest",
): MessageCache {
  const timeline = cache.timelines[channelId];
  if (!timeline) return cache;
  const excess = timeline.ids.length - MAX_TIMELINE_ITEMS;
  if (excess <= 0) return cache;
  const next =
    drop === "oldest"
      ? { ...timeline, ids: timeline.ids.slice(excess), hasMore: true }
      : { ...timeline, ids: timeline.ids.slice(0, MAX_TIMELINE_ITEMS), hasMoreNewer: true };
  const dropped =
    drop === "oldest" ? timeline.ids.slice(0, excess) : timeline.ids.slice(MAX_TIMELINE_ITEMS);
  return forgetUnlisted(
    { ...cache, timelines: { ...cache.timelines, [channelId]: next } },
    dropped,
  );
}

/**
 * Applies one event to the messages held: a live one, one replayed onto a
 * page read before it, or the server's answer to a send arriving ahead of
 * its event. Only `inOrder` events, applied after every one before them,
 * mark the messages they change as up to date through their seq.
 */
export function reduceMessages(
  cache: MessageCache,
  envelope: EventEnvelope & { event: MessageEvent },
  inOrder: boolean,
): MessageCache {
  const { event, seq } = envelope;
  let { messages, messageSeqs, timelines, threads, threadPages } = cache;
  const dropped: ID[] = [];
  const newer = (id: ID) => seq > (messageSeqs[id] ?? 0);
  const stamp = (id: ID) => {
    if (inOrder && id in messages && newer(id)) messageSeqs = { ...messageSeqs, [id]: seq };
  };
  const change = (id: ID, fn: (message: Message) => Message) => {
    const message = messages[id];
    if (!message || !newer(id)) return;
    const next = fn(message);
    if (next !== message) messages = { ...messages, [id]: next };
    stamp(id);
  };
  const requoteHeld = (changes: ReadonlyMap<ID, Message | null>) => {
    let next: Record<ID, Message> | null = null;
    for (const [id, message] of Object.entries(messages)) {
      const [requoted] = requote([message], changes, newer);
      if (requoted !== message) (next ??= { ...messages })[id] = requoted!;
    }
    if (next) messages = next;
  };

  switch (event.type) {
    case "message.created": {
      const message = { ...event.message, seq };
      const known = message.id in messages;
      const timeline = timelines[message.channelId];
      const rootId = message.threadRootId;
      let listed = false;
      if (rootId) {
        const replies = threads[rootId];
        const page = threadPages[rootId];
        if (replies && !page?.hasMoreNewer) {
          const ids = insertId(replies, message.id);
          if (ids !== replies) {
            listed = true;
            const kept = ids.slice(-THREAD_WINDOW);
            dropped.push(...ids.slice(0, ids.length - kept.length));
            threads = { ...threads, [rootId]: kept };
            if (page && kept.length < ids.length)
              threadPages = { ...threadPages, [rootId]: { ...page, hasMoreOlder: true } };
          }
        }
        if (
          timeline?.loaded &&
          !timeline.hasMoreNewer &&
          newer(rootId) &&
          timeline.ids.includes(rootId)
        )
          timelines = {
            ...timelines,
            [message.channelId]: {
              ...timeline,
              readThroughSeq: Math.max(timeline.readThroughSeq ?? 0, seq),
            },
          };
        change(rootId, (root) => ({ ...root, replyCount: root.replyCount + 1 }));
      }
      const tl = timelines[message.channelId];
      if (
        (!rootId || message.broadcast) &&
        tl?.loaded &&
        !tl.hasMoreNewer &&
        seq > (tl.snapshotSeq ?? 0)
      ) {
        listed = true;
        timelines = {
          ...timelines,
          [message.channelId]: {
            ...tl,
            ids: insertId(tl.ids, message.id),
            readThroughSeq: Math.max(tl.readThroughSeq ?? 0, seq),
          },
        };
      }
      if (listed || (known && newer(message.id))) {
        messages = { ...messages, [message.id]: message };
        messageSeqs = { ...messageSeqs, [message.id]: Math.max(messageSeqs[message.id] ?? 0, seq) };
      }
      break;
    }
    case "message.updated": {
      change(event.message.id, () => event.message);
      // Previews found or removed, or a poll's votes, are not an edit: nothing
      // quoting the message changes (E2, E6).
      if (!event.previewsOnly && !event.pollOnly) requoteHeld(quoteChanges(event)!);
      break;
    }
    case "message.deleted": {
      const { messageId, threadRootId, channelId } = event;
      if (messageId in messages && newer(messageId)) {
        dropped.push(messageId);
        const tl = timelines[channelId];
        if (tl?.ids.includes(messageId))
          timelines = {
            ...timelines,
            [channelId]: { ...tl, ids: tl.ids.filter((id) => id !== messageId) },
          };
        for (const [rootId, replies] of Object.entries(threads))
          if (replies.includes(messageId))
            threads = { ...threads, [rootId]: replies.filter((id) => id !== messageId) };
      }
      if (threads[messageId]) {
        dropped.push(...threads[messageId]!);
        threads = { ...threads, [messageId]: [] };
      }
      const page = threadPages[messageId];
      if (page && !page.rootGone)
        threadPages = { ...threadPages, [messageId]: { ...page, rootGone: true } };
      if (threadRootId)
        change(threadRootId, (root) => ({ ...root, replyCount: Math.max(0, root.replyCount - 1) }));
      requoteHeld(quoteChanges(event)!);
      break;
    }
    case "reaction.added":
    case "reaction.removed":
      change(event.messageId, (message) =>
        withReaction(message, event.emoji, event.userId, event.type === "reaction.added"),
      );
      break;
    case "pin.added":
    case "pin.removed": {
      const pinned = event.type === "pin.added";
      change(event.messageId, (message) =>
        message.pinned === pinned ? message : { ...message, pinned },
      );
      break;
    }
    case "history.removed": {
      // Whole threads went, first message and replies: what is held of them goes too.
      const gone = new Set(event.rootIds);
      const removed = (id: ID) => {
        const threadRootId = messages[id]?.threadRootId;
        return gone.has(id) || (!!threadRootId && gone.has(threadRootId));
      };
      const tl = timelines[event.channelId];
      if (tl?.ids.some(removed)) {
        dropped.push(...tl.ids.filter(removed));
        timelines = {
          ...timelines,
          [event.channelId]: { ...tl, ids: tl.ids.filter((id) => !removed(id)) },
        };
      }
      if (event.rootIds.some((id) => id in threads || id in threadPages)) {
        threads = { ...threads };
        threadPages = { ...threadPages };
        for (const rootId of gone) {
          dropped.push(rootId, ...(threads[rootId] ?? []));
          delete threads[rootId];
          delete threadPages[rootId];
        }
      }
      requoteHeld(quoteChanges(event)!);
      break;
    }
    default:
      unhandled(event);
  }
  const next = { messages, messageSeqs, timelines, threads, threadPages };
  return dropped.length > 0 ? forgetUnlisted(next, dropped) : next;
}

const NONE: Message[] = [];
const resolved = new WeakMap<readonly ID[], Message[]>();

/**
 * The messages `ids` name, in order. The same array as last time while every
 * message in it is the same, so a list that did not change does not render
 * again when another message does.
 */
function messagesOf(ids: readonly ID[], messages: Record<ID, Message>): Message[] {
  const out: Message[] = [];
  for (const id of ids) {
    const message = messages[id];
    if (message) out.push(message);
  }
  const before = resolved.get(ids);
  if (before && before.length === out.length && before.every((m, i) => m === out[i])) return before;
  resolved.set(ids, out);
  return out;
}

type HeldMessages = Pick<MessageCache, "messages" | "timelines" | "threads" | "threadPages">;

/** A channel's loaded messages, oldest → newest. */
export function timelineMessages(state: HeldMessages, channelId: ID): Message[] {
  const timeline = state.timelines[channelId];
  return timeline ? messagesOf(timeline.ids, state.messages) : NONE;
}

/** A thread's loaded replies, oldest → newest; undefined when none are loaded. */
export function threadReplies(state: HeldMessages, rootId: ID): Message[] | undefined {
  const replies = state.threads[rootId];
  return replies ? messagesOf(replies, state.messages) : undefined;
}

/** A thread's first message, while it is held and not gone. */
export function threadRootMessage(state: HeldMessages, rootId: ID): Message | null {
  if (state.threadPages[rootId]?.rootGone) return null;
  return state.messages[rootId] ?? null;
}
