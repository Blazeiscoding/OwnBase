import { useCallback, useEffect, useMemo, useState } from "react";
import type { ID } from "@ownbase/protocol";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import {
  readWorkspaceStorage,
  updateWorkspaceStorage,
  workspaceStorageKey,
} from "./workspaceStorage.js";

/** How many conversations Ctrl+K remembers having been open. */
export const RECENT_LIMIT = 12;

/** Channel ids never contain anything else. */
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

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
  const client = useClient();
  const selfId = useWorkspace((s) => s.self?.id);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const key = useMemo(
    () => workspaceStorageKey(client.baseUrl, workspaceId, selfId, "recent-conversations"),
    [client.baseUrl, workspaceId, selfId],
  );
  const [recent, setRecent] = useState<ID[]>([]);

  useEffect(() => {
    setRecent([]);
    if (!key) return;
    let current = true;
    readWorkspaceStorage<unknown>(platform, key)
      .then(valid)
      .catch(() => [])
      .then((stored) => {
        // Anything opened while it was read is newer than what was stored.
        if (current) setRecent((opened) => opened.reduceRight(withRecent, stored));
      });
    return () => {
      current = false;
    };
  }, [platform, key]);

  const remember = useCallback(
    (channelId: ID) => {
      setRecent((list) => (list[0] === channelId ? list : withRecent(list, channelId)));
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
