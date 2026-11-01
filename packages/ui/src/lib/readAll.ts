import type { WorkspaceClient, WorkspaceState } from "@ownbase/client-core";
import type { ID } from "@ownbase/protocol";

/** Conversations and followed threads with something unread, as Mark all read clears them. */
export function unreadEverywhere(state: WorkspaceState): {
  channels: [ID, number][];
  threads: WorkspaceState["threadFollows"][ID][];
} {
  const channels: [ID, number][] = [];
  for (const [channelId, read] of Object.entries(state.memberships)) {
    const newest = state.channelLastSeq[channelId] ?? 0;
    if (newest > read) channels.push([channelId, newest]);
  }
  const threads = Object.values(state.threadFollows).filter(
    (follow) => follow.following && follow.lastSeq > follow.lastReadSeq,
  );
  return { channels, threads };
}

/**
 * Reads every conversation and followed thread to its newest. Returns how many
 * there were, so whoever asked can say so.
 */
export function markEverythingRead(client: WorkspaceClient): number {
  const { channels, threads } = unreadEverywhere(client.state);
  for (const [channelId, newest] of channels)
    client.markRead(channelId, newest, { explicit: true });
  for (const follow of threads)
    client.markThreadRead(follow.rootId, {
      explicit: true,
      through: { channelId: follow.channelId, seq: follow.lastSeq },
    });
  return channels.length + threads.length;
}

/** "3 conversations", "1 thread", "2 conversations and 1 thread". */
export function unreadSummary(channels: number, threads: number): string {
  const parts: string[] = [];
  if (channels) parts.push(`${channels} conversation${channels === 1 ? "" : "s"}`);
  if (threads) parts.push(`${threads} thread${threads === 1 ? "" : "s"}`);
  return parts.join(" and ");
}
