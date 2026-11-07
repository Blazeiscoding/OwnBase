import { useCallback, useEffect, useRef, useState } from "react";
import type { HostingStatus, LastHosted, Platform } from "../platform.js";

/** One live status shared by the host dialog and the surrounding workspace. */
export function useHostingStatus(hosting: Platform["hosting"]) {
  const [status, setStatus] = useState<HostingStatus | null>(null);
  const [loading, setLoading] = useState(!!hosting);
  const [error, setError] = useState(false);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    if (!hosting) return;
    const request = ++revision.current;
    setLoading(true);
    setError(false);
    try {
      const next = await hosting.status();
      if (request !== revision.current) return;
      setStatus(next);
    } catch {
      if (request === revision.current) setError(true);
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, [hosting]);

  useEffect(() => {
    setStatus(null);
    if (!hosting) {
      setLoading(false);
      setError(false);
      return;
    }
    const unsubscribe = hosting.subscribe((next) => {
      // A live change takes precedence over an older in-flight status read.
      revision.current++;
      setStatus(next);
      setLoading(false);
      setError(false);
    });
    void refresh();
    return () => {
      revision.current++;
      unsubscribe();
    };
  }, [hosting, refresh]);

  // Only the first read is "loading". Re-reading a status already on screen must
  // not blank it, or every refresh flickers the controls it is about.
  return { status, loading: loading && status === null, error, refresh };
}

/**
 * The workspace this computer hosted last, for offering to host it again.
 * Read again whenever hosting starts or stops, since either can change it.
 */
export function useLastHosted(hosting: Platform["hosting"], status: HostingStatus | null) {
  const [lastHosted, setLastHosted] = useState<LastHosted | null>(null);
  const phase = status?.phase ?? null;
  const hosted = status?.running ? `${status.workspaceName ?? ""}:${status.port ?? ""}` : "";
  useEffect(() => {
    if (!hosting) return;
    let alive = true;
    hosting
      .lastHosted()
      .then((value) => {
        if (alive) setLastHosted(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [hosting, phase, hosted]);
  return lastHosted;
}
