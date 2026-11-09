import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { PagedList, type Page } from "@ownbase/client-core";

/** A list a component opens while it shows it, and hears from as it changes. */
interface Openable {
  readonly current: unknown;
  subscribe(listener: () => void): () => void;
  open(): () => void;
}

/**
 * One of the client's lists (`client.lists`), open while the component is.
 * A change of `key` is a different list, made by `make` and read from the top.
 */
export function useOpenList<L extends Openable>(make: () => L, key: string): [L, L["current"]] {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a list is made again only for another key
  const list = useMemo(make, [key]);
  const state = useSyncExternalStore(list.subscribe, () => list.current);
  useEffect(() => list.open(), [list]);
  return [list, state];
}

/**
 * A `PagedList` read by the component itself, for a list no event keeps
 * current. A change in `key` is a different list, read from its first page,
 * with what is shown kept meanwhile when `keep` is set; `load` is read when
 * each page is asked for, so it may close over the latest props.
 */
export function usePagedList<T extends { id: string }>(
  load: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>,
  key: string,
  { keep = false }: { keep?: boolean } = {},
) {
  const latest = useRef(load);
  latest.current = load;
  const list = useMemo(
    () => new PagedList<T>((cursor, signal) => latest.current(cursor, signal)),
    [],
  );
  const state = useSyncExternalStore(list.subscribe, () => list.current);
  useEffect(() => {
    list.start({ keep });
    return () => list.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a list keeps rows or not for good
  }, [list, key]);
  return { ...state, list };
}
