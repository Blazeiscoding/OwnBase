import { render, screen, waitFor } from "@testing-library/react";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, User } from "@ownbase/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { JumpToLatestBar, MessageTimeline } from "../src/components/MessageTimeline.js";
import { ToastProvider } from "../src/components/Toast.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";

/**
 * The New line goes above the first message not yet read, and only where that
 * is known: with more missed than one page holds, the conversation opens on a
 * window around the first of them rather than the newest (X3).
 */
const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};
const maya: User = { ...sam, id: "U_MAYA", handle: "maya", displayName: "Maya Chen" };
const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id, maya.id],
};
const message = (n: number): Message =>
  ({
    id: `M_${String(n).padStart(3, "0")}`,
    channelId: general.id,
    userId: sam.id,
    text: `Line ${n} of the log`,
    seq: n,
    createdAt: n,
    editedAt: null,
    threadRootId: null,
    broadcast: false,
    replyCount: 0,
    reactions: [],
    files: [],
    pinned: false,
    actions: [],
  }) as unknown as Message;
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => message(from + i));

afterEach(() => vi.restoreAllMocks());

function timeline(
  readUpTo: number,
  window: { items: Message[]; hasMore: boolean; hasMoreNewer?: boolean } | null,
) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: maya,
    users: { [sam.id]: sam, [maya.id]: maya },
    channels: { [general.id]: general },
    memberships: { [general.id]: readUpTo },
    timelines: window
      ? { [general.id]: { ...window, hasMoreNewer: window.hasMoreNewer ?? false, loaded: true } }
      : {},
    status: "online",
  });
  const load = vi.spyOn(client, "loadTimeline").mockResolvedValue(undefined);
  vi.spyOn(client, "markRead").mockImplementation(() => {});
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <ToastProvider>
          <ConfirmProvider>
            <MessageTimeline
              channelId={general.id}
              onOpenThread={() => {}}
              onChannelClick={() => {}}
              onOpenProfile={() => {}}
            />
            <JumpToLatestBar channelId={general.id} />
          </ConfirmProvider>
        </ToastProvider>
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return { client, load };
}

const line = () => screen.queryByRole("separator", { name: "New messages" });
/** The message the New line sits above. */
const below = () => line()?.closest("[data-mid]")?.getAttribute("data-mid");

describe("the New line", () => {
  it("asks for history from where reading stopped when it opens", async () => {
    const { load } = timeline(40, null);
    await waitFor(() =>
      expect(load).toHaveBeenCalledWith(general.id, { older: false, unreadAfter: 40 }),
    );
  });

  it("sits above the first unread when what was read is loaded above it", () => {
    timeline(40, { items: range(30, 80), hasMore: true });
    expect(below()).toBe("M_041");
  });

  it("is left out while the first unread may be further up", () => {
    timeline(40, { items: range(51, 100), hasMore: true });
    expect(line()).toBeNull();
  });

  it("sits above the oldest message when nothing older exists", () => {
    timeline(40, { items: range(41, 60), hasMore: false });
    expect(below()).toBe("M_041");
  });

  it("says the window opened on what was missed is catching up, not older messages", () => {
    timeline(40, { items: range(30, 80), hasMore: true, hasMoreNewer: true });
    expect(screen.getByRole("button", { name: /Jump to latest/ })).toHaveTextContent(
      "Catching up · Jump to latest",
    );
  });

  it("says a window jumped back to something read is older messages", () => {
    timeline(90, { items: range(30, 80), hasMore: true, hasMoreNewer: true });
    expect(screen.getByRole("button", { name: /Jump to latest/ })).toHaveTextContent(
      "You're viewing older messages · Jump to latest",
    );
  });
});
