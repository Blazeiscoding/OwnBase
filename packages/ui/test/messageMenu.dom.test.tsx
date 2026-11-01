import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { accessibilityProblems } from "./accessibility.js";

const person = (id: string, displayName: string, role: User["role"] = "member"): User => ({
  id,
  handle: displayName.split(" ")[0]!.toLowerCase(),
  displayName,
  role,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});

const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
};

const message: Message = {
  id: "M_1",
  channelId: "C_GENERAL",
  userId: "U_SAM",
  text: "Standup notes are in the doc.",
  threadRootId: null,
  broadcast: false,
  seq: 7,
  createdAt: 0,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
};

/**
 * One message over a client that never connects. The menu is what a
 * touchscreen shows in place of the hover toolbar; jsdom applies no styles,
 * so both are in the document here.
 */
function messageFrom(author: User, self: User) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self,
    users: { [author.id]: author, [self.id]: self },
    channels: { C_GENERAL: general },
    status: "online",
  });
  const react = vi.spyOn(client, "toggleReaction").mockResolvedValue(true);
  const onOpenThread = vi.fn();
  render(
    <ToastProvider>
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <MessageItem
            message={{ ...message, userId: author.id }}
            compact={false}
            onOpenThread={onOpenThread}
          />
        </ClientContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );
  return { client, react, onOpenThread, user: userEvent.setup() };
}

const sam = person("U_SAM", "Sam Rivera");
const priya = person("U_PRIYA", "Priya Shah");

async function openMenu(user: ReturnType<typeof userEvent.setup>, author: string) {
  await user.click(screen.getByRole("button", { name: `Actions for message from ${author}` }));
  return screen.getByRole("menu", { name: `Actions for message from ${author}` });
}

describe("a message's menu", () => {
  it("names every action the toolbar offers, and only those this person may take", async () => {
    const { user } = messageFrom(sam, sam);
    const menu = await openMenu(user, "Sam Rivera");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Reply in thread",
      "Add a reaction…",
      "Copy text",
      "Copy link to message",
      "Save for later",
      "Mark unread from this message",
      "Pin to channel",
      "Edit message",
      "Delete message",
    ]);
    expect(await accessibilityProblems(menu)).toEqual([]);
  });

  it("leaves out editing and deleting on someone else's message", async () => {
    const { user } = messageFrom(priya, sam);
    const menu = await openMenu(user, "Priya Shah");
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(items).not.toContain("Edit message");
    expect(items).not.toContain("Delete message");
  });

  it("does what each item names", async () => {
    const { client, user, onOpenThread } = messageFrom(sam, sam);
    const pin = vi.spyOn(client, "togglePin").mockResolvedValue(true);
    const save = vi.spyOn(client, "toggleSaved").mockResolvedValue(true);

    await user.click(within(await openMenu(user, "Sam Rivera")).getByText("Reply in thread"));
    expect(onOpenThread).toHaveBeenCalledWith("M_1");
    await user.click(within(await openMenu(user, "Sam Rivera")).getByText("Pin to channel"));
    expect(pin).toHaveBeenCalledOnce();
    await user.click(within(await openMenu(user, "Sam Rivera")).getByText("Save for later"));
    expect(save).toHaveBeenCalledWith("M_1", true);
    // Editing opens in place, with the cursor in the editor, once it has loaded.
    await user.click(within(await openMenu(user, "Sam Rivera")).getByText("Edit message"));
    expect(await screen.findByRole("textbox", { name: "Edit message" })).toHaveFocus();
  });

  it("copies the link and says so, since the menu has closed by then", async () => {
    const { user } = messageFrom(sam, sam);
    await user.click(within(await openMenu(user, "Sam Rivera")).getByText("Copy link to message"));
    expect(await screen.findByText("Link copied.")).toBeVisible();
    expect(await navigator.clipboard.readText()).toBe("http://127.0.0.1:9/#/c/C_GENERAL/m/M_1");
  });

  it("copies the words as shown, for a phone where holding the message opens this menu", async () => {
    const { user } = messageFrom(sam, sam);
    await user.click(within(await openMenu(user, "Sam Rivera")).getByText("Copy text"));
    expect(await screen.findByText("Text copied.")).toBeVisible();
    expect(await navigator.clipboard.readText()).toBe("Standup notes are in the doc.");
  });
});

describe("a message's toolbar", () => {
  it("marks every button whose icon can move, so pointing at it plays the motion", () => {
    messageFrom(sam, sam);
    const toolbar = screen.getByRole("button", { name: "Reply in thread" }).parentElement!;
    const icons = [...toolbar.querySelectorAll<SVGElement>("svg[data-icon]")];
    expect(icons.map((icon) => icon.dataset.icon)).toEqual([
      "smile",
      "thread",
      "bookmark",
      "edit",
      "dots",
    ]);
    for (const icon of icons) expect(icon.closest("button")).toHaveClass("icon-live");
  });

  it("gives a saved message's bookmark the accent colour and no other", () => {
    const { client } = messageFrom(sam, sam);
    const colours = (name: string) =>
      screen
        .getByRole("button", { name })
        .className.split(" ")
        .filter((cls) => /(^|:)text-[a-z]/.test(cls));
    expect(colours("Save for later")).toEqual(["text-ink-dim", "hover:text-ink"]);
    act(() => client.store.setState({ saved: { M_1: true } }));
    // Two text colours on one element leave the choice to the stylesheet's
    // order, which once left a saved message's bookmark looking unsaved.
    expect(colours("Remove from Saved")).toEqual(["text-copper"]);
  });
});

describe("adding a reaction", () => {
  it("finds any emoji from the menu, and reacts with it", async () => {
    const { react, user } = messageFrom(sam, sam);
    await user.click(within(await openMenu(user, "Sam Rivera")).getByText("Add a reaction…"));
    // The picker loads on first use.
    const picker = await screen.findByRole("dialog", { name: "Add a reaction" });
    expect(await accessibilityProblems(picker)).toEqual([]);
    await user.type(within(picker).getByRole("combobox", { name: "Search emoji" }), "rocket");
    await user.click(within(picker).getByRole("option", { name: "Rocket" }));
    expect(react).toHaveBeenCalledWith(expect.objectContaining({ id: "M_1" }), "🚀");
    expect(screen.queryByRole("dialog", { name: "Add a reaction" })).not.toBeInTheDocument();
  });

  it("opens from the toolbar too, and says when nothing matches", async () => {
    const { react, user } = messageFrom(sam, sam);
    await user.click(screen.getByRole("button", { name: "Add a reaction" }));
    const picker = await screen.findByRole("dialog", { name: "Add a reaction" });
    const search = within(picker).getByRole("combobox", { name: "Search emoji" });
    expect(search).toHaveFocus();
    await user.type(search, "zzzz");
    expect(within(picker).getByRole("status")).toHaveTextContent("No emoji matched");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Add a reaction" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a reaction" })).toHaveFocus();
    expect(react).not.toHaveBeenCalled();
  });
});

describe("a message's reactions", () => {
  it("are read as who reacted, and say whether you did", async () => {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({
      self: sam,
      users: { [sam.id]: sam, [priya.id]: priya },
      channels: { C_GENERAL: general },
      status: "online",
    });
    const react = vi.spyOn(client, "toggleReaction").mockResolvedValue(true);
    render(
      <ToastProvider>
        <ConfirmProvider>
          <ClientContext.Provider value={client}>
            <MessageItem
              message={{
                ...message,
                reactions: [
                  { emoji: "👍", userIds: [sam.id, priya.id] },
                  { emoji: "🎉", userIds: [priya.id] },
                ],
              }}
              compact={false}
            />
          </ClientContext.Provider>
        </ConfirmProvider>
      </ToastProvider>,
    );
    const group = screen.getByRole("group", { name: "Reactions" });
    const mine = within(group).getByRole("button", {
      name: "👍 2 reactions, from Priya Shah and you",
    });
    expect(mine).toHaveAttribute("aria-pressed", "true");
    expect(
      within(group).getByRole("button", { name: "🎉 1 reaction, from Priya Shah" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(await accessibilityProblems(group)).toEqual([]);
    await userEvent.setup().click(mine);
    expect(react).toHaveBeenCalledWith(expect.objectContaining({ id: "M_1" }), "👍");
  });
});

describe("one key per action on a focused message", () => {
  it("edits, opens the thread, saves, pins, reacts and deletes your own message", async () => {
    const { client, onOpenThread, user } = messageFrom(sam, sam);
    const pin = vi.spyOn(client, "togglePin").mockResolvedValue(true);
    const save = vi.spyOn(client, "toggleSaved").mockResolvedValue(true);
    const unread = vi.spyOn(client, "markUnread").mockImplementation(() => {});
    const remove = vi.spyOn(client.api, "deleteMessage").mockResolvedValue({ ok: true } as never);
    const row = screen.getByRole("article", { name: "Message from Sam Rivera" });
    act(() => row.focus());

    await user.keyboard("t");
    expect(onOpenThread).toHaveBeenCalledWith("M_1");
    await user.keyboard("a");
    expect(save).toHaveBeenCalledWith("M_1", true);
    await user.keyboard("p");
    expect(pin).toHaveBeenCalled();
    await user.keyboard("u");
    expect(unread).toHaveBeenCalledWith("C_GENERAL", 7);
    // With a modifier the key is someone else's: Ctrl+A, a browser shortcut.
    save.mockClear();
    await user.keyboard("{Control>}a{/Control}");
    expect(save).not.toHaveBeenCalled();

    await user.keyboard("r");
    expect(await screen.findByRole("dialog", { name: /reaction/i })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    act(() => row.focus());
    await user.keyboard("{Delete}");
    const ask = await screen.findByRole("dialog", { name: "Delete this message?" });
    await user.click(within(ask).getByRole("button", { name: "Delete" }));
    expect(remove).toHaveBeenCalledWith("M_1");

    act(() => row.focus());
    await user.keyboard("e");
    expect(screen.getByRole("textbox", { name: /edit/i })).toHaveFocus();
  });

  it("does not edit or delete someone else's message", async () => {
    const { client, user } = messageFrom(priya, sam);
    const remove = vi.spyOn(client.api, "deleteMessage");
    act(() => screen.getByRole("article", { name: "Message from Priya Shah" }).focus());
    await user.keyboard("e{Delete}");
    expect(screen.queryByRole("textbox", { name: /edit/i })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
});
