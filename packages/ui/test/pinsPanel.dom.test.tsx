import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, Message, User } from "@slackoss/protocol";
import { describe, expect, it, vi } from "vitest";
import { PinsPanel } from "../src/components/MessageListPanel.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";

/**
 * The Pinned panel holds its own copy of a conversation's pinned messages. A
 * pinned message older than the history loaded is in nothing else the panel
 * can watch, so it asks again whenever that conversation changes (Q08).
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
const other: Channel = { ...design, id: "C_OTHER", name: "other" };

const pinned = (id: string, text: string, seq: number): Message =>
  ({
    id,
    channelId: design.id,
    userId: sam.id,
    text,
    seq,
    createdAt: Date.UTC(2026, 8, 20, 10, 0),
    editedAt: null,
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    reactions: [],
    files: [],
    pinned: true,
  }) as unknown as Message;

type Page = { messages: Message[]; nextCursor: string | null };

/** The panel on #design, with none of that conversation's history loaded. */
function renderPins(listPins: (cursor?: string) => Promise<Page>) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    workspaceId: "W1",
    users: { [sam.id]: sam },
    channels: { [design.id]: design, [other.id]: other },
    memberships: { [design.id]: 0, [other.id]: 0 },
    status: "online",
  });
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };
  const spy = vi
    .spyOn(client.api, "listPins")
    .mockImplementation((_channel, _signal, cursor) => listPins(cursor));
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <PinsPanel channelId={design.id} onClose={() => {}} onJump={() => {}} />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return { client, spy, panel: screen.getByRole("complementary", { name: "Pinned" }) };
}

describe("the Pinned panel", () => {
  it("drops a pinned message deleted outside the history it has loaded", async () => {
    let answer = [pinned("M_GONE", "Old pinned notes", 3), pinned("M_KEPT", "House rules", 2)];
    const { client, spy, panel } = renderPins(async () => ({ messages: answer, nextCursor: null }));
    await within(panel).findByText("Old pinned notes");
    expect(spy).toHaveBeenCalledTimes(1);

    // Another conversation changing is nothing to this panel.
    act(() => client.store.setState({ changedContent: { [other.id]: 9 } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spy).toHaveBeenCalledTimes(1);

    answer = [pinned("M_KEPT", "House rules", 2)];
    act(() => client.store.setState({ changedContent: { [other.id]: 9, [design.id]: 10 } }));
    await waitFor(() => expect(within(panel).queryByText("Old pinned notes")).toBeNull());
    expect(within(panel).getByText("House rules")).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps showing what it has while it asks again", async () => {
    let release = () => {};
    let asked = 0;
    const { client, spy, panel } = renderPins(() => {
      asked += 1;
      if (asked === 1)
        return Promise.resolve({ messages: [pinned("M1", "House rules", 2)], nextCursor: null });
      return new Promise<Page>((resolve) => {
        release = () =>
          resolve({ messages: [pinned("M1", "House rules, revised", 2)], nextCursor: null });
      });
    });
    await within(panel).findByText("House rules");

    act(() => client.store.setState({ changedContent: { [design.id]: 10 } }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    // Not blanked for the question: the list stays until the answer replaces it.
    expect(within(panel).getByText("House rules")).toBeTruthy();

    await act(async () => release());
    await within(panel).findByText("House rules, revised");
  });

  it("asks again for the page it is on", async () => {
    const user = userEvent.setup();
    const { client, spy, panel } = renderPins(async (cursor) =>
      cursor
        ? { messages: [pinned("M1", "Older pin", 1)], nextCursor: null }
        : { messages: [pinned("M5", "Newer pin", 5)], nextCursor: "M5" },
    );
    await within(panel).findByText("Newer pin");
    await user.click(within(panel).getByRole("button", { name: "Next page" }));
    await within(panel).findByText("Older pin");

    act(() => client.store.setState({ changedContent: { [design.id]: 10 } }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    expect(spy.mock.calls[2]![2]).toBe("M5");
    expect(panel).toHaveTextContent("Page 2");
  });
});
