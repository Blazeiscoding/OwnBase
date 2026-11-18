import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { render } from "./render.js";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { UnreadOutside } from "../src/components/UnreadOutside.js";
import { unreadOnIcon } from "../src/lib/unreadOnIcon.js";
import type { Platform } from "../src/platform.js";
import type { OtherWorkspace } from "../src/components/Sidebar.js";

const general = { id: "C_GENERAL", type: "public", name: "general" } as Channel;
const random = { id: "C_RANDOM", type: "public", name: "random" } as Channel;

function open(
  figures: { mentions?: number; unread?: boolean; muted?: boolean },
  options: { others?: OtherWorkspace[]; platform?: Partial<Platform> } = {},
) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    channels: { C_GENERAL: general, C_RANDOM: random },
    memberships: { C_GENERAL: 5, C_RANDOM: 3 },
    channelLastSeq: { C_GENERAL: 5, C_RANDOM: figures.unread ? 9 : 3 },
    mentionCounts: figures.mentions ? { C_GENERAL: figures.mentions } : {},
    prefs: figures.muted ? ({ C_RANDOM: { muted: true } } as never) : {},
  });
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
    ...options.platform,
  };
  const view = render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <UnreadOutside others={options.others ?? []} />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return { ...view, client, platform };
}

afterEach(() => {
  document.title = "OwnBase";
  vi.restoreAllMocks();
});

describe("the tab's title", () => {
  it("counts the mentions waiting", () => {
    open({ mentions: 3, unread: true });
    expect(document.title).toBe("(3) OwnBase");
  });

  it("adds the other workspaces' mentions, as their rail badges show them", () => {
    open(
      { mentions: 1 },
      {
        others: [
          {
            url: "https://a.example",
            name: "A",
            handle: "sam",
            waiting: { mentions: 2, unread: true },
          },
          { url: "https://b.example", name: "B", handle: "sam" },
        ],
      },
    );
    expect(document.title).toBe("(3) OwnBase");
  });

  it("is a dot when only messages without a mention wait", () => {
    open({ unread: true });
    expect(document.title).toBe("• OwnBase");
  });

  it("is the plain name when nothing waits, or only in a muted conversation", () => {
    open({});
    expect(document.title).toBe("OwnBase");
    open({ unread: true, muted: true });
    expect(document.title).toBe("OwnBase");
  });

  it("follows the count as it changes, and goes back to the name when the workspace closes", () => {
    const { client, unmount } = open({ mentions: 2 });
    expect(document.title).toBe("(2) OwnBase");
    act(() => client.store.setState({ mentionCounts: {} }));
    expect(document.title).toBe("OwnBase");
    act(() => client.store.setState({ mentionCounts: { C_GENERAL: 4 } }));
    expect(document.title).toBe("(4) OwnBase");
    unmount();
    expect(document.title).toBe("OwnBase");
  });

  it("shows nothing with the switch off", async () => {
    const { platform } = open({ mentions: 3 });
    expect(document.title).toBe("(3) OwnBase");
    act(() => unreadOnIcon(platform).getState().setShow(false));
    expect(document.title).toBe("OwnBase");
  });
});

describe("outside the page", () => {
  it("tells the desktop app, with zeros when the switch goes off", () => {
    const setUnread = vi.fn();
    const { platform } = open({ mentions: 3 }, { platform: { kind: "desktop", setUnread } });
    expect(setUnread).toHaveBeenLastCalledWith({ count: 3, dot: false });
    act(() => unreadOnIcon(platform).getState().setShow(false));
    expect(setUnread).toHaveBeenLastCalledWith({ count: 0, dot: false });
  });

  it("sets an installed browser app's badge where the browser has one", () => {
    const setAppBadge = vi.fn(() => Promise.resolve());
    const clearAppBadge = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { setAppBadge, clearAppBadge });
    try {
      const { client, unmount } = open({ mentions: 2 });
      expect(setAppBadge).toHaveBeenLastCalledWith(2);
      act(() => client.store.setState({ mentionCounts: {}, channelLastSeq: { C_RANDOM: 9 } }));
      // A dot: the badge with no number.
      expect(setAppBadge).toHaveBeenLastCalledWith();
      unmount();
      expect(clearAppBadge).toHaveBeenCalled();
    } finally {
      delete (navigator as { setAppBadge?: unknown }).setAppBadge;
      delete (navigator as { clearAppBadge?: unknown }).clearAppBadge;
    }
  });
});
