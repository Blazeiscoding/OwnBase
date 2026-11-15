import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, ServerToClient, User } from "@ownbase/protocol";
import { ClientContext, OpenMessageContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { MessageTimeline } from "../src/components/MessageTimeline.js";
import { ThreadPanel } from "../src/components/ThreadPanel.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { requestEdit } from "../src/lib/editRequest.js";
import { held } from "./heldMessages.js";

/** Someone else deletes a message while it is being edited here. */
const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.split(" ")[0]!.toLowerCase(),
  displayName,
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const sam = person("U_SAM", "Sam Rivera");
const priya = person("U_PRIYA", "Priya Shah");
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
const message = (id: string, userId: string, text: string, minute: number): Message => ({
  id,
  channelId: general.id,
  userId,
  text,
  threadRootId: null,
  broadcast: false,
  seq: minute,
  createdAt: Date.UTC(2026, 9, 21, 9, minute),
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  previews: [],
  actions: [],
});
const before = message("M_BEFORE", priya.id, "Standup moved to ten", 1);
const mine = message("M_MINE", sam.id, "I can take the release", 2);
const after = message("M_AFTER", priya.id, "Thanks both", 3);
const editKey = `${general.id}:edit:${mine.id}`;

const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
});

function open() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [priya.id]: priya },
    channels: { [general.id]: general },
    memberships: { [general.id]: 9 },
    status: "online",
    ...held({ timelines: { [general.id]: { items: [before, mine, after] } } }),
  });
  vi.spyOn(client.api, "listMessages").mockResolvedValue({
    messages: [before, mine, after],
    readThroughSeq: 3,
  } as never);
  render(
    <PlatformContext.Provider value={platform}>
      <ToastProvider>
        <ConfirmProvider>
          <ClientContext.Provider value={client}>
            <MessageTimeline
              channelId={general.id}
              onOpenThread={vi.fn()}
              onChannelClick={vi.fn()}
              onOpenProfile={vi.fn()}
            />
          </ClientContext.Provider>
        </ConfirmProvider>
      </ToastProvider>
    </PlatformContext.Provider>,
  );
  const deleteMine = () =>
    act(() =>
      (client as unknown as { handleServerMessage(m: ServerToClient): void }).handleServerMessage({
        type: "event",
        envelope: {
          seq: 10,
          event: {
            type: "message.deleted",
            messageId: mine.id,
            channelId: general.id,
            threadRootId: null,
          },
        },
      }),
    );
  return { client, deleteMine, user: userEvent.setup() };
}

describe("a message deleted while it is being edited", () => {
  it("keeps the edit where the message was, to copy or discard", async () => {
    const { client, deleteMine, user } = open();
    act(() => requestEdit(mine.id));
    const box = await screen.findByRole("textbox", { name: "Edit message" });
    await user.clear(box);
    await user.type(box, "I can take the release on Friday");

    deleteMine();
    expect(screen.queryByRole("textbox", { name: "Edit message" })).toBeNull();
    const kept = screen.getByRole("group", { name: "Your unsaved edit" });
    expect(kept).toHaveTextContent("This message was deleted.");
    expect(kept).toHaveTextContent("I can take the release on Friday");
    // Between the messages it sat between.
    const history = screen.getByLabelText("Message history");
    const text = history.textContent ?? "";
    expect(text.indexOf("Standup moved to ten")).toBeLessThan(
      text.indexOf("This message was deleted."),
    );
    expect(text.indexOf("This message was deleted.")).toBeLessThan(text.indexOf("Thanks both"));

    await user.click(within(kept).getByRole("button", { name: "Copy text" }));
    expect(await navigator.clipboard.readText()).toBe("I can take the release on Friday");
    expect(await screen.findByText("Edit copied.")).toBeTruthy();

    await user.click(within(kept).getByRole("button", { name: "Discard" }));
    expect(client.state.drafts[editKey]).toBeUndefined();
    expect(screen.queryByRole("group", { name: "Your unsaved edit" })).toBeNull();
  });

  it("shows nothing when the editor was open with nothing changed", async () => {
    const { deleteMine } = open();
    act(() => requestEdit(mine.id));
    await screen.findByRole("textbox", { name: "Edit message" });
    deleteMine();
    expect(screen.queryByRole("group", { name: "Your unsaved edit" })).toBeNull();
    expect(screen.queryByText("This message was deleted.")).toBeNull();
  });
});

describe("a reply deleted while it is being edited", () => {
  it("keeps the edit in the thread where the reply was", async () => {
    const root = message("M_ROOT", priya.id, "Who is taking the release?", 0);
    const reply = { ...mine, threadRootId: root.id };
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    clients.push(client);
    client.store.setState({
      self: sam,
      users: { [sam.id]: sam, [priya.id]: priya },
      channels: { [general.id]: general },
      memberships: { [general.id]: 9 },
      status: "online",
      ...held({
        threadPages: {
          [root.id]: {
            channelId: general.id,
            root: { ...root, replyCount: 1 },
            hasMoreOlder: false,
            hasMoreNewer: false,
            loading: false,
            loaded: true,
            error: null,
          },
        },
        threads: { [root.id]: [reply] },
      }),
    });
    vi.spyOn(client, "loadThread").mockResolvedValue(undefined);
    render(
      <PlatformContext.Provider value={platform}>
        <ToastProvider>
          <ConfirmProvider>
            <ClientContext.Provider value={client}>
              <OpenMessageContext.Provider value={vi.fn()}>
                <ThreadPanel
                  channelId={general.id}
                  rootId={root.id}
                  onClose={() => {}}
                  onChannelClick={() => {}}
                  onOpenProfile={() => {}}
                />
              </OpenMessageContext.Provider>
            </ClientContext.Provider>
          </ConfirmProvider>
        </ToastProvider>
      </PlatformContext.Provider>,
    );
    const user = userEvent.setup();
    act(() => requestEdit(reply.id));
    const box = await screen.findByRole("textbox", { name: "Edit message" });
    await user.type(box, " on Friday");
    act(() =>
      (client as unknown as { handleServerMessage(m: ServerToClient): void }).handleServerMessage({
        type: "event",
        envelope: {
          seq: 10,
          event: {
            type: "message.deleted",
            messageId: reply.id,
            channelId: general.id,
            threadRootId: root.id,
          },
        },
      }),
    );
    expect(screen.queryByRole("textbox", { name: "Edit message" })).toBeNull();
    expect(screen.getByRole("group", { name: "Your unsaved edit" })).toHaveTextContent(
      "I can take the release on Friday",
    );
  });
});
