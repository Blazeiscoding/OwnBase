import { StrictMode, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Modal, hasOpenModal } from "../src/components/Modal.js";

function Stacked({ removeLower = false }: { removeLower?: boolean }) {
  const [lower, setLower] = useState(false);
  const [upper, setUpper] = useState(false);
  return (
    <>
      <button onClick={() => setLower(true)}>Open settings</button>
      {lower && !removeLower && (
        <Modal title="Settings" onClose={() => setLower(false)}>
          <button onClick={() => setUpper(true)}>Open app form</button>
        </Modal>
      )}
      {upper && (
        <Modal title="App form" onClose={() => setUpper(false)}>
          <input aria-label="App answer" autoFocus />
          <button
            onClick={() => {
              setLower(false);
              setUpper(false);
            }}
          >
            Close both
          </button>
        </Modal>
      )}
    </>
  );
}

async function openStack() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open settings" }));
  await user.click(screen.getByRole("button", { name: "Open app form" }));
  return user;
}

describe("modal keyboard and focus ownership", () => {
  it("closes only the foreground layer and returns focus through its openers", async () => {
    const { container } = render(<Stacked />);
    const user = await openStack();
    const lower = screen.getByRole("dialog", { name: "Settings" });
    const upper = screen.getByRole("dialog", { name: "App form" });
    expect(container).toHaveAttribute("inert");
    expect(lower.parentElement).toHaveAttribute("inert");
    expect(upper.parentElement).not.toHaveAttribute("inert");
    expect(screen.getByRole("textbox", { name: "App answer" })).toHaveFocus();
    expect(hasOpenModal()).toBe(true);

    // Even a synthetic press cannot dismiss the covered backdrop.
    fireEvent.mouseDown(lower.parentElement!);
    expect(lower).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(upper).not.toBeInTheDocument();
    expect(lower).toBeInTheDocument();
    expect(within(lower).getByRole("button", { name: "Open app form" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings" })).toHaveFocus();
    expect(container).not.toHaveAttribute("inert");
    expect(hasOpenModal()).toBe(false);
  });

  it("keeps the active layer focused when a lower layer disappears", async () => {
    const { rerender } = render(<Stacked />);
    const user = await openStack();
    const answer = screen.getByRole("textbox", { name: "App answer" });
    rerender(<Stacked removeLower />);
    expect(answer).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Open settings" })).toHaveFocus();
  });

  it("returns to the workspace when both layers close in the same commit", async () => {
    render(<Stacked />);
    const user = await openStack();
    await user.click(screen.getByRole("button", { name: "Close both" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings" })).toHaveFocus();
  });

  it("returns focus through its openers after a press outside, as after Escape", async () => {
    render(<Stacked />);
    const user = await openStack();
    const lower = screen.getByRole("dialog", { name: "Settings" });

    // A real press: its mousedown would move focus to the page if let.
    await user.click(screen.getByRole("dialog", { name: "App form" }).parentElement!);
    expect(screen.queryByRole("dialog", { name: "App form" })).not.toBeInTheDocument();
    expect(within(lower).getByRole("button", { name: "Open app form" })).toHaveFocus();
    await user.click(lower.parentElement!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings" })).toHaveFocus();
  });

  it("moves focus into the layer underneath when the closed one has nothing to return to", async () => {
    function OpenedTogether() {
      const [notice, setNotice] = useState(true);
      return (
        <>
          <Modal title="Settings" onClose={() => {}}>
            <button>Settings action</button>
          </Modal>
          {notice && (
            <Modal title="Notice" onClose={() => setNotice(false)}>
              <button autoFocus>Got it</button>
            </Modal>
          )}
        </>
      );
    }
    render(<OpenedTogether />);
    expect(screen.getByRole("button", { name: "Got it" })).toHaveFocus();
    // Nothing on the page opened the notice, so there is no opener to go back to.
    await userEvent.setup().keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Notice" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Settings" })).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  it("preserves autofocus through StrictMode registration and cleanup", () => {
    const { unmount, container } = render(
      <StrictMode>
        <Modal title="Edit details" onClose={() => {}}>
          <input aria-label="Details" autoFocus />
        </Modal>
      </StrictMode>,
    );
    expect(screen.getByRole("textbox", { name: "Details" })).toHaveFocus();
    unmount();
    expect(hasOpenModal()).toBe(false);
    expect(container).not.toHaveAttribute("inert");
  });

  it("respects consumed, composing, and nondismissible Escape events", async () => {
    const close = vi.fn();
    const content = (dismissible: boolean, consume: boolean) => (
      <Modal title="Edit details" onClose={close} dismissible={dismissible}>
        <input
          aria-label="Details"
          autoFocus
          onKeyDown={(event) => {
            if (consume && event.key === "Escape") event.preventDefault();
          }}
        />
      </Modal>
    );
    const { rerender } = render(content(true, false));
    const input = screen.getByRole("textbox", { name: "Details" });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
    expect(close).not.toHaveBeenCalled();
    rerender(content(true, true));
    await userEvent.setup().keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
    rerender(content(false, false));
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(close).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(close).not.toHaveBeenCalled();
    rerender(content(true, false));
    await userEvent.setup().keyboard("{Escape}");
    expect(close).toHaveBeenCalledOnce();
  });

  it("wraps Tab past hidden, disabled, and negative-tabindex controls", async () => {
    render(
      <Modal title="Choose action" onClose={() => {}}>
        <button autoFocus>First</button>
        <button>Last</button>
        <button tabIndex={-1}>Programmatic only</button>
        <button hidden>Hidden</button>
        <button style={{ visibility: "hidden" }}>Invisible</button>
        <fieldset disabled>
          <button>Disabled by fieldset</button>
        </fieldset>
      </Modal>,
    );
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
  });

  it("uses positive tabindex order and treats a radio group as one tab stop", async () => {
    render(
      <Modal title="Preferences" onClose={() => {}}>
        <button tabIndex={2}>Second</button>
        <button tabIndex={1} autoFocus>
          First
        </button>
        <label>
          <input type="radio" name="choice" defaultChecked />
          Selected
        </label>
        <label>
          <input type="radio" name="choice" />
          Unselected
        </label>
      </Modal>,
    );
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("button", { name: "Second" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("radio", { name: "Selected" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("radio", { name: "Selected" })).toHaveFocus();
  });

  it("recovers removed or disabled focus without stealing focus from a confirmation section", async () => {
    const contents = (disabled: boolean) => (
      <Modal title="Confirm change" onClose={() => {}}>
        <section tabIndex={-1} aria-label="Confirmation">
          <button>Cancel</button>
        </section>
        <button autoFocus disabled={disabled}>
          Apply
        </button>
      </Modal>
    );
    const { rerender } = render(contents(false));
    const dialog = screen.getByRole("dialog");
    expect(screen.getByRole("button", { name: "Apply" })).toHaveFocus();
    rerender(contents(true));
    await waitFor(() => expect(dialog).toHaveFocus());
    const section = screen.getByRole("region", { name: "Confirmation" });
    act(() => section.focus());
    expect(section).toHaveFocus();
    await userEvent.setup().tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("restores pre-existing inert state and isolates body children added while open", async () => {
    const existing = document.createElement("aside");
    existing.setAttribute("inert", "retained");
    document.body.append(existing);
    const added = document.createElement("button");
    added.textContent = "Added outside";
    const { unmount } = render(
      <Modal title="Settings" onClose={() => {}}>
        <button autoFocus>Inside</button>
      </Modal>,
    );
    try {
      document.body.append(added);
      await waitFor(() => expect(added).toHaveAttribute("inert"));
      // jsdom does not implement inert focus suppression, so this additionally
      // exercises the shared guard used for unexpected programmatic focus.
      act(() => added.focus());
      expect(screen.getByRole("button", { name: "Inside" })).toHaveFocus();
      unmount();
      expect(existing).toHaveAttribute("inert", "retained");
      expect(added).not.toHaveAttribute("inert");
    } finally {
      existing.remove();
      added.remove();
    }
  });

  it("leaves a ringing call answerable over a dialog: not inert, in Tab's round, Esc back", async () => {
    const call = document.createElement("div");
    call.setAttribute("data-ownbase-call", "");
    const join = document.createElement("button");
    join.textContent = "Join";
    call.append(join);
    const { unmount } = render(
      <Modal title="Settings" onClose={() => {}}>
        <button autoFocus>First</button>
        <button>Last</button>
      </Modal>,
    );
    try {
      document.body.append(call);
      const user = userEvent.setup();
      await user.tab();
      expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
      expect(call).not.toHaveAttribute("inert");
      await user.tab();
      expect(join).toHaveFocus();
      await user.tab();
      expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
      await user.tab({ shift: true });
      expect(join).toHaveFocus();
      // Esc from the call goes back to the dialog, which stays open.
      await user.keyboard("{Escape}");
      expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
      // A click on the call keeps focus there.
      act(() => join.focus());
      expect(join).toHaveFocus();
    } finally {
      unmount();
      call.remove();
    }
  });
});
