import {
  endpoints,
  isAdministrator,
  roleMayCall,
  type Channel,
  type ID,
  type Message,
  type ThreadFollow,
  type User,
} from "@ownbase/protocol";
import type { ConnectionStatus, WorkspaceState } from "./workspaceState.js";

type ReadState = Pick<WorkspaceState, "memberships" | "channelLastSeq">;

export function isUnread(state: ReadState, channelId: ID): boolean {
  return (state.channelLastSeq[channelId] ?? 0) > (state.memberships[channelId] ?? 0);
}

export function isThreadUnread(follow: ThreadFollow): boolean {
  return follow.following && follow.lastSeq > follow.lastReadSeq;
}

/**
 * Whom a one-to-one DM is with, when this account blocked them (E12): that
 * conversation leaves the sidebar and its unread counts, and its composer
 * gives way to unblocking. A group DM stays, only their messages folding.
 */
export function blockedPartner(
  channel: Channel | undefined,
  selfId: ID | undefined,
  blocked: ID[],
): ID | null {
  if (!channel || channel.type !== "dm" || !blocked.length) return null;
  const other = channel.memberIds?.find((id) => id !== selfId);
  return other && blocked.includes(other) ? other : null;
}

/**
 * Whom a one-to-one DM is with, when their account is deactivated: nobody
 * reads what is written there until an admin reactivates them, so the
 * conversation stays readable but takes no new messages or calls.
 */
export function deactivatedPartner(
  channel: Channel | undefined,
  selfId: ID | undefined,
  users: Record<ID, User>,
): ID | null {
  if (!channel || channel.type !== "dm") return null;
  const other = channel.memberIds?.find((id) => id !== selfId);
  return other && users[other]?.deactivated ? other : null;
}

/** Unread mentions everywhere but the conversation on screen. */
export function mentionsElsewhere(
  state: Pick<WorkspaceState, "mentionCounts">,
  activeChannelId: ID | null,
): number {
  let sum = 0;
  for (const [id, count] of Object.entries(state.mentionCounts))
    if (id !== activeChannelId) sum += count;
  return sum;
}

/** When Do Not Disturb ends, while it is on at `now`; otherwise null. */
export function snoozedUntil(dndUntil: number | null | undefined, now = Date.now()): number | null {
  return dndUntil != null && dndUntil > now ? dndUntil : null;
}

export function isSnoozed(dndUntil: number | null | undefined, now = Date.now()): boolean {
  return snoozedUntil(dndUntil, now) !== null;
}

/**
 * Whether the server has ended this session: signed out, or refusing the
 * account until its password is replaced.
 */
export function isSignedOut(status: ConnectionStatus): boolean {
  return status === "auth_failed" || status === "password_change_required";
}

export function selfIsAdministrator(state: Pick<WorkspaceState, "self">): boolean {
  return isAdministrator(state.self?.role);
}

/**
 * Whether this account may call the endpoint `name`, by the access the
 * endpoint table gives it: the server's own rule, so what the UI offers and
 * what the server lets through cannot drift apart.
 */
export function selfMay(
  state: Pick<WorkspaceState, "self">,
  name: keyof typeof endpoints,
): boolean {
  return roleMayCall(endpoints[name].access, state.self?.role);
}

/** Followed threads with replies this account has not read. */
export function unreadThreadCount(threadFollows: Record<ID, ThreadFollow>): number {
  return Object.values(threadFollows).filter(isThreadUnread).length;
}

/**
 * Whether this account has read a message; the server's count of unread
 * messages is the same rule. The channel's cursor reads what the channel
 * shows. A reply is read through its thread: by the thread's cursor, or, in a
 * thread this account has no cursor for, as far as the membership's
 * `repliesRead`. A reply also sent to the channel is read by either cursor.
 */
export function isMessageRead(
  message: Pick<Message, "channelId" | "seq" | "threadRootId" | "broadcast">,
  state: Pick<WorkspaceState, "memberships" | "threadFollows" | "repliesRead">,
): boolean {
  const channelRead = state.memberships[message.channelId] ?? 0;
  if (!message.threadRootId) return message.seq <= channelRead;
  const follow = state.threadFollows[message.threadRootId];
  const threadRead = follow?.lastReadSeq;
  // Also sent to the channel, and read there; unless the thread was marked
  // unread since the channel was last read past where it then stood.
  const held = follow?.unreadHold !== undefined && channelRead <= follow.unreadHold;
  if (message.broadcast && message.seq <= channelRead && !held) return true;
  return message.seq <= (threadRead ?? state.repliesRead[message.channelId] ?? 0);
}
