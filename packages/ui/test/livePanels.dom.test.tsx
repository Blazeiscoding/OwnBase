import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, ThreadFollow, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { SavedPanel, ThreadsPanel } from "../src/components/MessageListPanel.js";

/**
 * Saved and Threads keep themselves current while open (UX-08): a save on
 * another device, an edit to a message shown, or a new reply in a followed
 * thread reads the list again in place, with nothing to press and nothing
 * blanking meanwhile.
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

const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
};

const message = (id: string, text: string, seq: number): Message => ({
  id,
  channelId: general.id,
  userId: sam.id,
  text,
  threadRootId: null,
  broadcast: false,
  seq,
  createdAt: 0,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
});

const follow = (rootId: string, lastSeq: number, lastReadSeq = 0): ThreadFollow => ({
  rootId,
  channelId: general.id,
  following: true,
  lastReadSeq,
  lastSeq,
  revision: lastSeq,
});

function offlineClient() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: { [general.id]: general },
    memberships: { [general.id]: 0 },
    status: "online",
  });
  return client;
}

describe("the Saved panel", () => {
  it("shows a message saved on another device, and drops one unsaved there, without blanking", async () => {
    const client = offlineClient();
    let saved = [message("M1", "Saved earlier", 1)];
    client.store.setState({ saved: { M1: true } });
    const spy = vi
      .spyOn(client.api, "listSaved")
      .mockImplementation(async () => ({ messages: saved, nextCursor: null }));
    render(
      <ClientContext.Provider value={client}>
        <SavedPanel onClose={vi.fn()} onJump={vi.fn()} />
      </ClientContext.Provider>,
    );
    const panel = screen.getByRole("complementary", { name: "Saved" });
    expect(await within(panel).findByText("Saved earlier")).toBeVisible();
    expect(within(panel).queryByRole("button", { name: "Refresh" })).toBeNull();

    saved = [message("M2", "Saved on the phone", 2), ...saved];
    act(() => client.store.setState({ saved: { M1: true, M2: true } }));
    // What was shown stays while it asks.
    expect(within(panel).getByText("Saved earlier")).toBeVisible();
    expect(await within(panel).findByText("Saved on the phone")).toBeVisible();

    saved = [message("M2", "Saved on the phone", 2)];
    act(() => client.store.setState({ saved: { M2: true } }));
    await waitFor(() => expect(within(panel).queryByText("Saved earlier")).toBeNull());
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("asks again when a message it shows is edited, and not for other conversations", async () => {
    const client = offlineClient();
    let text = "Before the edit";
    client.store.setState({ saved: { M1: true } });
    const spy = vi
      .spyOn(client.api, "listSaved")
      .mockImplementation(async () => ({ messages: [message("M1", text, 1)], nextCursor: null }));
    render(
      <ClientContext.Provider value={client}>
        <SavedPanel onClose={vi.fn()} onJump={vi.fn()} />
      </ClientContext.Provider>,
    );
    const panel = screen.getByRole("complementary", { name: "Saved" });
    await within(panel).findByText("Before the edit");

    act(() => client.store.setState({ changedContent: { C_ELSEWHERE: 5 } }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spy).toHaveBeenCalledTimes(1);

    text = "After the edit";
    act(() => client.store.setState({ changedContent: { C_ELSEWHERE: 5, [general.id]: 6 } }));
    expect(await within(panel).findByText("After the edit")).toBeVisible();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("the Threads panel", () => {
  it("says a followed thread has a new reply as soon as one arrives", async () => {
    const client = offlineClient();
    const root = message("M1", "Where do we ship from?", 1);
    let unreadCount = 0;
    client.store.setState({ threadFollows: { M1: follow("M1", 1, 1) } });
    vi.spyOn(client.api, "listFollowedThreads").mockImplementation(async () => ({
      threads: [{ root, lastSeq: 1 + unreadCount, unreadCount }],
      nextCursor: null,
    }));
    render(
      <ClientContext.Provider value={client}>
        <ThreadsPanel onClose={vi.fn()} onJump={vi.fn()} />
      </ClientContext.Provider>,
    );
    const panel = screen.getByRole("complementary", { name: "Threads" });
    await within(panel).findByText("Where do we ship from?");
    expect(within(panel).queryByText(/new repl/)).toBeNull();

    unreadCount = 1;
    act(() => client.store.setState({ threadFollows: { M1: follow("M1", 2, 1) } }));
    expect(await within(panel).findByText("1 new reply")).toBeVisible();
  });
});
