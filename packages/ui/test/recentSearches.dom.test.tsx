import { act, renderHook, waitFor } from "@testing-library/react";
import { WorkspaceClient } from "@ownbase/client-core";
import type { User } from "@ownbase/protocol";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ClientContext, PlatformContext } from "../src/context.js";
import { useRecentSearches } from "../src/lib/recentSearches.js";
import { workspaceStorageKey } from "../src/lib/workspaceStorage.js";
import type { Platform } from "../src/platform.js";

/**
 * Recent searches, kept on the device for each account in each workspace:
 * newest first, no repeats, ten at most, and never undone by a write that
 * lands after Clear.
 */
const base = "http://127.0.0.1:9";
const person = (id: string): User => ({
  id,
  handle: id.toLowerCase(),
  displayName: id,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});

function fakePlatform(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  const control = { failing: false, slow: null as Promise<void> | null };
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(name: string) => {
        if (control.failing) throw new Error("storage refused");
        return (values.get(name) ?? null) as T | null;
      },
      set: async (name: string, value: unknown) => {
        if (control.slow) await control.slow;
        if (control.failing) throw new Error("storage refused");
        values.set(name, value);
      },
    },
    notify: () => {},
  };
  return { platform, values, control };
}

function renderHistory(platform: Platform, selfId = "U1", workspaceId = "W1") {
  const client = new WorkspaceClient(base, "test-token-not-a-credential");
  client.store.setState({ self: person(selfId), workspaceId });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
    </PlatformContext.Provider>
  );
  return renderHook(() => useRecentSearches(), { wrapper });
}

const keyFor = (selfId = "U1", workspaceId = "W1") =>
  workspaceStorageKey(base, workspaceId, selfId, "recent-searches")!.key;
const stored = (values: Map<string, unknown>, selfId?: string) =>
  (values.get(keyFor(selfId)) as { value: unknown } | undefined)?.value;

describe("recent searches", () => {
  it("puts the newest first, moves a repeat to the front, and keeps ten", async () => {
    const { platform, values } = fakePlatform();
    const { result } = renderHistory(platform);
    await waitFor(() => expect(result.current.busy).toBe(false));

    for (let i = 1; i <= 11; i++) act(() => result.current.remember({ query: `q${i}` }));
    act(() => result.current.remember({ query: "q5", channelId: "C1" }));
    // Last, so what is on screen shows it moved rather than being read back.
    act(() => result.current.remember({ query: "q5" }));
    await waitFor(() => expect(result.current.busy).toBe(false));

    const expected = [
      { query: "q5" },
      { query: "q5", channelId: "C1" },
      { query: "q11" },
      { query: "q10" },
      { query: "q9" },
      { query: "q8" },
      { query: "q7" },
      { query: "q6" },
      { query: "q4" },
      { query: "q3" },
    ];
    expect(result.current.items).toEqual(expected);
    expect(stored(values)).toEqual(expected);
  });

  it("reads past anything malformed that was stored", async () => {
    const { platform } = fakePlatform({
      [keyFor()]: {
        version: 1,
        value: [
          { query: "design review" },
          { query: "design review" },
          { query: "   " },
          { query: "", channelId: "C1" },
          { query: "x".repeat(201) },
          { query: "in a room", channelId: "" },
          { query: 42 },
          null,
          { query: "from:@sam" },
        ],
      },
    });
    const { result } = renderHistory(platform);
    await waitFor(() =>
      expect(result.current.items).toEqual([
        { query: "design review" },
        { query: "", channelId: "C1" },
        { query: "from:@sam" },
      ]),
    );
  });

  it("stays cleared when a search remembered just before Clear is saved after it", async () => {
    const { platform, values, control } = fakePlatform();
    const { result } = renderHistory(platform);
    await waitFor(() => expect(result.current.busy).toBe(false));
    act(() => result.current.remember({ query: "kept" }));
    await waitFor(() => expect(result.current.items).toEqual([{ query: "kept" }]));

    let release!: () => void;
    control.slow = new Promise((resolve) => (release = resolve));
    act(() => result.current.remember({ query: "late" }));
    act(() => result.current.clear());
    release();
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.items).toEqual([]);
    expect(stored(values)).toEqual([]);
  });

  it("keeps one account's searches apart from another's", async () => {
    const { platform, values } = fakePlatform();
    const sam = renderHistory(platform, "U_SAM");
    await waitFor(() => expect(sam.result.current.busy).toBe(false));
    act(() => sam.result.current.remember({ query: "salary" }));
    await waitFor(() => expect(stored(values, "U_SAM")).toEqual([{ query: "salary" }]));

    const priya = renderHistory(platform, "U_PRIYA");
    await waitFor(() => expect(priya.result.current.busy).toBe(false));
    expect(priya.result.current.items).toEqual([]);
  });

  it("says when the device will not keep them, and search goes on without them", async () => {
    const { platform, control } = fakePlatform();
    control.failing = true;
    const { result } = renderHistory(platform);
    await waitFor(() =>
      expect(result.current.error).toBe(
        "Could not access recent searches on this device. Search still works.",
      ),
    );
    control.failing = false;
    act(() => result.current.remember({ query: "works again" }));
    await waitFor(() => expect(result.current.items).toEqual([{ query: "works again" }]));
    expect(result.current.error).toBeNull();
  });
});
