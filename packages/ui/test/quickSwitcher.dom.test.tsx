import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { accessibilityProblems } from "./accessibility.js";
import { QuickSwitcher, type PaletteCommand } from "../src/components/QuickSwitcher.js";

const person = (id: string, handle: string, displayName: string, deactivated = false): User => ({
  id,
  handle,
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated,
  dndUntil: null,
  createdAt: 0,
});

const room = (
  id: string,
  type: Channel["type"],
  name: string,
  memberIds: string[] = [],
): Channel => ({
  id,
  type,
  name,
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
  memberIds,
});

/** A workspace client that never connects, holding the replica a test gives it. */
function switcherWith(
  extra: Partial<Pick<Parameters<typeof QuickSwitcher>[0], "commands" | "onSearch">> = {},
) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const sam = person("U_SAM", "sam", "Sam Rivera");
  client.store.setState({
    self: sam,
    users: {
      U_SAM: sam,
      U_ALEX: person("U_ALEX", "alex", "Alex Chen"),
      U_PRIYA: person("U_PRIYA", "priya", "Priya Natarajan"),
      U_DANA: person("U_DANA", "dana", "Dana Old", true),
    },
    channels: {
      C_DESIGN: room("C_DESIGN", "public", "design"),
      C_LEADS: room("C_LEADS", "private", "leads"),
      D_ALEX: room("D_ALEX", "dm", "", ["U_SAM", "U_ALEX"]),
      D_DANA: room("D_DANA", "dm", "", ["U_SAM", "U_DANA"]),
      G_TRIO: room("G_TRIO", "group_dm", "", ["U_SAM", "U_ALEX", "U_PRIYA"]),
    },
  });
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const openDm = vi.spyOn(client, "openDm").mockResolvedValue(room("D_PRIYA", "dm", ""));
  render(
    <ClientContext.Provider value={client}>
      <QuickSwitcher onClose={onClose} onOpen={onOpen} {...extra} />
    </ClientContext.Provider>,
  );
  const options = () =>
    within(screen.getByRole("dialog", { name: "Jump to" }))
      .getAllByRole("option")
      .map((item) => item.textContent);
  return { client, onOpen, onClose, openDm, options };
}

describe("jumping to a conversation", () => {
  it("is a combobox whose highlighted match a screen reader follows", async () => {
    const user = userEvent.setup();
    switcherWith();
    const box = screen.getByRole("combobox", { name: "Channel or person" });
    const list = screen.getByRole("listbox", { name: "Matches" });
    expect(box).toHaveAttribute("aria-controls", list.id);
    expect(box).toHaveAttribute("aria-expanded", "true");
    const first = within(list).getByRole("option", { name: "design, channel" });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(box).toHaveAttribute("aria-activedescendant", first.id);
    await user.keyboard("{ArrowDown}");
    const second = within(list).getByRole("option", { name: "leads, private channel" });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(box).toHaveAttribute("aria-activedescendant", second.id);
    expect(box).toHaveFocus();
    await user.type(box, "nothing like this");
    expect(box).toHaveAttribute("aria-expanded", "false");
    expect(box).not.toHaveAttribute("aria-activedescendant");
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);
  });

  it("picks out what was typed in each match, whatever its case or sign", async () => {
    const user = userEvent.setup();
    switcherWith();
    const box = screen.getByRole("combobox", { name: "Channel or person" });
    const picked = () =>
      within(screen.getByRole("listbox", { name: "Matches" }))
        .getAllByRole("option")
        .map((option) => option.querySelector("mark")?.textContent ?? null);
    expect(picked().every((mark) => mark === null)).toBe(true);
    await user.type(box, "#DES");
    expect(picked()).toEqual(["des"]);
    await user.clear(box);
    await user.type(box, "@chen");
    // The group conversation with Alex and Alex directly, each with the name picked out.
    expect(picked()).toEqual(["Chen", "Chen"]);
    expect(screen.getByRole("option", { name: "Alex Chen, person" })).toHaveTextContent(
      "Alex Chen",
    );
  });

  it("lists a person once, whether or not you already talk to them directly", () => {
    const { options } = switcherWith();
    expect(options()).toEqual([
      "#design",
      "leads",
      "@Dana Old",
      "@Alex Chen, Priya Natarajan",
      "@Alex Chen",
      "@Priya Natarajan",
    ]);
  });

  it("opens an existing direct conversation without asking the server for it", async () => {
    const user = userEvent.setup();
    const { onOpen, openDm } = switcherWith();
    await user.click(screen.getByRole("option", { name: "Alex Chen, person" }));
    expect(onOpen).toHaveBeenCalledWith("D_ALEX");
    expect(openDm).not.toHaveBeenCalled();
  });

  it("starts a direct conversation with someone you have not talked to yet", async () => {
    const user = userEvent.setup();
    const { onOpen, openDm } = switcherWith();
    await user.click(screen.getByRole("option", { name: "Priya Natarajan, person" }));
    expect(openDm).toHaveBeenCalledWith(["U_PRIYA"]);
    expect(onOpen).toHaveBeenCalledWith("D_PRIYA");
  });

  it("finds a channel or a person written the way they are written in messages", async () => {
    const user = userEvent.setup();
    const { options } = switcherWith();
    await user.type(screen.getByPlaceholderText("Channel or person"), "#des");
    expect(options()).toEqual(["#design"]);
    await user.clear(screen.getByPlaceholderText("Channel or person"));
    await user.type(screen.getByPlaceholderText("Channel or person"), "@pri");
    expect(options()).toEqual(["@Alex Chen, Priya Natarajan", "@Priya Natarajan"]);
  });

  it("says when nothing matches, and arrow keys there leave a later match choosable", async () => {
    const user = userEvent.setup();
    const { client, onOpen, options } = switcherWith();
    const input = screen.getByPlaceholderText("Channel or person");
    await user.type(input, "news");
    expect(screen.getByRole("status")).toHaveTextContent("No channel or person matches “news”.");
    await user.keyboard("{ArrowDown}{ArrowUp}");
    // A channel created elsewhere arrives while the box still says "news".
    act(() =>
      client.store.setState((s) => ({
        channels: { ...s.channels, C_NEWS: room("C_NEWS", "public", "newsroom") },
      })),
    );
    expect(options()).toEqual(["#newsroom"]);
    expect(screen.getByRole("status")).toHaveTextContent("");
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith("C_NEWS");
  });

  it("keeps what was typed when a new conversation cannot start, and tries again", async () => {
    const user = userEvent.setup();
    const { onOpen, openDm } = switcherWith();
    openDm.mockRejectedValueOnce(new Error("offline"));
    const input = screen.getByPlaceholderText("Channel or person");
    await user.type(input, "pri");
    await user.click(screen.getByRole("option", { name: "Priya Natarajan, person" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not open a conversation with Priya Natarajan.",
    );
    expect(input).toHaveValue("pri");
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(openDm).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledWith("D_PRIYA");
  });
});

describe("the palette's actions", () => {
  const actions = () => {
    const ran: string[] = [];
    const commands: PaletteCommand[] = [
      {
        id: "new-channel",
        label: "Create a channel",
        icon: "plus",
        run: () => ran.push("channel"),
      },
      {
        id: "theme",
        label: "Switch to the White theme",
        icon: "sun",
        keywords: "dark light appearance",
        run: () => ran.push("theme"),
      },
    ];
    return { ran, commands };
  };

  it("lists places first, then actions, and runs one after closing", async () => {
    const user = userEvent.setup();
    const { ran, commands } = actions();
    const { onClose, options } = switcherWith({ commands, onSearch: vi.fn() });
    // Nothing typed: places, then the actions. No search row without words.
    expect(options().slice(-2)).toEqual(["Create a channel", "Switch to the White theme"]);
    expect(options()[0]).toBe("#design");
    await user.type(screen.getByRole("combobox"), "light");
    expect(screen.getByRole("option", { name: "Switch to the White theme, action" })).toBeVisible();
    await user.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalled();
    expect(ran).toEqual(["theme"]);
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);
  });

  it("ends with searching messages for what was typed", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    const { commands } = actions();
    const { options } = switcherWith({ commands, onSearch });
    await user.type(screen.getByRole("combobox"), "release notes");
    expect(options().at(-1)).toBe("Search messages for “release notes”");
    await user.click(screen.getByRole("option", { name: "Search messages for “release notes”" }));
    expect(onSearch).toHaveBeenCalledWith("release notes");
  });
});
