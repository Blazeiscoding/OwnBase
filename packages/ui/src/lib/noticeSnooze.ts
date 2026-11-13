import { useEffect, useState } from "react";
import type { Platform } from "../platform.js";

/** How long "Not now" keeps a notice away on this device: two weeks. */
export const NOTICE_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

type Storage = Platform["storage"];

/** Whether "Not now" was pressed under `key` less than two weeks ago. A failed read is a no. */
export function snoozedUnder(storage: Storage, key: string, now: () => number): Promise<boolean> {
  return storage
    .get<number>(key)
    .then((at) => typeof at === "number" && now() - at < NOTICE_SNOOZE_MS)
    .catch(() => false);
}

/** Remembers "Not now" under `key`. A courtesy: if it cannot be saved, the notice is still gone. */
export function keepSnoozed(storage: Storage, key: string, now: () => number): void {
  storage.set(key, now()).catch(() => {});
}

/**
 * Whether a notice was put away under `key`: null until storage answers, so
 * a snoozed notice does not flash first, and while there is no key, as for a
 * notice that has nothing to say.
 */
export function useSnoozed(
  storage: Storage,
  key: string | null,
  now: () => number,
): { snoozed: boolean | null; snooze: () => void } {
  const [answer, setAnswer] = useState<{ key: string; snoozed: boolean } | null>(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    void snoozedUnder(storage, key, now).then((snoozed) => {
      if (alive) setAnswer({ key, snoozed });
    });
    return () => {
      alive = false;
    };
  }, [storage, key, now]);
  return {
    snoozed: key && answer?.key === key ? answer.snoozed : null,
    snooze: () => {
      if (!key) return;
      setAnswer({ key, snoozed: true });
      keepSnoozed(storage, key, now);
    },
  };
}
