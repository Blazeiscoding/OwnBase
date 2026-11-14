import { useEffect } from "react";
import { usePlatform } from "../context.js";

/**
 * Tells the app whether a call is on, so an update never restarts it in the
 * middle of one. A call ends, as far as updates go, when the workspace closes.
 * Kept apart from Updates.tsx so the workspace's first download need not carry
 * the update banner, which loads on first use.
 */
export function useReportCall(inCall: boolean): void {
  const updates = usePlatform().updates;
  useEffect(() => {
    if (!updates) return;
    void updates.reportCall(inCall).catch(() => {});
    return () => void updates.reportCall(false).catch(() => {});
  }, [updates, inCall]);
}
