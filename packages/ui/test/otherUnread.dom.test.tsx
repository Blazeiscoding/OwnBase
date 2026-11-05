import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ApiError } from "@ownbase/client-core";
import type { UnreadSummary } from "@ownbase/protocol";
import {
  OTHER_UNREAD_EVERY_MS,
  useOtherWorkspacesUnread,
  type UnreadSource,
} from "../src/lib/otherUnread.js";

/**
 * Only the open workspace keeps a connection, so the rail asks the others what
 * waits there now and then: on a timer while the window is seen, at once when
 * it is focused again, and never for one that cannot answer.
 */
const design: UnreadSource = { url: "http://design.test", token: "test-token-design" };
const garden: UnreadSource = { url: "http://garden.test", token: "test-token-garden" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A way to ask each workspace, answering what the test says it holds now. */
function answering(holds: Record<string, UnreadSummary | Error>) {
  const asked: string[] = [];
  const makeApi = (url: string) => ({
    unreadSummary: async () => {
      asked.push(url);
      const answer = holds[url];
      if (!answer || answer instanceof Error) throw answer ?? new ApiError(404, "not_found");
      return answer;
    },
  });
  return { asked, makeApi };
}

const settle = () => act(async () => {});

describe("what waits in the workspaces not open", () => {
  it("is asked at once, then every so often, and kept by address", async () => {
    vi.useFakeTimers();
    const holds: Record<string, UnreadSummary | Error> = {
      [design.url]: { mentions: 2, unread: true },
      [garden.url]: { mentions: 0, unread: false },
    };
    const { asked, makeApi } = answering(holds);
    const { result } = renderHook(() => useOtherWorkspacesUnread([design, garden], makeApi));
    await settle();
    expect(result.current).toEqual({
      [design.url]: { mentions: 2, unread: true },
      [garden.url]: { mentions: 0, unread: false },
    });
    expect(asked).toEqual([design.url, garden.url]);

    holds[garden.url] = { mentions: 0, unread: true };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OTHER_UNREAD_EVERY_MS);
    });
    expect(result.current[garden.url]).toEqual({ mentions: 0, unread: true });
  });

  it("asks again when the window is focused", async () => {
    const { asked, makeApi } = answering({ [design.url]: { mentions: 0, unread: false } });
    renderHook(() => useOtherWorkspacesUnread([design], makeApi));
    await settle();
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(asked).toEqual([design.url, design.url]);
  });

  it("shows nothing for one that cannot answer: an older server, an ended sign-in, no connection", async () => {
    const { makeApi } = answering({
      [design.url]: new ApiError(401, "unauthorized"),
      [garden.url]: new TypeError("Failed to fetch"),
    });
    const { result } = renderHook(() => useOtherWorkspacesUnread([design, garden], makeApi));
    await settle();
    expect(result.current).toEqual({});
  });

  it("forgets a workspace once it is the open one, and asks nothing with none to ask", async () => {
    const { asked, makeApi } = answering({ [design.url]: { mentions: 1, unread: true } });
    const { result, rerender } = renderHook(
      ({ sources }) => useOtherWorkspacesUnread(sources, makeApi),
      { initialProps: { sources: [design] } },
    );
    await settle();
    expect(result.current[design.url]).toEqual({ mentions: 1, unread: true });
    rerender({ sources: [] });
    await settle();
    expect(result.current).toEqual({});
    expect(asked).toEqual([design.url]);
  });

  it("does not ask again for a re-render with the same sign-ins", async () => {
    const { asked, makeApi } = answering({ [design.url]: { mentions: 0, unread: false } });
    const { rerender } = renderHook(() => useOtherWorkspacesUnread([{ ...design }], makeApi));
    await settle();
    rerender();
    rerender();
    await settle();
    expect(asked).toEqual([design.url]);
  });
});
