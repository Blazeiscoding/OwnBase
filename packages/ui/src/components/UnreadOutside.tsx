import { useEffect } from "react";
import { blockedPartner, isUnread } from "@ownbase/client-core";
import type { UnreadSummary } from "@ownbase/protocol";
import { usePlatform, useWorkspace } from "../context.js";
import { NO_BADGE, titleFor, unreadBadge, type UnreadBadge } from "../lib/unreadBadge.js";
import { useUnreadOnIcon } from "../lib/unreadOnIcon.js";
import type { OtherWorkspace } from "./Sidebar.js";

type BadgingNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** An installed browser app's icon, where the browser has the API. */
function setAppBadge(badge: UnreadBadge): void {
  const nav = navigator as BadgingNavigator;
  if (!nav.setAppBadge || !nav.clearAppBadge) return;
  const done =
    badge.count > 0
      ? nav.setAppBadge(badge.count)
      : badge.dot
        ? nav.setAppBadge()
        : nav.clearAppBadge();
  void done.catch(() => {});
}

/**
 * What waits, shown outside the window (J16): the tab's title, an installed
 * browser app's badge, and through the desktop app its taskbar button, dock
 * and tray. Rendered with the open workspace; leaving it clears them all.
 */
export function UnreadOutside({ others }: { others: OtherWorkspace[] }) {
  const platform = usePlatform();
  const { show } = useUnreadOnIcon();
  const mentions = useWorkspace((s) =>
    Object.values(s.mentionCounts).reduce((sum, n) => sum + n, 0),
  );
  // As the server's summary counts it for the rail: a conversation not muted
  // with something unread, a DM with someone blocked aside.
  const unread = useWorkspace((s) =>
    Object.keys(s.memberships).some(
      (id) =>
        isUnread(s, id) &&
        !(s.prefs[id]?.muted ?? false) &&
        !blockedPartner(s.channels[id], s.self?.id, s.blocked),
    ),
  );
  const answered: Record<string, UnreadSummary> = {};
  for (const w of others) if (w.waiting) answered[w.url] = w.waiting;
  const badge = show ? unreadBadge({ mentions, unread }, answered) : NO_BADGE;
  const { count, dot } = badge;

  // Only when it changes: a screen reader reads the title out.
  useEffect(() => {
    const now = { count, dot };
    document.title = titleFor(now);
    if (platform.kind === "web") setAppBadge(now);
    platform.setUnread?.(now);
  }, [count, dot, platform]);

  useEffect(
    () => () => {
      document.title = titleFor(NO_BADGE);
      if (platform.kind === "web") setAppBadge(NO_BADGE);
      platform.setUnread?.(NO_BADGE);
    },
    [platform],
  );
  return null;
}
