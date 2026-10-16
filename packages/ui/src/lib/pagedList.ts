import { useEffect, useRef, useState } from "react";
import { CoalescedLoader } from "./coalescedLoader.js";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PagedListState<T> {
  /** Everything read so far, page after page; null until the first page comes. */
  items: T[] | null;
  /** Where the next page starts; null once the list has been read to its end. */
  nextCursor: string | null;
  /** Reading from the top where it should be seen: the first page, or Retry. */
  loading: boolean;
  /** Reading from the top in place, because what is shown may be out of date. */
  refreshing: boolean;
  loadingMore: boolean;
  /** The last read from the top failed. Whatever was shown stays. */
  failed: boolean;
  /** The last read of more failed. */
  moreFailed: boolean;
}

/** How long a sign that the list may be out of date waits for others like it. */
export const PAGED_REFRESH_DELAY_MS = 250;
/** Reading again goes no further than this many pages, however far the reader went. */
export const PAGED_REFRESH_PAGES = 10;

const EMPTY: PagedListState<never> = {
  items: null,
  nextCursor: null,
  loading: true,
  refreshing: false,
  loadingMore: false,
  failed: false,
  moreFailed: false,
};

/**
 * A list read a page at a time that has to stay current (UX-08). More is read
 * when asked for, as the end scrolls into view. A sign that what is shown may
 * be out of date reads the list again from the top, as far as it had been
 * read, and shows the result at once, so nothing blanks or jumps meanwhile.
 * One read from the top at a time, and a burst of signs is one read (REV-05);
 * reading more waits for it, and gives way to it.
 */
export class PagedList<T extends { id: string }> {
  private state: PagedListState<T> = EMPTY;
  private readonly loader: CoalescedLoader;
  private more: AbortController | null = null;
  /** The next read from the top is one the reader asked for, so it is seen. */
  private shown = true;
  /** The next read from the top is of a different list, so one page is enough. */
  private fresh = true;
  private reading = false;

  constructor(
    private readonly load: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>,
    private readonly onChange: (state: PagedListState<T>) => void,
    delayMs = PAGED_REFRESH_DELAY_MS,
  ) {
    this.loader = new CoalescedLoader((signal) => this.fromTop(signal), delayMs);
  }

  get current(): PagedListState<T> {
    return this.state;
  }

  /**
   * A different list, or the first time: read its first page now. What is
   * shown goes at once, unless `keep` is set and there is something to keep:
   * then it stays until the first page replaces it, as search results do
   * while the next question is out, so typing does not flash the list empty.
   */
  start(opts: { keep?: boolean } = {}): void {
    this.dropMore();
    this.shown = true;
    this.fresh = true;
    this.set(
      opts.keep && this.state.items?.length
        ? { loading: true, refreshing: false, failed: false, moreFailed: false }
        : { ...EMPTY },
    );
    this.loader.now();
  }

  /** What is shown may be out of date: read it again soon, in place. */
  refresh(): void {
    this.loader.soon();
  }

  /** After a failure: read it again now, where it can be seen. */
  retry(): void {
    if (this.state.moreFailed && !this.state.failed) {
      this.loadMore();
      return;
    }
    this.shown = true;
    this.loader.now();
  }

  /** Reads the next page, unless something is being read already or nothing is left. */
  loadMore(): void {
    const { items, nextCursor } = this.state;
    if (this.reading || this.more || items === null || !nextCursor) return;
    const controller = new AbortController();
    this.more = controller;
    this.set({ loadingMore: true, moreFailed: false });
    void this.load(nextCursor, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        this.set({
          items: joined(this.state.items ?? [], page.items),
          nextCursor: page.nextCursor,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) this.set({ moreFailed: true });
      })
      .finally(() => {
        if (this.more !== controller) return;
        this.more = null;
        this.set({ loadingMore: false });
      });
  }

  /** Drops whatever is being read or waits to be. A later `start` begins again. */
  stop(): void {
    this.loader.stop();
    this.dropMore();
    this.reading = false;
  }

  private async fromTop(signal: AbortSignal): Promise<void> {
    // A page being added would be read again here anyway.
    this.dropMore();
    const shown = this.shown;
    this.shown = false;
    // Rows kept from another list say nothing about how far to read this one.
    const want = this.fresh ? 1 : Math.max(this.state.items?.length ?? 0, 1);
    this.reading = true;
    this.set(shown ? { loading: true, failed: false } : { refreshing: true });
    try {
      let items: T[] = [];
      let page = await this.load(undefined, signal);
      for (let pages = 1; ; pages++) {
        if (signal.aborted) return;
        items = joined(items, page.items);
        if (!page.nextCursor || items.length >= want || pages >= PAGED_REFRESH_PAGES) break;
        page = await this.load(page.nextCursor, signal);
      }
      this.fresh = false;
      this.set({
        items,
        nextCursor: page.nextCursor,
        loading: false,
        refreshing: false,
        failed: false,
        moreFailed: false,
      });
    } catch {
      if (!signal.aborted) this.set({ loading: false, refreshing: false, failed: true });
    } finally {
      if (!signal.aborted) this.reading = false;
    }
  }

  private dropMore(): void {
    this.more?.abort();
    this.more = null;
    if (this.state.loadingMore) this.set({ loadingMore: false });
  }

  private set(patch: Partial<PagedListState<T>>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}

/** One page after another, without a row twice when the list moved between reads. */
function joined<T extends { id: string }>(before: T[], after: T[]): T[] {
  const seen = new Set(before.map((item) => item.id));
  return [...before, ...after.filter((item) => !seen.has(item.id))];
}

/**
 * A `PagedList` for a component. A change in `key` is a different list, read
 * from its first page, with what is shown kept meanwhile when `keep` is set;
 * `load` is read when each page is asked for, so it may close over the latest
 * props.
 */
export function usePagedList<T extends { id: string }>(
  load: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>,
  key: string,
  delayMs = PAGED_REFRESH_DELAY_MS,
  { keep = false }: { keep?: boolean } = {},
) {
  const latest = useRef(load);
  latest.current = load;
  const [state, setState] = useState<PagedListState<T>>(EMPTY);
  const [list] = useState(
    () => new PagedList<T>((cursor, signal) => latest.current(cursor, signal), setState, delayMs),
  );
  useEffect(() => {
    list.start({ keep });
    return () => list.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a list keeps rows or not for good
  }, [list, key]);
  return { ...state, list };
}
