import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmojiPicker } from "../src/components/EmojiPicker.js";
import { PlatformContext } from "../src/context.js";
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
      <EmojiPicker onPick={onPick} autoFocus />
    </PlatformContext.Provider>,
  );
  const again = () => {
    view.unmount();
    render(
      <PlatformContext.Provider value={platform}>
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
