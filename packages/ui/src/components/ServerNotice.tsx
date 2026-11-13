import { useEffect, useLayoutEffect, useState } from "react";
import type { ServerNotice } from "@ownbase/protocol";
import { selfIsAdministrator } from "@ownbase/client-core";
import { usePlatform, useWorkspace } from "../context.js";
import { keepSnoozed, snoozedUnder } from "../lib/noticeSnooze.js";
import { Banner, BannerAction } from "./Banner.js";

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
  const notices = useWorkspace((s) => (selfIsAdministrator(s) ? s.serverNotices : NONE));
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
        return (await snoozedUnder(platform.storage, prefix + notice.id, now)) ? notice.id : null;
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
  // Until storage answers, a notice that may yet show holds the place too, so
  // what waits for it does not show first and give way. Told before paint.
  const showing = snoozed === null ? notices.length > 0 : notice !== null;
  useLayoutEffect(() => onShowing?.(showing), [onShowing, showing]);
  useLayoutEffect(() => () => onShowing?.(false), [onShowing]);
  if (!notice) return null;

  function putAway(current: ServerNotice) {
    if (current.tone === "alert") {
      setDismissed((ids) => new Set([...ids, current.id]));
      return;
    }
    setSnoozed((ids) => new Set([...(ids ?? []), current.id]));
    keepSnoozed(platform.storage, prefix + current.id, now);
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
