import { useEffect, useState } from "react";
import type { Platform } from "../platform.js";
import { Icon } from "./Icon.js";

/** How long "Not now" keeps the banner away on this device. */
export const NOTIFICATION_PROMPT_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
const SNOOZED_AT = "notificationPromptSnoozedAt";

/** What the browser currently allows, or that it cannot ask at all. */
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
  // Unknown until storage answers, so a snoozed banner does not flash first.
  const [snoozed, setSnoozed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const showing = permission === "default" && snoozed === false;

  useEffect(() => onShowing?.(showing), [onShowing, showing]);
  useEffect(() => () => onShowing?.(false), [onShowing]);

  useEffect(() => {
    if (permission !== "default") return;
    let alive = true;
    storage
      .get<number>(SNOOZED_AT)
      .then((at) => typeof at === "number" && now() - at < NOTIFICATION_PROMPT_SNOOZE_MS)
      .catch(() => false)
      .then((value) => {
        if (alive) setSnoozed(value);
      });
    return () => {
      alive = false;
    };
  }, [storage, now, permission]);

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

  function snooze() {
    setSnoozed(true);
    // Remembering is a courtesy: if it cannot be saved, the banner is still gone.
    storage.set(SNOOZED_AT, now()).catch(() => {});
  }

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="mx-3 mt-3 flex shrink-0 animate-rise-in flex-wrap items-center gap-x-3 gap-y-2 card-warm rounded-xl px-3.5 py-2.5 text-sm text-ink"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-copper/12 text-copper">
        <Icon name="bell" size={15} />
      </span>
      <span className="min-w-0 flex-1 text-ink-dim">
        Turn on notifications to hear about mentions while OwnBase is in the background.
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
