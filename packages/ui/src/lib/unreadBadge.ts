import type { UnreadSummary } from "@ownbase/protocol";

/** What the app's icon, the tray and a tab's title show: a number, a dot, or nothing. */
export interface UnreadBadge {
  count: number;
  dot: boolean;
}

export const NO_BADGE: UnreadBadge = { count: 0, dot: false };

/** The page's name, as index.html gives it. */
export const APP_TITLE = "OwnBase";

/** A tab's title: "(3) OwnBase", "• OwnBase", or the name alone. */
export function titleFor(badge: UnreadBadge): string {
  if (badge.count > 0) return `(${badge.count > 99 ? "99+" : badge.count}) ${APP_TITLE}`;
  return badge.dot ? `• ${APP_TITLE}` : APP_TITLE;
}

/**
 * What the workspace rail shows, added up, for everything outside the window
 * (J16). The count is every workspace's mentions: the open one's from its
 * connection (`mentionCounts`), the others' from `useOtherWorkspacesUnread`,
 * which both come from the server's `unreadMentionCounts`. With no mentions,
 * a dot when any of them has a conversation not muted with something unread.
 * A workspace that did not answer adds nothing.
 */
export function unreadBadge(
  open: UnreadSummary | null,
  others: Record<string, UnreadSummary>,
): UnreadBadge {
  const all = [...(open ? [open] : []), ...Object.values(others)];
  const count = all.reduce((sum, w) => sum + w.mentions, 0);
  return { count, dot: count === 0 && all.some((w) => w.unread) };
}
