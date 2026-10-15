import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAGED_REFRESH_PAGES,
  PagedList,
  type Page,
  type PagedListState,
} from "../src/lib/pagedList.js";

/**
 * A list read a page at a time that stays current (UX-08): more is read after
 * what is shown, and a sign that it may be out of date reads it again from the
 * top, in place, as far as it had been read.
 */
type Row = { id: string };
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));

function harness() {
  const asks: {
    cursor: string | undefined;
    signal: AbortSignal;
    answer: (page: Page<Row>) => void;
    fail: () => void;
  }[] = [];
  const states: PagedListState<Row>[] = [];
  const list = new PagedList<Row>(
    (cursor, signal) =>
      new Promise<Page<Row>>((resolve, reject) => {
        asks.push({
          cursor,
          signal,
          answer: resolve,
          fail: () => reject(new TypeError("Failed to fetch")),
        });
      }),
    (state) => states.push(state),
    250,
  );
  const ids = () => list.current.items?.map((row) => row.id) ?? null;
  return { list, asks, states, ids };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a paged list", () => {
  it("reads the first page, then more after it when asked", async () => {
    const { list, asks, ids } = harness();
    list.start();
    expect(list.current.loading).toBe(true);
    asks[0]!.answer({ items: rows("a", "b"), nextCursor: "b" });
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual(["a", "b"]);
    expect(list.current.loading).toBe(false);

    list.loadMore();
    list.loadMore();
    expect(asks).toHaveLength(2);
    expect(asks[1]!.cursor).toBe("b");
    expect(list.current.loadingMore).toBe(true);
    // A row the list moved onto the next page meanwhile is not shown twice.
    asks[1]!.answer({ items: rows("b", "c"), nextCursor: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(list.current.nextCursor).toBeNull();

    list.loadMore();
    expect(asks).toHaveLength(2);
  });

  it("reads again from the top as far as it had read, and shows it all at once, in place", async () => {
    const { list, asks, states, ids } = harness();
    list.start();
    asks[0]!.answer({ items: rows("a", "b"), nextCursor: "b" });
    await vi.advanceTimersByTimeAsync(0);
    list.loadMore();
    asks[1]!.answer({ items: rows("c", "d"), nextCursor: "d" });
    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 5; i++) list.refresh();
    await vi.advanceTimersByTimeAsync(250);
    expect(asks).toHaveLength(3);
    expect(asks[2]!.cursor).toBeUndefined();
    // Quietly: nothing blanks and no loading line is asked for.
    expect(list.current.loading).toBe(false);
    expect(list.current.refreshing).toBe(true);
    expect(ids()).toEqual(["a", "b", "c", "d"]);

    asks[2]!.answer({ items: rows("new", "a"), nextCursor: "a" });
    await vi.advanceTimersByTimeAsync(0);
    expect(asks[3]!.cursor).toBe("a");
    expect(ids()).toEqual(["a", "b", "c", "d"]);
    asks[3]!.answer({ items: rows("c", "d"), nextCursor: "d" });
    await vi.advanceTimersByTimeAsync(0);
    // Four rows had been read, so it stops at four: "b" went meanwhile.
    expect(ids()).toEqual(["new", "a", "c", "d"]);
    expect(list.current.nextCursor).toBe("d");
    expect(list.current.refreshing).toBe(false);
    expect(asks).toHaveLength(4);
    expect(states.every((state) => state.items !== null || state.loading)).toBe(true);
  });

  it(`reads no more than ${PAGED_REFRESH_PAGES} pages again, however far it had gone`, async () => {
    const { list, asks } = harness();
    list.start();
    asks[0]!.answer({ items: rows("p0"), nextCursor: "p0" });
    await vi.advanceTimersByTimeAsync(0);
    for (let page = 1; page < 15; page++) {
      list.loadMore();
      asks.at(-1)!.answer({ items: rows(`p${page}`), nextCursor: `p${page}` });
      await vi.advanceTimersByTimeAsync(0);
    }
    const before = asks.length;
    list.refresh();
    await vi.advanceTimersByTimeAsync(250);
    for (let page = 0; page < 20 && asks.length > before + page; page++) {
      asks[before + page]!.answer({ items: rows(`p${page}`), nextCursor: `p${page}` });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(asks.length - before).toBe(PAGED_REFRESH_PAGES);
    expect(list.current.items).toHaveLength(PAGED_REFRESH_PAGES);
    expect(list.current.nextCursor).toBe(`p${PAGED_REFRESH_PAGES - 1}`);
  });

  it("lets a running read finish, then reads once more, never older over newer", async () => {
    const { list, asks, ids } = harness();
    list.start();
    list.refresh();
    list.refresh();
    expect(asks[0]!.signal.aborted).toBe(false);
    asks[0]!.answer({ items: rows("old"), nextCursor: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual(["old"]);
    expect(asks).toHaveLength(2);
    asks[1]!.answer({ items: rows("new"), nextCursor: null });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ids()).toEqual(["new"]);
    expect(asks).toHaveLength(2);
  });

  it("drops a page being added when it reads again from the top, and is asked for more after", async () => {
    const { list, asks, ids } = harness();
    list.start();
    asks[0]!.answer({ items: rows("a"), nextCursor: "a" });
    await vi.advanceTimersByTimeAsync(0);
    list.loadMore();
    list.refresh();
    await vi.advanceTimersByTimeAsync(250);
    expect(asks[1]!.signal.aborted).toBe(true);
    expect(list.current.loadingMore).toBe(false);
    // Nothing more while reading from the top: that read covers it.
    list.loadMore();
    expect(asks).toHaveLength(3);
    asks[1]!.answer({ items: rows("late"), nextCursor: null });
    asks[2]!.answer({ items: rows("a"), nextCursor: "a" });
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual(["a"]);
    list.loadMore();
    expect(asks[3]!.cursor).toBe("a");
  });

  it("starts a different list from nothing, and ignores the old one's late answer", async () => {
    const { list, asks, ids } = harness();
    list.start();
    asks[0]!.answer({ items: rows("a"), nextCursor: null });
    await vi.advanceTimersByTimeAsync(0);
    list.refresh();
    await vi.advanceTimersByTimeAsync(250);
    list.start();
    expect(asks[1]!.signal.aborted).toBe(true);
    expect(ids()).toBeNull();
    expect(list.current.loading).toBe(true);
    asks[1]!.answer({ items: rows("stale"), nextCursor: null });
    asks[2]!.answer({ items: rows("other"), nextCursor: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual(["other"]);
  });

  it("keeps what it shows when a read fails, and Retry reads it where it is seen", async () => {
    const { list, asks, ids } = harness();
    list.start();
    asks[0]!.answer({ items: rows("a"), nextCursor: "a" });
    await vi.advanceTimersByTimeAsync(0);
    list.refresh();
    await vi.advanceTimersByTimeAsync(250);
    asks[1]!.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(list.current.failed).toBe(true);
    expect(ids()).toEqual(["a"]);

    list.retry();
    expect(list.current.loading).toBe(true);
    asks.at(-1)!.answer({ items: rows("a", "b"), nextCursor: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(list.current.failed).toBe(false);
    expect(ids()).toEqual(["a", "b"]);
  });

  it("tries more again, not the whole list, when only more failed", async () => {
    const { list, asks, ids } = harness();
    list.start();
    asks[0]!.answer({ items: rows("a"), nextCursor: "a" });
    await vi.advanceTimersByTimeAsync(0);
    list.loadMore();
    asks[1]!.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(list.current.moreFailed).toBe(true);
    list.retry();
    expect(asks[2]!.cursor).toBe("a");
    asks[2]!.answer({ items: rows("b"), nextCursor: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual(["a", "b"]);
    expect(list.current.moreFailed).toBe(false);
  });

  it("drops everything on stop, and starts again cleanly", async () => {
    const { list, asks, ids } = harness();
    list.start();
    list.refresh();
    list.stop();
    expect(asks[0]!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(asks).toHaveLength(1);
    list.start();
    asks[1]!.answer({ items: rows("a"), nextCursor: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual(["a"]);
  });
});
