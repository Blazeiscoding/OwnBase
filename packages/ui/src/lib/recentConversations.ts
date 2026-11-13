import { useCallback, useMemo, useState } from "react";
import type { ID } from "@ownbase/protocol";
import { usePlatform } from "../context.js";
import { updateWorkspaceStorage } from "@ownbase/client-core";
import { useAccountKey, useAccountRead } from "./accountStorage.js";

/** How many conversations Ctrl+K remembers having been open. */
export const RECENT_LIMIT = 12;

/** Channel ids never contain anything else. */
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

const NONE: ID[] = [];

function valid(value: unknown): ID[] {
  return Array.isArray(value)
    ? value
        .filter((id): id is ID => typeof id === "string" && TOKEN.test(id))
        .slice(0, RECENT_LIMIT)
    : [];
}

/** `list` with `id` moved to its front. */
export function withRecent(list: readonly ID[], id: ID): ID[] {
  return [id, ...list.filter((other) => other !== id)].slice(0, RECENT_LIMIT);
}

/**
 * The conversations this account had open in this workspace, on this device,
 * newest first, for Ctrl+K to offer before anything is typed.
 */
export function useRecentConversations() {
  const platform = usePlatform();
  const key = useAccountKey("recent-conversations", true);
  const stored = useAccountRead(key, valid, NONE);
  /** Opened here, newest first, for the key they were opened under. */
  const [opened, setOpened] = useState<{ key: string | undefined; ids: ID[] }>({
    key: undefined,
    ids: NONE,
  });
  const here = opened.key === key?.key ? opened.ids : NONE;
  // Anything opened here is newer than what was stored, read or not yet.
  const recent = useMemo(() => here.reduceRight(withRecent, stored ?? NONE), [here, stored]);

  const remember = useCallback(
    (channelId: ID) => {
      setOpened((was) => {
        const ids = was.key === key?.key ? was.ids : NONE;
        return ids[0] === channelId ? was : { key: key?.key, ids: withRecent(ids, channelId) };
      });
      if (!key) return;
      // Losing this costs Ctrl+K its order once; nothing to report.
      updateWorkspaceStorage(platform, key, (stored) => withRecent(valid(stored), channelId)).catch(
        () => {},
      );
    },
    [platform, key],
  );

  return { recent, remember };
}
