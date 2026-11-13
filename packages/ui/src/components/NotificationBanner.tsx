import { useEffect, useState } from "react";
import type { Platform } from "../platform.js";
import { useSnoozed } from "../lib/noticeSnooze.js";
import { Icon } from "./Icon.js";

function current(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/**
 * Asked after signing in, instead of on the first click anywhere (which was
 * usually the Sign in button). Browsers only prompt from a visible gesture.
 * "Not now" keeps the banner away on this device for two weeks, rather than
 * until the next reload, and a refusal in the browser's own prompt stays
 * silent until the reader changes it in the browser's site settings. The
 * desktop app grants notifications itself, so it never shows this.
 */
export function NotificationBanner({
  storage,
  now = Date.now,
  onShowing,
}: {
  storage: Platform["storage"];
  now?: () => number;
  /** Told whether it is on show, so what comes after it in the banner place waits. */
  onShowing?: (showing: boolean) => void;
}) {
  const [permission, setPermission] = useState(current);
  const { snoozed, snooze } = useSnoozed(
    storage,
    permission === "default" ? "notificationPromptSnoozedAt" : null,
    now,
  );
  const [busy, setBusy] = useState(false);
  const showing = permission === "default" && snoozed === false;

  useEffect(() => onShowing?.(showing), [onShowing, showing]);
  useEffect(() => () => onShowing?.(false), [onShowing]);

  if (!showing) return null;

  async function enable() {
    if (busy) return;
    setBusy(true);
    try {
      setPermission(await Notification.requestPermission());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="mx-3 mt-3 flex shrink-0 animate-rise-in flex-wrap items-center gap-x-3 gap-y-2 card-warm rounded-xl px-3.5 py-2.5 text-sm text-ink"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-[var(--card-edge)] bg-lifted text-ink-dim">
        <Icon name="bell" size={15} />
      </span>
      <span className="min-w-0 flex-1 text-ink-dim">
        Turn on notifications to hear when someone mentions you while you are in another tab or app.
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={snooze}
          className="h-7 rounded-lg px-2.5 text-[13px] text-ink-dim transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          Not now
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void enable()}
          className="btn-shape h-7 bg-copper px-2.5 text-[13px] font-semibold text-ground transition-colors hover:bg-copper-deep disabled:opacity-40"
        >
          {busy ? "Turning on…" : "Turn on"}
        </button>
      </span>
    </div>
  );
}
