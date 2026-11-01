import { useEffect, useState } from "react";
import type { WorkspaceClient } from "@ownbase/client-core";

/** The asked-for limit per workspace connection, asked once. */
const asked = new WeakMap<WorkspaceClient, Promise<number | null>>();

/**
 * The largest file this workspace takes, so one over it is turned away as it
 * is attached rather than after it has uploaded. Null until known, or where
 * the server does not say.
 */
export function useMaxFileBytes(client: WorkspaceClient, enabled = true): number | null {
  const [max, setMax] = useState<number | null>(null);
  useEffect(() => {
    // A guest attaches nothing, and the server keeps its storage from guests.
    if (!enabled) return;
    let live = true;
    let request = asked.get(client);
    if (!request) {
      request = client.api.storageUsage().then(
        (usage) => (Number.isFinite(usage.maxFileBytes) ? usage.maxFileBytes : null),
        () => {
          // Asked again next time, in case the connection was only down.
          asked.delete(client);
          return null;
        },
      );
      asked.set(client, request);
    }
    void request.then((bytes) => {
      if (live) setMax(bytes);
    });
    return () => {
      live = false;
    };
  }, [client, enabled]);
  return max;
}

/** Splits files into those within `max` and those over it. */
export function withinLimit(files: File[], max: number | null): { ok: File[]; over: File[] } {
  if (max === null) return { ok: files, over: [] };
  const ok: File[] = [];
  const over: File[] = [];
  for (const file of files) (file.size > max ? over : ok).push(file);
  return { ok, over };
}
