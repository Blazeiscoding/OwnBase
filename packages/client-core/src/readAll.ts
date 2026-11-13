import type { ID, Message, ThreadFollow } from "@ownbase/protocol";
import type { ApiError } from "./transport.js";
import { failureOf } from "./answers.js";
import { isThreadUnread, isUnread } from "./selectors.js";
import { isMessageRead, type WorkspaceClient, type WorkspaceState } from "./workspace.js";

/** How many pages of mentions marking everything read looks through at most. */
const MENTION_PAGES = 10;

/** What Mark all read reads, as Activity and Shift+Esc both count it. */
export interface Unread {
  /** Conversations with something unread, or an unread mention in a thread of theirs. */
  channels: ID[];
  /** Followed threads with an unread reply. */
  threads: ThreadFollow[];
  /** Notes that someone removed this account from a channel, not yet read. */
  removals: ID[];
}

export function unreadEverywhere(
  state: Pick<
    WorkspaceState,
    "memberships" | "channelLastSeq" | "mentionCounts" | "threadFollows" | "channelRemovals"
  >,
): Unread {
  return {
    channels: Object.keys(state.memberships).filter(
      (id) => isUnread(state, id) || (state.mentionCounts[id] ?? 0) > 0,
    ),
    threads: Object.values(state.threadFollows).filter(isThreadUnread),
    removals: Object.keys(state.channelRemovals),
  };
}

/** Whether Mark all read has anything to read. */
export function anythingUnread(state: Parameters<typeof unreadEverywhere>[0]): boolean {
  const { channels, threads, removals } = unreadEverywhere(state);
  return channels.length + threads.length + removals.length > 0;
}

/**
 * Reads everything: every conversation and followed thread to its newest,
 * and every note of a removal. A reply naming this account in a thread it
 * does not follow is read only through that thread, and nothing on the
 * device lists those, so while the mention counts say any are unread they
 * are looked up among the mentions, newest first, a page at a time. Gives
 * back why something could not be read.
 */
export async function markEverythingRead(client: WorkspaceClient): Promise<ApiError | null> {
  const before = client.state;
  for (const channelId of Object.keys(before.memberships))
    if (isUnread(before, channelId))
      client.markRead(channelId, before.channelLastSeq[channelId]!, { explicit: true });
  for (const follow of Object.values(before.threadFollows).filter(isThreadUnread))
    client.markThreadRead(follow.rootId, {
      explicit: true,
      through: { channelId: follow.channelId, seq: follow.lastSeq },
    });
  const [removals, mentions] = await Promise.all([
    client.readChannelRemovals(Object.keys(before.channelRemovals)),
    readMentionedThreads(client, before),
  ]);
  return removals ?? mentions;
}

async function readMentionedThreads(
  client: WorkspaceClient,
  before: WorkspaceState,
): Promise<ApiError | null> {
  const waiting = Object.values(before.mentionCounts).reduce((sum, n) => sum + n, 0);
  if (waiting === 0) return null;
  const newest = new Map<ID, Message>();
  let found = 0;
  let cursor: ID | undefined;
  try {
    for (let page = 0; page < MENTION_PAGES && found < waiting; page++) {
      const { messages, nextCursor } = await client.api.activity("mentions", { cursor });
      for (const message of messages) {
        if (isMessageRead(message, before)) continue;
        found++;
        const rootId = message.threadRootId;
        if (!rootId || message.broadcast || before.threadFollows[rootId]?.following) continue;
        if ((newest.get(rootId)?.seq ?? 0) < message.seq) newest.set(rootId, message);
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }
  } catch (error) {
    return failureOf(error);
  }
  for (const [rootId, message] of newest)
    client.markThreadRead(rootId, { explicit: true, through: message });
  return null;
}
