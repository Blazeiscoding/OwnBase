import { useEffect, useState } from "react";
import { useWorkspace } from "../context.js";

/** Whether the device says it has no network, kept up to date. */
export function useDeviceOffline(): boolean {
  const [offline, setOffline] = useState(
    () => typeof navigator !== "undefined" && navigator.onLine === false,
  );
  useEffect(() => {
    const update = () => setOffline(navigator.onLine === false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return offline;
}

/**
 * Why the workspace cannot be reached now, if it cannot: the device is
 * offline, or its connection dropped and is being made again.
 */
export function useConnectionDown(): "offline" | "reconnecting" | null {
  const reconnecting = useWorkspace((s) => s.status === "reconnecting");
  const offline = useDeviceOffline();
  return offline ? "offline" : reconnecting ? "reconnecting" : null;
}
