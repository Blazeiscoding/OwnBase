import type { ChannelTimeline, ThreadPage, WorkspaceState } from "@ownbase/client-core";
import type { ID, Message } from "@ownbase/protocol";

interface Held {
  timelines?: Record<ID, Partial<Omit<ChannelTimeline, "ids">> & { items: Message[] }>;
  threads?: Record<ID, Message[]>;
  /** A thread's page with its first message, or null for one gone. */
  threadPages?: Record<ID, Omit<ThreadPage, "rootGone"> & { root: Message | null }>;
}

/**
 * Store state holding these messages where the client keeps them: each once
 * in `messages`, and timelines and threads naming them by id.
 */
export function held({ timelines = {}, threads = {}, threadPages = {} }: Held) {
  const messages: Record<ID, Message> = {};
  const keep = (list: Message[]) =>
    list.map((message) => {
      messages[message.id] = message;
      return message.id;
    });
  return {
    messages,
    timelines: Object.fromEntries(
      Object.entries(timelines).map(([id, { items, ...shape }]) => [
        id,
        { hasMore: false, hasMoreNewer: false, loaded: true, ...shape, ids: keep(items) },
      ]),
    ),
    threads: Object.fromEntries(
      Object.entries(threads).map(([rootId, replies]) => [rootId, keep(replies)]),
    ),
    threadPages: Object.fromEntries(
      Object.entries(threadPages).map(([rootId, { root, ...page }]) => {
        if (root) keep([root]);
        return [rootId, { ...page, rootGone: !root }];
      }),
    ),
  } satisfies Partial<WorkspaceState>;
}
