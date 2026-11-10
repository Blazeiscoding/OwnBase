import { useEffect, useEffectEvent, useState } from "react";
import { useKeyed } from "./useKeyed.js";
import { Api } from "@ownbase/client-core";
import type { UnreadSummary } from "@ownbase/protocol";

/** How often a workspace not on screen is asked what waits there, while the window is seen. */
export const OTHER_UNREAD_EVERY_MS = 30_000;

/** A saved sign-in to ask with. */
export interface UnreadSource {
  url: string;
  token: string;
}

/**
 * What waits in each of this device's other workspaces, by address, for the
 * rail beside the one open (`GET /api/me/unread`). Only the open workspace
 * keeps a connection, so the others are asked now and then: every
 * `OTHER_UNREAD_EVERY_MS` while the window is seen, at once when it is seen
 * or focused again or comes back online, and when the list changes, as it
 * does on moving to another workspace. One that cannot answer (a sign-in
 * that ended, no connection) shows nothing.
 */
export function useOtherWorkspacesUnread(
  sources: UnreadSource[],
  makeApi: (url: string, token: string) => Pick<Api, "unreadSummary"> = (url, token) =>
    new Api(url, token),
): Record<string, UnreadSummary> {
  // One identity per set of sign-ins, so a re-render with the same ones asks nothing.
  const key = sources.map((s) => `${s.url}\n${s.token}`).join("\n\n");
  const stable = useKeyed(key, () => sources);
  // A way to ask, not something asked about.
  const apiFor = useEffectEvent((url: string, token: string) => makeApi(url, token));
  const [waiting, setWaiting] = useState<Record<string, UnreadSummary>>({});

  useEffect(() => {
    let alive = true;
    const apis = stable.map((s) => ({ url: s.url, api: apiFor(s.url, s.token) }));
    // Whatever was known of a workspace no longer listed goes with it.
    setWaiting((was) =>
      Object.fromEntries(Object.entries(was).filter(([url]) => apis.some((a) => a.url === url))),
    );
    if (apis.length === 0) return;
    let asking = false;
    const ask = async () => {
      if (asking || !alive) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      asking = true;
      try {
        const answers = await Promise.all(
          apis.map(async ({ url, api }) => {
            try {
              return [url, await api.unreadSummary()] as const;
            } catch {
              return [url, null] as const;
            }
          }),
        );
        if (!alive) return;
        setWaiting(() => {
          const next: Record<string, UnreadSummary> = {};
          for (const [url, answer] of answers) if (answer) next[url] = answer;
          return next;
        });
      } finally {
        asking = false;
      }
    };
    void ask();
    const timer = setInterval(() => void ask(), OTHER_UNREAD_EVERY_MS);
    const again = () => void ask();
    const seen = () => {
      if (document.visibilityState === "visible") void ask();
    };
    window.addEventListener("focus", again);
    window.addEventListener("online", again);
    document.addEventListener("visibilitychange", seen);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", again);
      window.removeEventListener("online", again);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [stable]);

  return waiting;
}
