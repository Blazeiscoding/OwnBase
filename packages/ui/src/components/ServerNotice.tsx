import { useEffect, useState } from "react";
import type { ServerNotice } from "@ownbase/protocol";
import { usePlatform, useWorkspace } from "../context.js";
import { Banner, BannerAction } from "./Banner.js";

/** How long "Not now" keeps a notice that is only news away, on this device. */
export const SERVER_NOTICE_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

const NONE: ServerNotice[] = [];

/**
 * What the server's extensions tell the owner and admins (P6), such as an
 * Enterprise license running out, one at a time under the conversation's
 * header. A status can be put away for two weeks; an alert, such as a
 * license that has ended, only until the app is opened again.
 */
export function ServerNoticeBanner({
  now = Date.now,
  onShowing,
}: {
  now?: () => number;
  /** Told whether it is on show, so what comes after it in the banner place waits. */
  onShowing?: (showing: boolean) => void;
}) {
  const platform = usePlatform();
  const notices = useWorkspace((s) =>
    s.self?.role === "owner" || s.self?.role === "admin" ? s.serverNotices : NONE,
  );
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const prefix = `serverNoticeSnoozedAt:${workspaceId ?? "workspace"}:`;
  // Unknown until storage answers, so a snoozed notice does not flash first.
  const [snoozed, setSnoozed] = useState<ReadonlySet<string> | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (notices.length === 0) return;
    let alive = true;
    void Promise.all(
      notices.map(async (notice) => {
        if (notice.tone === "alert") return null;
        const at = await platform.storage.get<number>(prefix + notice.id).catch(() => null);
        return typeof at === "number" && now() - at < SERVER_NOTICE_SNOOZE_MS ? notice.id : null;
      }),
    ).then((ids) => {
      if (alive) setSnoozed(new Set(ids.filter((id): id is string => id !== null)));
    });
    return () => {
      alive = false;
    };
  }, [platform, prefix, notices, now]);

  const notice =
    snoozed === null
      ? null
      : (notices.find((n) => !snoozed.has(n.id) && !dismissed.has(n.id)) ?? null);
  const showing = notice !== null;
  useEffect(() => onShowing?.(showing), [onShowing, showing]);
  useEffect(() => () => onShowing?.(false), [onShowing]);
  if (!notice) return null;

  function putAway(current: ServerNotice) {
    if (current.tone === "alert") {
      setDismissed((ids) => new Set([...ids, current.id]));
      return;
    }
    setSnoozed((ids) => new Set([...(ids ?? []), current.id]));
    // Remembering is a courtesy: if it cannot be saved, the notice is still gone.
    platform.storage.set(prefix + current.id, now()).catch(() => {});
  }

  return (
    <Banner
      tone={notice.tone}
      actions={
        <>
          {notice.link && (
            <a
              href={notice.link.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
            >
              {notice.link.label}
            </a>
          )}
          <BannerAction onClick={() => putAway(notice)}>
            {notice.tone === "alert" ? "Dismiss" : "Not now"}
          </BannerAction>
        </>
      }
    >
      {notice.text}
    </Banner>
  );
}
