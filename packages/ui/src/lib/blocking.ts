import type { Channel, ID, ReportReason, User } from "@ownbase/protocol";

/**
 * Whom a one-to-one DM is with, when this account blocked them (E12): that
 * conversation leaves the sidebar and its unread counts, and its composer
 * gives way to unblocking. A group DM stays, only their messages folding.
 */
export function blockedPartner(
  channel: Channel | undefined,
  selfId: ID | undefined,
  blocked: ID[] | null,
): ID | null {
  if (!channel || channel.type !== "dm" || !blocked?.length) return null;
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

/** Each reason for a report as people would put it (E12). */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  spam: "Spam",
  harassment: "Harassment or bullying",
  inappropriate: "Inappropriate or offensive",
  other: "Something else",
};
