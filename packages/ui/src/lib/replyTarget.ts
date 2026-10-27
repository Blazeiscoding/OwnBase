import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { WorkspaceClient } from "@ownbase/client-core";
import type { ID, Message } from "@ownbase/protocol";

/** A message the next send in one conversation answers, as Discord's Reply. */
export interface ReplyTarget {
  /** What is being answered, as it was when Reply was chosen. */
  message: Message;
  /** Whether its author is notified; Discord's "@ On". */
  ping: boolean;
  /** Counts each choice of Reply, so choosing it again brings the box back into focus. */
  asked: number;
}

type Targets = Record<string, ReplyTarget>;

/** One per workspace connection, so a target never follows you to another server. */
const stores = new WeakMap<WorkspaceClient, StoreApi<Targets>>();

function targets(client: WorkspaceClient) {
  let store = stores.get(client);
  if (!store) stores.set(client, (store = createStore<Targets>(() => ({}))));
  return store;
}

/** The conversation a composer writes to: a channel, or one thread in it. */
export function conversationKey(channelId: ID, threadRootId?: ID | null): string {
  return threadRootId ? `${channelId}:${threadRootId}` : channelId;
}

/** What the next send in this conversation answers, if anything. */
export function useReplyTarget(client: WorkspaceClient, key: string): ReplyTarget | undefined {
  return useStore(targets(client), (s) => s[key]);
}

/** Answers `message` with the next send in its conversation. */
export function startReply(
  client: WorkspaceClient,
  key: string,
  message: Message,
  ping: boolean,
): void {
  targets(client).setState((s) => ({
    [key]: { message, ping, asked: (s[key]?.asked ?? 0) + 1 },
  }));
}

export function setReplyPing(client: WorkspaceClient, key: string, ping: boolean): void {
  targets(client).setState((s) => (s[key] ? { [key]: { ...s[key], ping } } : s));
}

export function cancelReply(client: WorkspaceClient, key: string): void {
  targets(client).setState((s) => {
    if (!s[key]) return s;
    const { [key]: _gone, ...rest } = s;
    return rest;
  }, true);
}
