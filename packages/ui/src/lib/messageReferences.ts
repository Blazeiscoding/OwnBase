import { useMemo, useRef } from "react";
import type { WorkspaceState } from "@slackoss/client-core";
import type { Channel, ID, Message, User } from "@slackoss/protocol";
import { useWorkspace } from "../context.js";
import { parseDeepLink } from "./deeplink.js";

const NAMED_USER = /<@([A-Za-z0-9_-]+)>/g;
const NAMED_CHANNEL = /<#([A-Za-z0-9_-]+)>/g;
const LINK = /https?:\/\/[^\s<>]+/g;

/**
 * The people and conversations a message row shows: its author, whoever it
 * names or reacted to it, the channels it names or links a message in, and
 * who wrote what it answers and whom that names, what it forwards: its
 * conversation, who wrote it and whom it names, and who chose each of its
 * poll's choices (E6). A superset of what `Mrkdwn`
 * looks up is harmless; a subset would leave a rename unshown.
 */
export function messageReferences(
  message: Pick<Message, "userId" | "text" | "reactions" | "replyTo" | "forwardedFrom" | "poll">,
): {
  userIds: ID[];
  channelIds: ID[];
} {
  const userIds = new Set<ID>([message.userId]);
  const channelIds = new Set<ID>();
  const quote = message.replyTo;
  const forward = message.forwardedFrom;
  for (const text of [message.text, quote?.text ?? "", forward?.text ?? ""]) {
    for (const [, id] of text.matchAll(NAMED_USER)) userIds.add(id!);
    for (const [, id] of text.matchAll(NAMED_CHANNEL)) channelIds.add(id!);
  }
  if (quote?.userId) userIds.add(quote.userId);
  if (forward?.userId) userIds.add(forward.userId);
  if (forward?.channelId) channelIds.add(forward.channelId);
  for (const [url] of message.text.matchAll(LINK)) {
    const link = parseDeepLink(url);
    if (link?.kind === "message") channelIds.add(link.channelId);
  }
  for (const group of message.reactions) for (const id of group.userIds) userIds.add(id);
  for (const option of message.poll?.options ?? [])
    for (const id of option.voterIds ?? []) userIds.add(id);
  return { userIds: [...userIds], channelIds: [...channelIds] };
}

function pick<T>(values: Record<ID, T>, ids: ID[]): Record<ID, T> {
  const picked: Record<ID, T> = {};
  for (const id of ids) {
    const value = values[id];
    if (value !== undefined) picked[id] = value;
  }
  return picked;
}

function sameEntries<T>(a: Record<ID, T>, b: Record<ID, T>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * A selector for the entries `ids` names in one map of the replica. It gives
 * back the same object until one of those entries changes, and it does no
 * work at all while the map itself is the same object, which is most updates:
 * typing, presence and every other part of the replica leave it alone.
 */
function usePick<T>(map: (s: WorkspaceState) => Record<ID, T>, ids: ID[]) {
  const last = useRef<{ source: Record<ID, T> | null; ids: ID[]; value: Record<ID, T> }>({
    source: null,
    ids,
    value: {},
  });
  return (s: WorkspaceState) => {
    const source = map(s);
    const held = last.current;
    if (held.source === source && held.ids === ids) return held.value;
    const next = pick(source, ids);
    const value = held.ids === ids && sameEntries(held.value, next) ? held.value : next;
    last.current = { source, ids, value };
    return value;
  };
}

/**
 * The users and channels one message row shows, from the replica. A change to
 * anyone or anything else leaves the same objects, so the row does not render.
 */
export function useMessageReferences(
  message: Pick<Message, "userId" | "text" | "reactions" | "replyTo" | "forwardedFrom" | "poll">,
): {
  users: Record<ID, User>;
  channels: Record<ID, Channel>;
} {
  const { userId, text, reactions, replyTo, forwardedFrom, poll } = message;
  const refs = useMemo(
    () => messageReferences({ userId, text, reactions, replyTo, forwardedFrom, poll }),
    [userId, text, reactions, replyTo, forwardedFrom, poll],
  );
  const users = useWorkspace(usePick((s) => s.users, refs.userIds));
  const channels = useWorkspace(usePick((s) => s.channels, refs.channelIds));
  return { users, channels };
}
