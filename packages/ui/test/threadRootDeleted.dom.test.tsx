import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, ServerToClient, User } from "@ownbase/protocol";
import { ClientContext, OpenMessageContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { ThreadPanel } from "../src/components/ThreadPanel.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { held } from "./heldMessages.js";

/** A thread whose first message is deleted while a reply to it is being written. */
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
const root: Message = {
  id: "M_ROOT",
  channelId: general.id,
  userId: priya.id,
  text: "Who is taking the release?",
  threadRootId: null,
  broadcast: false,
  seq: 7,
  createdAt: Date.UTC(2026, 9, 21, 9, 30),
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  previews: [],
  actions: [],
};
const draftKey = `${general.id}:${root.id}`;

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

function open(draft?: string) {
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
          root,
          hasMoreOlder: false,
          hasMoreNewer: false,
          loading: false,
          loaded: true,
          error: null,
        },
      },
      threads: { [root.id]: [] },
    }),
    drafts: draft ? { [draftKey]: draft } : {},
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
  const deleteRoot = () =>
    act(() =>
      (client as unknown as { handleServerMessage(m: ServerToClient): void }).handleServerMessage({
        type: "event",
        envelope: {
          seq: 10,
          event: {
            type: "message.deleted",
            messageId: root.id,
            channelId: general.id,
            threadRootId: null,
          },
        },
      }),
    );
  return { client, deleteRoot, user: userEvent.setup() };
}

describe("a thread's first message deleted under a reply being written", () => {
  it("keeps the reply in sight, to copy or delete, where the reply box was", async () => {
    const { client, deleteRoot, user } = open("I can take it <@U_PRIYA>");
    expect(screen.getByRole("textbox", { name: /Reply/ })).toHaveValue("I can take it @Priya Shah");
    deleteRoot();
    expect(screen.getByText("The original message was deleted.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /Reply/ })).toBeNull();
    const kept = screen.getByRole("group", { name: "Your unsent reply" });
    expect(kept).toHaveTextContent("Your reply was not sent.");
    expect(kept).toHaveTextContent("I can take it @Priya Shah");
    // Still a draft until it is dealt with, so Drafts lists it too.
    expect(client.state.drafts[draftKey]).toBe("I can take it <@U_PRIYA>");

    await user.click(within(kept).getByRole("button", { name: "Copy text" }));
    expect(await navigator.clipboard.readText()).toBe("I can take it @Priya Shah");
    expect(await screen.findByText("Reply copied.")).toBeTruthy();

    await user.click(within(kept).getByRole("button", { name: "Delete draft" }));
    expect(client.state.drafts[draftKey]).toBeUndefined();
    expect(screen.queryByRole("group", { name: "Your unsent reply" })).toBeNull();
  });

  it("shows nothing more when no reply was being written", () => {
    const { deleteRoot } = open();
    deleteRoot();
    expect(screen.getByText("The original message was deleted.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Your unsent reply" })).toBeNull();
  });
});
