import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { WorkspaceClient } from "@ownbase/client-core";
import type { User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { useRecentConversations } from "../src/lib/recentConversations.js";
import type { Platform } from "../src/platform.js";

const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam",
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

/** Kept wrapped, as a kind that was kept before workspaces had ids. */
const SLOT = "local:v1:W_ROCKET:U_SAM:recent-conversations";

/** A device whose saved values live in a map, answering reads only once `answer` is called. */
function device(saved: Record<string, unknown>, failing = false) {
  const values = new Map(Object.entries(saved));
  let answer = () => {};
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(name: string) => {
        await answered;
        if (failing) throw new Error("storage is unavailable");
        return (values.get(name) ?? null) as T | null;
      },
      set: vi.fn(async (name: string, value: unknown) => {
        values.set(name, value);
      }),
    },
    notify: () => {},
  };
  return { platform, values, answer: () => act(answer) };
}

function open(platform: Platform) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, workspaceId: "W_ROCKET" });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
    </PlatformContext.Provider>
  );
  return renderHook(() => useRecentConversations(), { wrapper });
}

describe("the conversations Ctrl+K offers first", () => {
  it("puts what was opened while the stored list was read before it, and keeps the list wrapped", async () => {
    const { platform, values, answer } = device({
      [SLOT]: { version: 1, value: ["C_DESIGN", "C_OPS"] },
    });
    const { result } = open(platform);
    act(() => result.current.remember("C_OPS"));
    act(() => result.current.remember("C_NEW"));
    expect(result.current.recent).toEqual(["C_NEW", "C_OPS"]);
    await answer();
    await waitFor(() => expect(result.current.recent).toEqual(["C_NEW", "C_OPS", "C_DESIGN"]));
    await waitFor(() =>
      expect(values.get(SLOT)).toEqual({ version: 1, value: ["C_NEW", "C_OPS", "C_DESIGN"] }),
    );
    act(() => result.current.remember("C_DESIGN"));
    expect(result.current.recent).toEqual(["C_DESIGN", "C_NEW", "C_OPS"]);
  });

  it("starts from nothing when the stored list cannot be read", async () => {
    const { platform, answer } = device({}, true);
    const { result } = open(platform);
    await answer();
    act(() => result.current.remember("C_DESIGN"));
    expect(result.current.recent).toEqual(["C_DESIGN"]);
  });
});
