import { act, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, User } from "@ownbase/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityPanel } from "../src/components/ActivityPanel.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ThreadPanel } from "../src/components/ThreadPanel.js";
import { ToastProvider } from "../src/components/Toast.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";

/**
 * Reading a thread moves the thread's cursor and nothing else: a channel
 * message the reader has not seen, sent between the root and the reply, stays
 * unread with its mention.
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
const priya: User = { ...sam, id: "U_PRIYA", handle: "priya", displayName: "Priya Shah" };

const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id, priya.id],
};

const message = (id: string, text: string, seq: number, extra: Partial<Message> = {}): Message =>
  ({
    id,
    channelId: design.id,
    userId: priya.id,
    text,
    seq,
    createdAt: Date.UTC(2026, 8, 20, 10, 0),
    editedAt: null,
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    reactions: [],
    files: [],
    pinned: false,
    actions: [],
    ...extra,
  }) as unknown as Message;

// Root 10, read through the channel; an unseen mention 11; a reply 12.
const root = message("M_ROOT", "Plans for Friday", 10, { replyCount: 1 });
const mention = message("M_MENTION", `can you look <@${sam.id}>`, 11);
const reply = message("M_REPLY", `and this <@${sam.id}>`, 12, { threadRootId: root.id });

function workspace() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [priya.id]: priya },
    channels: { [design.id]: design },
    memberships: { [design.id]: root.seq },
    channelLastSeq: { [design.id]: mention.seq },
    mentionCounts: { [design.id]: 2 },
    threadPages: {
      [root.id]: {
        channelId: design.id,
        root,
        hasMoreOlder: false,
        hasMoreNewer: false,
        loading: false,
        loaded: true,
        error: null,
      },
    },
    threads: { [root.id]: [reply] },
    status: "online",
  });
  vi.spyOn(client, "loadThread").mockResolvedValue(undefined);
  const markRead = vi.spyOn(client, "markRead");
  const markThreadRead = vi
    .spyOn(client.api, "markThreadRead")
    .mockImplementation(async (rootId, seq) => ({
      state: {
        rootId,
        channelId: design.id,
        following: false,
        lastReadSeq: seq,
        lastSeq: seq,
        revision: Date.now(),
      },
    }));
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };
  return { client, platform, markRead, markThreadRead };
}

afterEach(() => vi.restoreAllMocks());

describe("an open thread", () => {
  it("reads its replies without acknowledging the channel", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { client, platform, markRead, markThreadRead } = workspace();
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <ToastProvider>
            <ConfirmProvider>
              <ThreadPanel
                channelId={design.id}
                rootId={root.id}
                onClose={() => {}}
                onChannelClick={() => {}}
                onOpenProfile={() => {}}
              />
            </ConfirmProvider>
          </ToastProvider>
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );

    // The panel reads what it shows once the window has focus.
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(markThreadRead).toHaveBeenCalledWith(root.id, reply.seq));
    expect(markRead).not.toHaveBeenCalled();
    expect(client.state.memberships[design.id]).toBe(root.seq);
    expect(client.state.threadFollows[root.id]).toMatchObject({
      following: false,
      lastReadSeq: reply.seq,
    });
  });

  it("leaves the unseen channel mention in Activity, and not the reply it read", async () => {
    const { client, platform } = workspace();
    client.store.setState({
      threadFollows: {
        [root.id]: {
          rootId: root.id,
          channelId: design.id,
          following: false,
          lastReadSeq: reply.seq,
          lastSeq: reply.seq,
          revision: 1,
        },
      },
    });
    // An answer from before the thread was read still lists both.
    vi.spyOn(client.api, "activity").mockResolvedValue({
      messages: [reply, mention],
      nextCursor: null,
    });
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <ActivityPanel onClose={() => {}} onJump={() => {}} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    expect(await screen.findByText(/can you look/)).toBeVisible();
    expect(screen.queryByText(/and this/)).toBeNull();
  });
});
