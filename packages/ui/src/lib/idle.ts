import { useEffect } from "react";
import type { WorkspaceClient } from "@ownbase/client-core";

/** How long a device goes untouched before it says it is idle (E9). */
export const IDLE_AFTER_MS = 10 * 60_000;

/** What counts as someone using this device. */
const ACTIVITY = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

/**
 * Tells the workspace when this device goes idle, nobody touching it for
 * `IDLE_AFTER_MS`, and as soon as someone uses it again (E9). Every device of
 * an account idle makes it away. A moving pointer restarts the wait at most
 * once a second, so moving it costs nothing.
 */
export function useIdleReport(client: WorkspaceClient, after = IDLE_AFTER_MS): void {
  useEffect(() => {
    let idle = false;
    let last = Date.now();
    let timer = setTimeout(goIdle, after);
    function goIdle() {
      idle = true;
      client.setIdle(true);
    }
    function used() {
      const now = Date.now();
      if (idle) {
        idle = false;
        client.setIdle(false);
      } else if (now - last < 1000) return;
      last = now;
      clearTimeout(timer);
      timer = setTimeout(goIdle, after);
    }
    for (const type of ACTIVITY) window.addEventListener(type, used, { passive: true });
    window.addEventListener("focus", used);
    return () => {
      clearTimeout(timer);
      for (const type of ACTIVITY) window.removeEventListener(type, used);
      window.removeEventListener("focus", used);
    };
  }, [client, after]);
}
