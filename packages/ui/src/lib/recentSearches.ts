import { useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";
import {
  readWorkspaceStorage,
  workspaceStorageKey,
  writeWorkspaceStorage,
  type WorkspaceStorageKey,
} from "@ownbase/client-core";

export interface RecentSearch {
  query: string;
  channelId?: string;
}

const LIMIT = 10;
const queues = new WeakMap<Platform, Map<string, Promise<void>>>();
const same = (a: RecentSearch, b: RecentSearch) =>
  a.query === b.query && a.channelId === b.channelId;

function parse(value: unknown): RecentSearch[] {
  if (!Array.isArray(value)) return [];
  const entries: RecentSearch[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item.query !== "string" ||
      item.query.length > 200 ||
      (item.channelId !== undefined && (typeof item.channelId !== "string" || !item.channelId)) ||
      (!item.query.trim() && !item.channelId)
    )
      continue;
    const entry = { query: item.query, ...(item.channelId ? { channelId: item.channelId } : {}) };
    if (!entries.some((existing) => same(existing, entry))) entries.push(entry);
    if (entries.length === LIMIT) break;
  }
  return entries;
}

function createHistory(platform: Platform, key: WorkspaceStorageKey | null) {
  const state = createStore(() => ({
    items: [] as RecentSearch[],
    busy: false,
    error: null as string | null,
  }));
  let pending = 0;
  function update(transform?: (items: RecentSearch[]) => RecentSearch[], clear = false) {
    if (!key) return;
    const queue = queues.get(platform) ?? new Map<string, Promise<void>>();
    queues.set(platform, queue);
    pending++;
    state.setState({ busy: true, error: null });
    // Serialize reads and writes across closed/reopened dialogs, so a late
    // history append cannot undo an explicit clear.
    const operation = (queue.get(key.key) ?? Promise.resolve())
      .then(async () => {
        const previous = clear ? [] : parse(await readWorkspaceStorage<unknown>(platform, key));
        const items = transform ? transform(previous).slice(0, LIMIT) : previous;
        if (transform) await writeWorkspaceStorage(platform, key, items);
        state.setState({ items });
      })
      .catch(() => {
        state.setState({
          error: "Could not access recent searches on this device. Search still works.",
        });
      })
      .finally(() => {
        state.setState({ busy: --pending > 0 });
        if (queue.get(key.key) === operation) queue.delete(key.key);
      });
    queue.set(key.key, operation);
  }
  update();
  return {
    state,
    remember: (entry: RecentSearch) =>
      update((items) => [entry, ...items.filter((item) => !same(item, entry))]),
    remove: (entry: RecentSearch) => update((items) => items.filter((item) => !same(item, entry))),
    clear: () => update(() => [], true),
  };
}

export function useRecentSearches() {
  const platform = usePlatform();
  const client = useClient();
  const selfId = useWorkspace((s) => s.self?.id);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const key = useMemo(
    () => workspaceStorageKey(client.baseUrl, workspaceId, selfId, "recent-searches"),
    [client.baseUrl, workspaceId, selfId],
  );
  const history = useMemo(() => createHistory(platform, key), [platform, key]);
  return {
    ...useStore(history.state),
    remember: history.remember,
    remove: history.remove,
    clear: history.clear,
  };
}
