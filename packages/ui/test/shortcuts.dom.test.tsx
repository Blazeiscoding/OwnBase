import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { ShortcutsDialog } from "../src/components/ShortcutsDialog.js";

/** The shortcut sheet on a device whose saved Enter preference is `enterSends`. */
function sheet(enterSends: boolean) {
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(name: string) =>
        (name === "composer-preferences" ? { enterSends } : null) as T | null,
      set: async () => {},
    },
    notify: () => {},
  };
  render(
    <PlatformContext.Provider value={platform}>
      <ShortcutsDialog onClose={() => {}} />
    </PlatformContext.Provider>,
  );
  const writing = screen.getByRole("heading", { name: "Writing" }).closest("section")!;
  /** Each row as "keys → what it does". */
  const rows = () =>
    within(writing)
      .getAllByRole("listitem")
      .map((row) => {
        const keys = [...row.querySelectorAll("kbd")].map((k) => k.textContent).join(" ");
        return `${keys} → ${row.firstElementChild?.textContent}`;
      });
  return { rows, writing };
}

describe("the keyboard shortcut sheet", () => {
  it("says Enter sends when that is the preference", async () => {
    const { rows, writing } = sheet(true);
    await waitFor(() => expect(rows()).toContain("Enter → Send"));
    expect(rows()).toContain("Shift Enter → New line");
    expect(rows()).toContain("Ctrl Enter → Send without choosing a mention");
    expect(writing).toHaveTextContent("Choose what Enter does in Account settings.");
  });

  it("says Enter starts a new line when that is the preference", async () => {
    const { rows } = sheet(false);
    await waitFor(() => expect(rows()).toContain("Ctrl Enter → Send"));
    expect(rows()).toContain("Enter → New line");
    expect(rows()).not.toContain("Enter → Send");
  });
});

describe("finding a shortcut", () => {
  it("narrows the sheet to what matches every word, and says when nothing does", async () => {
    sheet(true);
    const find = screen.getByRole("searchbox", { name: "Find a shortcut" });
    expect(find).toHaveFocus();
    // The field stays over the sheet, which is what scrolls.
    const scroller = screen.getByRole("dialog").querySelector(".dialog-scroll")!;
    expect(scroller).toContainElement(screen.getByRole("heading", { name: "Messages" }));
    expect(scroller).not.toContainElement(find);
    const user = userEvent.setup();
    await user.type(find, "next message");
    const rows = screen.getAllByRole("listitem").map((row) => row.textContent);
    expect(rows).toEqual(["Next message↓"]);
    expect(screen.getByRole("heading", { name: "Messages" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Writing" })).toBeNull();

    await user.clear(find);
    await user.type(find, "ctrl k");
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "Jump to a channel or personCtrlK",
    ]);

    await user.clear(find);
    await user.type(find, "teleport");
    expect(screen.queryAllByRole("listitem")).toEqual([]);
    expect(screen.getByRole("status")).toHaveTextContent("No shortcut matches.");
  });

  it("lists the keys that move between messages, not a hover", () => {
    sheet(true);
    const messages = screen.getByRole("heading", { name: "Messages" }).closest("section")!;
    expect(messages).toHaveTextContent("Previous message");
    expect(messages).toHaveTextContent("Into the message's actions");
    expect(messages).not.toHaveTextContent("Hover");
  });
});
