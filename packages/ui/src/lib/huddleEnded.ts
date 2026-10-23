import { useEffect } from "react";
import { useWorkspace } from "../context.js";
import { useOptionalToast } from "../components/Toast.js";

/**
 * Says once why a call ended without the person leaving it: joined on
 * another device, or not let back in after the connection dropped
 * (`WorkspaceState.huddleEnded`). The call bar is gone by then, so a notice
 * says it instead.
 */
export function useHuddleEndedNotice(): void {
  const ended = useWorkspace((s) => s.huddleEnded);
  const toast = useOptionalToast();
  useEffect(() => {
    if (ended && toast) toast({ message: ended.message, kind: ended.error ? "error" : "success" });
  }, [ended, toast]);
}

/**
 * Says once, on the caller's device in the call, how its ring went (E10): who
 * declined, or that nobody answered (`WorkspaceState.ringNotice`).
 */
export function useRingNotice(): void {
  const notice = useWorkspace((s) => s.ringNotice);
  const toast = useOptionalToast();
  useEffect(() => {
    if (notice && toast) toast({ message: notice.message, kind: "success" });
  }, [notice, toast]);
}
