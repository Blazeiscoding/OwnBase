import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { WorkspaceClient } from "@ownbase/client-core";
import type { User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { useLastConversation } from "../src/lib/lastConversation.js";
import type { Platform } from "../src/platform.js";

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

/** A device whose saved values live in a map, with every call recorded. */
function device(saved: Record<string, unknown> = {}, failing = false) {
  const values = new Map(Object.entries(saved));
  const set = vi.fn(async (name: string, value: unknown) => {
    if (failing) throw new Error("storage is full");
    values.set(name, value);
  });
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(name: string) => {
        if (failing) throw new Error("storage is unavailable");
        return (values.get(name) ?? null) as T | null;
      },
      set,
    },
    notify: () => {},
  };
  return { platform, values, set };
}

function open(platform: Platform, selfId: string | null, workspaceId = "W_ROCKET") {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: selfId ? person(selfId) : null, workspaceId });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
    </PlatformContext.Provider>
  );
  return { client, ...renderHook(() => useLastConversation(), { wrapper }) };
}

const slot = (workspaceId: string, selfId: string) =>
  `local:v1:${workspaceId}:${selfId}:last-conversation`;

describe("the conversation someone last had open", () => {
  it("is unknown until read, then kept apart per workspace and per account", async () => {
    const { platform } = device({
      [slot("W_ROCKET", "U_SAM")]: "C_DESIGN",
      [slot("W_ROCKET", "U_PRIYA")]: "C_OPS",
      [slot("W_OTHER", "U_SAM")]: "C_ELSEWHERE",
    });
    const sam = open(platform, "U_SAM");
    expect(sam.result.current.remembered).toBeUndefined();
    await waitFor(() => expect(sam.result.current.remembered).toBe("C_DESIGN"));

    const priya = open(platform, "U_PRIYA");
    await waitFor(() => expect(priya.result.current.remembered).toBe("C_OPS"));
    const elsewhere = open(platform, "U_SAM", "W_OTHER");
    await waitFor(() => expect(elsewhere.result.current.remembered).toBe("C_ELSEWHERE"));
  });

  it("waits for the account before reading anything", async () => {
    const { platform } = device({ [slot("W_ROCKET", "U_SAM")]: "C_DESIGN" });
    const { client, result } = open(platform, null);
    await act(async () => {});
    expect(result.current.remembered).toBeUndefined();
    act(() => client.store.setState({ self: person("U_SAM") }));
    await waitFor(() => expect(result.current.remembered).toBe("C_DESIGN"));
  });

  it("answers nothing, rather than waiting, for a slot that is empty, odd or unreadable", async () => {
    const empty = open(device().platform, "U_SAM");
    await waitFor(() => expect(empty.result.current.remembered).toBeNull());

    const odd = open(device({ [slot("W_ROCKET", "U_SAM")]: "../C_DESIGN" }).platform, "U_SAM");
    await waitFor(() => expect(odd.result.current.remembered).toBeNull());

    const broken = open(device({}, true).platform, "U_SAM");
    await waitFor(() => expect(broken.result.current.remembered).toBeNull());
  });

  it("saves where someone goes, once per change, and keeps quiet when saving fails", async () => {
    const { platform, values, set } = device();
    const { result } = open(platform, "U_SAM");
    await waitFor(() => expect(result.current.remembered).toBeNull());
    act(() => result.current.remember("C_DESIGN"));
    act(() => result.current.remember("C_DESIGN"));
    await waitFor(() => expect(values.get(slot("W_ROCKET", "U_SAM"))).toBe("C_DESIGN"));
    expect(set).toHaveBeenCalledTimes(1);
    act(() => result.current.remember("C_OPS"));
    await waitFor(() => expect(values.get(slot("W_ROCKET", "U_SAM"))).toBe("C_OPS"));

    const failing = open(device({}, true).platform, "U_SAM");
    await waitFor(() => expect(failing.result.current.remembered).toBeNull());
    expect(() => act(() => failing.result.current.remember("C_DESIGN"))).not.toThrow();
  });
});
