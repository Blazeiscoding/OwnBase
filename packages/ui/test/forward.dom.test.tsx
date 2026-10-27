import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, ForwardReference, Message, User } from "@ownbase/protocol";
import { ClientContext, OpenMessageContext } from "../src/context.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { ForwardCard } from "../src/components/ForwardCard.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { accessibilityProblems } from "./accessibility.js";

/** Forwarding a message (E1): the menu's Forward, its dialog, and the card it sends. */
const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.split(" ")[0]!.toLowerCase(),
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const room = (id: string, type: Channel["type"], name: string): Channel => ({
  id,
  type,
  name,
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
});
const sam = person("U_SAM", "Sam Rivera");
const priya = person("U_PRIYA", "Priya Shah");
const general = room("C_GENERAL", "public", "general");
const design = room("C_DESIGN", "public", "design");
const secret = room("C_SECRET", "private", "secret");
const message = (over: Partial<Message> = {}): Message => ({
  id: "M_1",
  channelId: "C_GENERAL",
  userId: "U_PRIYA",
  text: "The launch plan is in the doc.",
  threadRootId: null,
  broadcast: false,
  seq: 7,
  createdAt: Date.UTC(2026, 9, 20, 9, 30),
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
  ...over,
});

function shown(item: Message, forwards = true) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam, U_PRIYA: priya },
    channels: { C_GENERAL: general, C_DESIGN: design, C_SECRET: secret },
    memberships: { C_GENERAL: 0, C_DESIGN: 0, C_SECRET: 0 },
    status: "online",
    forwards,
  });
  const send = vi.spyOn(client, "send").mockReturnValue(true);
  render(
    <ToastProvider>
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <OpenMessageContext.Provider value={vi.fn()}>
            <MessageItem message={item} compact={false} />
          </OpenMessageContext.Provider>
        </ClientContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );
  return { client, send, user: userEvent.setup() };
}

async function openForward(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Actions for message from Priya Shah" }));
  await user.click(
    within(screen.getByRole("menu", { name: "Actions for message from Priya Shah" })).getByRole(
      "menuitem",
      { name: "Forward…" },
    ),
  );
  return screen.findByRole("dialog", { name: "Forward message" });
}

describe("forwarding a message", () => {
  it("is offered only where the server forwards", async () => {
    const { user } = shown(message(), false);
    await user.click(screen.getByRole("button", { name: "Actions for message from Priya Shah" }));
    expect(
      within(screen.getByRole("menu", { name: "Actions for message from Priya Shah" })).queryByRole(
        "menuitem",
        { name: "Forward…" },
      ),
    ).toBeNull();
  });

  it("sends to a conversation chosen by typing, with words of its own", async () => {
    const { send, user } = shown(message());
    const dialog = await openForward(user);
    const field = within(dialog).getByRole("combobox", { name: "Forward to" });
    await user.type(field, "des");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["#design"]);
    await user.keyboard("{Enter}");
    expect(field).toHaveValue("#design");
    await user.type(
      within(dialog).getByRole("textbox", { name: "Add a message (optional)" }),
      "Have a look",
    );
    // The card shows what #design will see, with no link to open behind the dialog.
    expect(dialog).toHaveTextContent("Forwarded from #general");
    expect(dialog).toHaveTextContent("The launch plan is in the doc.");
    expect(within(dialog).queryByRole("button", { name: "View original" })).toBeNull();
    expect(await accessibilityProblems(dialog)).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Forward" }));
    expect(send).toHaveBeenCalledWith("C_DESIGN", "Have a look", {
      forward: expect.objectContaining({ id: "M_1", channelId: "C_GENERAL", hidden: false }),
    });
    expect(screen.queryByRole("dialog", { name: "Forward message" })).toBeNull();
    expect(await screen.findByText("Forwarded to #design.")).toBeVisible();
  });

  it("asks where before it sends anything", async () => {
    const { send, user } = shown(message());
    const dialog = await openForward(user);
    await user.click(within(dialog).getByRole("button", { name: "Forward" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Choose where to forward it.");
    expect(within(dialog).getByRole("combobox", { name: "Forward to" })).toHaveFocus();
    expect(send).not.toHaveBeenCalled();
  });

  it("previews a private message forwarded elsewhere as showing nothing of it", async () => {
    const { send, user } = shown(message({ channelId: "C_SECRET" }));
    const dialog = await openForward(user);
    await user.type(within(dialog).getByRole("combobox", { name: "Forward to" }), "design");
    await user.keyboard("{Enter}");
    expect(dialog).toHaveTextContent("Forwarded from a private conversation");
    expect(dialog).not.toHaveTextContent("The launch plan is in the doc.");
    await user.click(within(dialog).getByRole("button", { name: "Forward" }));
    expect(send).toHaveBeenCalledWith("C_DESIGN", "", {
      forward: expect.objectContaining({ id: "M_1", hidden: true, text: "" }),
    });
  });

  // Sam's message in #design, as a forward of it in #general shows it.
  const original: ForwardReference = {
    id: "M_0",
    channelId: "C_DESIGN",
    userId: "U_SAM",
    text: "Ship it Friday.",
    files: [],
    createdAt: Date.UTC(2026, 9, 20, 9, 0),
    deleted: false,
    hidden: false,
  };

  it("shows the card in the message, naming where it was said and who said it", () => {
    shown(message({ id: "M_2", text: "Have a look", forwardedFrom: original }));
    const row = screen.getByRole("article", { name: "Message from Priya Shah" });
    expect(within(row).getByText("Forwarded from #design")).toBeVisible();
    expect(within(row).getByText("Sam Rivera")).toBeVisible();
    expect(within(row).getByText("Ship it Friday.")).toBeVisible();
    expect(within(row).getByRole("button", { name: "View original" })).toBeVisible();
  });

  it("passes on what a forward with nothing of its own forwards", async () => {
    const { send, user } = shown(message({ id: "M_2", text: "", forwardedFrom: original }));
    const dialog = await openForward(user);
    await user.type(within(dialog).getByRole("combobox", { name: "Forward to" }), "secret");
    await user.keyboard("{Enter}");
    expect(dialog).toHaveTextContent("Forwarded from #design");
    expect(dialog).toHaveTextContent("Ship it Friday.");
    await user.click(within(dialog).getByRole("button", { name: "Forward" }));
    expect(send).toHaveBeenCalledWith("C_SECRET", "", {
      forward: expect.objectContaining({ id: "M_0", channelId: "C_DESIGN", hidden: false }),
    });
  });

  it.each([
    ["hidden here", { ...original, userId: "", text: "", createdAt: 0, hidden: true }],
    ["deleted", { ...original, userId: "", text: "", createdAt: 0, deleted: true }],
  ])("is not offered on a forward of nothing else whose original is %s", async (_, ref) => {
    const { user } = shown(message({ id: "M_2", text: "", forwardedFrom: ref }));
    await user.click(screen.getByRole("button", { name: "Actions for message from Priya Shah" }));
    const menu = screen.getByRole("menu", { name: "Actions for message from Priya Shah" });
    expect(within(menu).queryByRole("menuitem", { name: "Forward…" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Copy link to message" })).toBeVisible();
  });
});

describe("a forward's card", () => {
  const card = (
    forward: ForwardReference,
    channels: Record<string, Channel> = { C_GENERAL: general },
  ) => {
    const openMessage = vi.fn();
    render(
      // In the app a card sits in the conversation, inside its landmark.
      <OpenMessageContext.Provider value={openMessage}>
        <main>
          <ForwardCard
            forward={forward}
            users={{ U_SAM: sam, U_PRIYA: priya }}
            channels={channels}
            selfId="U_SAM"
          />
        </main>
      </OpenMessageContext.Provider>,
    );
    return { openMessage, user: userEvent.setup() };
  };
  const shownForward: ForwardReference = {
    id: "M_1",
    channelId: "C_GENERAL",
    userId: "U_PRIYA",
    text: "The launch plan is in the doc.",
    files: [],
    createdAt: Date.UTC(2026, 9, 20, 9, 30),
    deleted: false,
    hidden: false,
  };

  it("shows who wrote it, what it said, and opens it where it was said", async () => {
    const { openMessage, user } = card(shownForward);
    expect(screen.getByText("Forwarded from #general")).toBeVisible();
    expect(screen.getByText("Priya Shah")).toBeVisible();
    expect(screen.getByText("The launch plan is in the doc.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "View original" }));
    expect(openMessage).toHaveBeenCalledWith("C_GENERAL", "M_1");
    expect(await accessibilityProblems(document.body)).toEqual([]);
  });

  it("says only where a hidden one came from, and offers no link to someone outside it", () => {
    card({
      ...shownForward,
      userId: "",
      text: "",
      createdAt: 0,
      hidden: true,
      channelId: "C_SECRET",
    });
    expect(screen.getByText("Forwarded from a private conversation")).toBeVisible();
    expect(screen.getByText("Only people in that conversation can see it.")).toBeVisible();
    expect(screen.queryByText("The launch plan is in the doc.")).toBeNull();
    expect(screen.queryByRole("button", { name: "View original" })).toBeNull();
  });

  it("says when the original was deleted", () => {
    card({ ...shownForward, userId: "", text: "", createdAt: 0, deleted: true });
    expect(screen.getByText("The original message was deleted.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "View original" })).toBeNull();
  });
});
