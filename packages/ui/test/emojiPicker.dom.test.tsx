import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmojiPicker } from "../src/components/EmojiPicker.js";
import { createStore } from "zustand/vanilla";
import type { WorkspaceClient } from "@ownbase/client-core";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";

/** A picker on a device of its own, so what one test picks is not the next one's first row. */
function picker(saved: unknown = null) {
  const stored = { value: saved };
  const platform = {
    storage: {
      get: async () => stored.value,
      set: async (_key: string, value: unknown) => {
        stored.value = value;
      },
    },
  } as unknown as Platform;
  const onPick = vi.fn();
  const view = render(
    <PlatformContext.Provider value={platform}>
      {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the picker as the app opens it, into its search */}
      <EmojiPicker onPick={onPick} autoFocus />
    </PlatformContext.Provider>,
  );
  const again = () => {
    view.unmount();
    render(
      <PlatformContext.Provider value={platform}>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the picker as the app opens it, into its search */}
        <EmojiPicker onPick={onPick} autoFocus />
      </PlatformContext.Provider>,
    );
  };
  return {
    onPick,
    again,
    user: userEvent.setup(),
    search: () => screen.getByRole("combobox", { name: "Search emoji" }),
  };
}

/** The option the search box points the screen reader at. */
const pointedAt = (box: HTMLElement) =>
  document.getElementById(box.getAttribute("aria-activedescendant") ?? "");

describe("the emoji picker", () => {
  it("offers Slack's sections, and draws a far one only once it is asked for", async () => {
    const { user } = picker();
    const marks = screen.getByRole("group", { name: "Emoji categories" });
    expect(
      within(marks)
        .getAllByRole("button")
        .map((mark) => mark.getAttribute("aria-label")),
    ).toEqual([
      "Frequently used",
      "Smileys & People",
      "Animals & Nature",
      "Food & Drink",
      "Activity",
      "Travel & Places",
      "Objects",
      "Symbols",
      "Flags",
    ]);
    expect(screen.getByRole("group", { name: "Smileys & People" })).toBeInTheDocument();
    // Held at its height until it comes near, so opening does not make every emoji.
    expect(screen.queryByRole("option", { name: "India Flag" })).not.toBeInTheDocument();
    await user.click(within(marks).getByRole("button", { name: "Flags" }));
    expect(screen.getByRole("option", { name: "India Flag" })).toBeInTheDocument();
    expect(within(marks).getByRole("button", { name: "Flags" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(pointedAt(screen.getByRole("combobox", { name: "Search emoji" }))).toHaveAccessibleName(
      "Chequered Flag",
    );
  });

  it("names the emoji pointed at, with its shortcode, below the grid", async () => {
    const { user } = picker();
    await user.hover(screen.getAllByRole("option", { name: "Party Popper" })[0]!);
    expect(screen.getByText("Party Popper", { selector: "span" })).toBeVisible();
    expect(screen.getByText(":tada:")).toBeVisible();
  });

  it("moves a row at a time with the arrows, from one section into the next", async () => {
    const { user, search } = picker();
    expect(search()).toHaveFocus();
    const frequent = within(screen.getByRole("group", { name: "Frequently used" })).getAllByRole(
      "option",
    );
    expect(pointedAt(search())).toBe(frequent[0]);
    await user.keyboard("{ArrowDown}");
    expect(pointedAt(search())).toBe(frequent[9]);
    // Below the last row of one section is the first of the next.
    await user.keyboard("{ArrowDown}");
    expect(pointedAt(search())).toHaveAccessibleName("Grinning Face");
    await user.keyboard("{ArrowRight}");
    expect(pointedAt(search())).toHaveAccessibleName("Grinning Face with Big Eyes");
    await user.keyboard("{ArrowUp}");
    expect(pointedAt(search())).toBe(frequent[10]);
  });

  it("picks with Enter what a search found first", async () => {
    const { user, search, onPick } = picker();
    await user.type(search(), "party{Enter}");
    expect(onPick).toHaveBeenCalledWith("🎉");
  });

  it("draws and writes emoji in the skin tone chosen, and keeps it", async () => {
    const { user, search, onPick, again } = picker();
    await user.click(screen.getByRole("button", { name: "Skin tone: Default" }));
    const tones = screen.getByRole("radiogroup", { name: "Skin tone" });
    expect(within(tones).getByRole("radio", { name: "Default" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(within(tones).getByRole("radio", { name: "Dark" }));
    expect(search()).toHaveFocus();
    expect(screen.getAllByRole("option", { name: "Thumbs Up" })[0]).toHaveTextContent("👍🏿");
    await user.type(search(), "wave{Enter}");
    expect(onPick).toHaveBeenCalledWith("👋🏿");
    again();
    expect(await screen.findByRole("button", { name: "Skin tone: Dark" })).toBeInTheDocument();
  });

  it("puts what was picked first in the first row next time", async () => {
    const { user, search, again } = picker();
    await user.type(search(), "taco{Enter}");
    again();
    const frequent = within(
      await screen.findByRole("group", { name: "Frequently used" }),
    ).getAllByRole("option");
    expect(frequent[0]).toHaveAccessibleName("Taco");
  });

  it("says when nothing matches", async () => {
    const { user, search } = picker();
    await user.type(search(), "zzzz");
    expect(screen.getByRole("status")).toHaveTextContent("No emoji matched. Try another word.");
    expect(search()).not.toHaveAttribute("aria-activedescendant");
  });
});

describe("the emoji picker in a workspace with its own emoji (J12)", () => {
  function inWorkspace(role: "member" | "guest", adminsOnly = false) {
    const platform = {
      storage: { get: async () => null, set: async () => undefined },
    } as unknown as Platform;
    const client = {
      store: createStore(() => ({
        self: { id: "U1", role },
        emojiAddingAdminsOnly: adminsOnly,
        customEmoji: {
          "party-parrot": { id: "E1", name: "party-parrot", createdBy: "U1" },
          "ship-it": { id: "E2", name: "ship-it", createdBy: "U2" },
        },
      })),
      emojiPictures: { peek: () => "blob:emoji", load: async () => "blob:emoji" },
    } as unknown as WorkspaceClient;
    const onPick = vi.fn();
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the picker as the app opens it, into its search */}
          <EmojiPicker onPick={onPick} autoFocus />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    return { onPick, user: userEvent.setup() };
  }

  it("lists them under Custom, after the ones used most, and picks one as its :name:", async () => {
    const { onPick, user } = inWorkspace("member");
    const marks = screen.getByRole("group", { name: "Emoji categories" });
    const labels = within(marks)
      .getAllByRole("button")
      .map((mark) => mark.getAttribute("aria-label"));
    expect(labels.slice(0, 3)).toEqual(["Frequently used", "Custom", "Smileys & People"]);
    expect(labels.at(-1)).toBe("Add emoji");
    const custom = screen.getByRole("group", { name: "Custom" });
    expect(
      within(custom)
        .getAllByRole("option")
        .map((option) => option.getAttribute("aria-label")),
    ).toEqual([":party-parrot:", ":ship-it:"]);
    await user.click(within(custom).getByRole("option", { name: ":ship-it:" }));
    expect(onPick).toHaveBeenCalledWith(":ship-it:");
  });

  it("finds them by search, first", async () => {
    const { onPick, user } = inWorkspace("member");
    await user.type(screen.getByRole("combobox", { name: "Search emoji" }), "parrot");
    const options = screen.getAllByRole("option");
    expect(options[0]?.getAttribute("aria-label")).toBe(":party-parrot:");
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith(":party-parrot:");
  });

  it("offers Add emoji only to those who may add", () => {
    inWorkspace("guest");
    expect(screen.queryByRole("button", { name: "Add emoji" })).toBeNull();
  });

  it("keeps Add emoji from members when admins keep adding to themselves", () => {
    inWorkspace("member", true);
    expect(screen.queryByRole("button", { name: "Add emoji" })).toBeNull();
  });
});
