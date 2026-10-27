import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ID } from "@ownbase/protocol";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import {
  readWorkspaceStorage,
  workspaceStorageKey,
  writeWorkspaceStorage,
} from "./workspaceStorage.js";

/** Channel ids never contain anything else. */
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The conversation this account last had open in this workspace, on this
 * device. `remembered` is undefined while it is being read, and null when
 * there is none or it could not be read, since #general is a fine answer.
 */
export function useLastConversation() {
  const platform = usePlatform();
  const client = useClient();
  const selfId = useWorkspace((s) => s.self?.id);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const key = useMemo(() => {
    const scoped = workspaceStorageKey(client.baseUrl, workspaceId, selfId, "last-conversation");
    // Nothing was saved under an address before workspace IDs, so there is
    // no older slot to migrate from.
    return scoped && { key: scoped.key };
  }, [client.baseUrl, workspaceId, selfId]);
  const [read, setRead] = useState<{ key: string; value: ID | null } | null>(null);
  const written = useRef<string | null>(null);

  useEffect(() => {
    if (!key) return;
    let current = true;
    readWorkspaceStorage<unknown>(platform, key)
      .then((value) => (typeof value === "string" && TOKEN.test(value) ? value : null))
      .catch(() => null)
      .then((value) => {
        if (current) setRead({ key: key.key, value });
      });
    return () => {
      current = false;
    };
  }, [platform, key]);

  const remember = useCallback(
    (channelId: ID) => {
      if (!key || written.current === `${key.key}\n${channelId}`) return;
      written.current = `${key.key}\n${channelId}`;
      // Losing this costs one click on the next start; nothing to report.
      writeWorkspaceStorage(platform, key, channelId).catch(() => {
        written.current = null;
      });
    },
    [platform, key],
  );

  return {
    remembered: read && key && read.key === key.key ? read.value : undefined,
    remember,
  };
}
