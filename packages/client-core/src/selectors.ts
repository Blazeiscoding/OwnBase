import {
  isAdministrator,
  type Channel,
  type ID,
  type ThreadFollow,
  type User,
} from "@ownbase/protocol";
import type { WorkspaceState } from "./workspace.js";

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

/**
 * Whether an unread conversation asks for attention from elsewhere: not the
 * one on screen, not muted, not archived, and not a DM with someone blocked.
 * Rows in the sidebar still show muted unread conversations, quietly; this is
 * what badges and the phone's buttons count.
 */
export function waitsForAttention(
  state: Pick<
    WorkspaceState,
    "memberships" | "channelLastSeq" | "prefs" | "channels" | "self" | "blocked"
  >,
  channelId: ID,
  activeChannelId: ID | null,
): boolean {
  return (
    channelId !== activeChannelId &&
    !state.prefs[channelId]?.muted &&
    !state.channels[channelId]?.archived &&
    !blockedPartner(state.channels[channelId], state.self?.id, state.blocked) &&
    isUnread(state, channelId)
  );
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

export function selfIsAdministrator(state: Pick<WorkspaceState, "self">): boolean {
  return isAdministrator(state.self?.role);
}
