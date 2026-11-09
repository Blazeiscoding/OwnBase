import { useEffect, useMemo, useSyncExternalStore } from "react";
import { LocalWork } from "@ownbase/client-core";
import { useClient } from "../context.js";
import type { Platform } from "../platform.js";

const FAILED = {
  save: "Could not save your drafts and unsent messages on this device. Keep OwnBase open and press Retry.",
  load: "Could not load your drafts and unsent messages on this device. They are still saved. Press Retry before you close OwnBase.",
} as const;

/**
 * Keeps this window's drafts and unsent messages on the device while it is
 * open (`LocalWork`), writing at once when the page is hidden or closing, and
 * says when that fails.
 */
export function DraftPersistence({ platform }: { platform: Platform }) {
  const client = useClient();
  const work = useMemo(() => new LocalWork(client, platform), [client, platform]);
  const { failed, conflict } = useSyncExternalStore(work.subscribe, () => work.current);

  useEffect(() => {
    const stop = work.start();
    const flush = () => work.flush();
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    const stopPreparing = platform.onPrepareClose?.("persist", () => work.prepareClose());
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      stopPreparing?.();
      stop();
    };
  }, [work, platform]);

  if (failed)
    return (
      <div
        role="alert"
        className="absolute inset-x-3 top-3 z-50 flex items-center gap-3 rounded-lg border border-alert/30 bg-raised p-3 text-sm text-alert shadow-lg"
      >
        <span className="flex-1">{FAILED[failed]}</span>
        <button type="button" className="shrink-0 underline" onClick={() => work.retry()}>
          Retry
        </button>
      </div>
    );
  return conflict ? (
    <div
      role="status"
      className="absolute inset-x-3 top-3 z-50 flex items-center gap-3 rounded-lg border border-edge bg-raised p-3 text-sm text-ink shadow-lg"
    >
      <span className="flex-1">
        This draft changed in another window too. OwnBase kept both versions in it.
      </span>
      <button type="button" className="shrink-0 underline" onClick={() => work.dismissConflict()}>
        Dismiss
      </button>
    </div>
  ) : null;
}
