import { act, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, User } from "@ownbase/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ThreadPanel } from "../src/components/ThreadPanel.js";
import { ToastProvider } from "../src/components/Toast.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import { rememberThreadPosition, rememberedThreadPosition } from "../src/lib/threadPosition.js";
import type { Platform } from "../src/platform.js";

/**
 * A long thread left partway through opens again where it was left (IMP-02),
 * and what is below that place stays unread until it is scrolled to.
 */
const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};
const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id],
};
const message = (id: string, seq: number, threadRootId: string | null = "M_ROOT"): Message =>
  ({
    id,
    channelId: design.id,
    userId: sam.id,
    text: `message ${id}`,
    seq,
    createdAt: 0,
    editedAt: null,
    threadRootId,
    broadcast: false,
    replyCount: 0,
    reactions: [],
    files: [],
    pinned: false,
    actions: [],
  }) as unknown as Message;
const root = message("M_ROOT", 1, null);
const replies = [message("M_R1", 2), message("M_R2", 3), message("M_R3", 4)];
const SERVER = "http://127.0.0.1:9";

function openThread(targetId?: string) {
  const client = new WorkspaceClient(SERVER, "test-token-not-a-credential");
  client.store.setState({
    self: { ...sam, id: "U_OTHER" },
    users: { [sam.id]: sam },
    channels: { [design.id]: design },
    memberships: { [design.id]: root.seq },
    threadPages: {
      [root.id]: {
        channelId: design.id,
        root: { ...root, replyCount: replies.length },
        hasMoreOlder: false,
        hasMoreNewer: false,
        loading: false,
        loaded: true,
        error: null,
      },
    },
    threads: { [root.id]: replies },
    status: "online",
  });
  const loadThread = vi.spyOn(client, "loadThread").mockResolvedValue(undefined);
  const markThreadRead = vi.spyOn(client, "markThreadRead").mockImplementation(() => {});
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
            <ThreadPanel
              channelId={design.id}
              rootId={root.id}
              targetId={targetId}
              onClose={() => {}}
              onChannelClick={() => {}}
              onOpenProfile={() => {}}
            />
          </ConfirmProvider>
        </ToastProvider>
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const scroller = screen
    .getByRole("complementary", { name: "Thread" })
    .querySelector<HTMLElement>("[aria-busy]")!;
  return { client, loadThread, markThreadRead, scroller };
}

/** Lays the replies out 50 pixels apart from the top, under a panel that starts at 100. */
function layOut(scroller: HTMLElement) {
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const index = replies.findIndex((m) => m.id === (this as HTMLElement).dataset.reply);
    const top = this === scroller ? 100 : 40 + index * 50;
    return { top, bottom: top + 50, left: 0, right: 0, width: 0, height: 50 } as DOMRect;
  });
}

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rememberThreadPosition(SERVER, root.id, null);
});

describe("a thread's reading position (IMP-02)", () => {
  it("notes the reply at the top when scrolled back, and forgets it at the newest", () => {
    const { scroller } = openThread();
    layOut(scroller);
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    // The second reply reaches into the panel, its top 10 pixels above it.
    expect(rememberedThreadPosition(SERVER, root.id)).toEqual({ messageId: "M_R2", offset: -10 });

    scroller.scrollTop = 700;
    fireEvent.scroll(scroller);
    expect(rememberedThreadPosition(SERVER, root.id)).toBeNull();
  });

  it("opens again at that reply, and reads nothing it has not shown", async () => {
    rememberThreadPosition(SERVER, root.id, { messageId: "M_R2", offset: -10 });
    const { loadThread, markThreadRead } = openThread();
    expect(loadThread).toHaveBeenCalledWith(root.id, design.id, "latest", "M_R2");
    act(() => void window.dispatchEvent(new Event("focus")));
    await act(async () => {});
    expect(markThreadRead).not.toHaveBeenCalled();
  });

  it("opens at a reply asked for, wherever the thread was left", () => {
    rememberThreadPosition(SERVER, root.id, { messageId: "M_R2", offset: -10 });
    const { loadThread } = openThread("M_R3");
    expect(loadThread).toHaveBeenCalledWith(root.id, design.id, "latest", "M_R3");
  });

  it("opens at the newest reply, reading it, when it was left there", async () => {
    const { loadThread, markThreadRead } = openThread();
    expect(loadThread).toHaveBeenCalledWith(root.id, design.id, "latest", undefined);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(markThreadRead).toHaveBeenCalledWith(root.id);
  });
});
