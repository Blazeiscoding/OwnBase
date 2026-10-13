import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog, DialogScroll } from "../src/components/Dialog.js";
import { accessibilityProblems } from "./accessibility.js";

/** A button that opens a small form in a dialog, as most dialogs here are opened. */
function RenameChannel({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Rename channel</button>
      {open && (
        <Dialog
          title="Rename channel"
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        >
          <input aria-label="Channel name" autoFocus />
          <button>Save</button>
        </Dialog>
      )}
    </>
  );
}

describe("a dialog", () => {
  it("is announced as a modal dialog, named by its title", async () => {
    const user = userEvent.setup();
    render(<RenameChannel />);
    await user.click(screen.getByRole("button", { name: "Rename channel" }));
    const dialog = screen.getByRole("dialog", { name: "Rename channel" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("takes focus when it opens, and gives it back to what opened it when it closes", async () => {
    const user = userEvent.setup();
    render(<RenameChannel />);
    const opener = screen.getByRole("button", { name: "Rename channel" });
    await user.click(opener);
    expect(screen.getByRole("textbox", { name: "Channel name" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("focuses itself when nothing inside asks for focus", () => {
    render(
      <Dialog title="Keyboard shortcuts" onClose={() => {}}>
        <p>Press ? to see this again.</p>
      </Dialog>,
    );
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveFocus();
  });

  it("keeps Tab and Shift+Tab inside itself", async () => {
    const user = userEvent.setup();
    render(<RenameChannel />);
    await user.click(screen.getByRole("button", { name: "Rename channel" }));
    const close = screen.getByRole("button", { name: "Close" });
    const name = screen.getByRole("textbox", { name: "Channel name" });
    const save = screen.getByRole("button", { name: "Save" });

    await user.tab();
    expect(save).toHaveFocus();
    // Past the last control, round to the first rather than out to the page.
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(save).toHaveFocus();
    await user.tab({ shift: true });
    expect(name).toHaveFocus();
  });

  it("closes on Escape or a press outside it, but not on a press inside", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog title="Rename channel" onClose={onClose}>
        <p>Inside</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(screen.getByText("Inside"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <Dialog title="Rename channel" onClose={onClose}>
        <p>Inside</p>
      </Dialog>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps its name and its close button out of what scrolls", () => {
    render(
      <Dialog title="Diagnostics" onClose={() => {}}>
        <p>A long report</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    const scroller = dialog.querySelector(".dialog-scroll")!;
    expect(scroller).toContainElement(screen.getByText("A long report"));
    expect(scroller).not.toContainElement(screen.getByRole("heading", { name: "Diagnostics" }));
    expect(scroller).not.toContainElement(screen.getByRole("button", { name: "Close" }));
  });

  it("lets the content keep a field above what scrolls, and buttons below it", () => {
    render(
      <Dialog title="New message" onClose={() => {}} ownScroll>
        <input aria-label="To" />
        <DialogScroll>
          <p>Alex Kim</p>
        </DialogScroll>
        <button>Start conversation</button>
      </Dialog>,
    );
    const scrollers = screen.getByRole("dialog").querySelectorAll(".dialog-scroll");
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]).toContainElement(screen.getByText("Alex Kim"));
    expect(scrollers[0]).not.toContainElement(screen.getByRole("textbox", { name: "To" }));
    expect(scrollers[0]).not.toContainElement(
      screen.getByRole("button", { name: "Start conversation" }),
    );
  });

  describe("scrolled from the keyboard", () => {
    /** A dialog whose list is 400 px tall on screen; jsdom lays nothing out. */
    function shortcuts() {
      render(
        <Dialog title="Keyboard shortcuts" onClose={() => {}} ownScroll>
          <input aria-label="Find a shortcut" />
          <textarea aria-label="Notes" />
          <DialogScroll>
            <button>Copy</button>
          </DialogScroll>
        </Dialog>,
      );
      const dialog = screen.getByRole("dialog");
      const scroller = dialog.querySelector<HTMLElement>(".dialog-scroll")!;
      Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
      return { dialog, scroller, user: userEvent.setup() };
    }

    it("pages what scrolls from a field kept above it", async () => {
      const { scroller, user } = shortcuts();
      screen.getByRole("textbox", { name: "Find a shortcut" }).focus();
      await user.keyboard("{PageDown}");
      expect(scroller.scrollTop).toBe(360);
      await user.keyboard("{PageUp}");
      expect(scroller.scrollTop).toBe(0);
      // The arrow keys there move through what is typed.
      await user.keyboard("{ArrowDown}{End}");
      expect(scroller.scrollTop).toBe(0);
    });

    it("scrolls by line, page and to either end from the dialog itself", async () => {
      const { dialog, scroller, user } = shortcuts();
      dialog.focus();
      await user.keyboard("{ArrowDown}");
      expect(scroller.scrollTop).toBe(40);
      await user.keyboard("{ArrowUp}{PageDown}");
      expect(scroller.scrollTop).toBe(360);
      // Farther than any dialog is long. A browser stops at the end itself;
      // jsdom scrolls nothing, and keeps the number it was given.
      await user.keyboard("{End}");
      const end = scroller.scrollTop;
      expect(end).toBeGreaterThan(100_000);
      await user.keyboard("{Home}");
      expect(scroller.scrollTop).toBeLessThan(end - 100_000);
    });

    it("leaves the keys to where a page means something else, and to what already scrolls", async () => {
      const { scroller, user } = shortcuts();
      // Page Down in a box of several lines moves through them.
      screen.getByRole("textbox", { name: "Notes" }).focus();
      await user.keyboard("{PageDown}");
      expect(scroller.scrollTop).toBe(0);
      // Inside what scrolls, the browser scrolls it; scrolling it here too would double it.
      screen.getByRole("button", { name: "Copy" }).focus();
      await user.keyboard("{PageDown}");
      expect(scroller.scrollTop).toBe(0);
      // With a modifier it is some other command.
      screen.getByRole("textbox", { name: "Find a shortcut" }).focus();
      await user.keyboard("{Control>}{PageDown}{/Control}");
      expect(scroller.scrollTop).toBe(0);
    });
  });

  it("stays open while it has to", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog title="Stopping the workspace" onClose={onClose} dismissible={false}>
        <p>Stopping…</p>
      </Dialog>,
    );
    await user.keyboard("{Escape}");
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });
});
