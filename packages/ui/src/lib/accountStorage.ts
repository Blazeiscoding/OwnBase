import { useEffect, useMemo, useState } from "react";
import {
  readWorkspaceStorage,
  workspaceStorageKey,
  type WorkspaceStorageKey,
} from "@ownbase/client-core";
import { useClient, usePlatform, useWorkspace } from "../context.js";

/**
 * Where this account keeps `kind` for this workspace on this device, or null
 * until the account is known. Only a kind kept before workspaces had ids
 * (`olderKind`) still looks under its old key, and is stored wrapped; any
 * other kind has only ever been stored plain under its own key.
 */
export function useAccountKey(kind: string, olderKind = false): WorkspaceStorageKey | null {
  const client = useClient();
  const selfId = useWorkspace((s) => s.self?.id);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  return useMemo(() => {
    const scoped = workspaceStorageKey(client.baseUrl, workspaceId, selfId, kind);
    return scoped && (olderKind ? scoped : { key: scoped.key });
  }, [client.baseUrl, workspaceId, selfId, kind, olderKind]);
}

/**
 * What this account keeps under `key`, read once for each key: undefined
 * until storage answers, then what `parse` makes of it, or `unreadable` when
 * the read fails. `parse` and `unreadable` are taken from the first render.
 */
export function useAccountRead<T>(
  key: WorkspaceStorageKey | null,
  parse: (stored: unknown) => T,
  unreadable: T,
): T | undefined {
  const platform = usePlatform();
  const [read, setRead] = useState<{ key: string; value: T } | null>(null);
  const [answer] = useState(() => ({ parse, unreadable }));
  useEffect(() => {
    if (!key) return;
    let alive = true;
    void readWorkspaceStorage<unknown>(platform, key)
      .then(answer.parse)
      .catch(() => answer.unreadable)
      .then((value) => {
        if (alive) setRead({ key: key.key, value });
      });
    return () => {
      alive = false;
    };
  }, [platform, key, answer]);
  return key && read?.key === key.key ? read.value : undefined;
}
