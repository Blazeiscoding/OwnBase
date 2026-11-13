import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { usePanelFocus } from "../src/lib/usePanelFocus.js";
import { accessibilityProblems } from "./accessibility.js";

function Panel(props: { takeFocus: boolean; onClose: () => void }) {
  const { panel, heading } = usePanelFocus({ takeFocus: props.takeFocus });
  return (
    <aside ref={panel} aria-label="Saved">
      <h2 ref={heading} tabIndex={-1}>
        Saved
      </h2>
      <input aria-label="Reply" />
      <button onClick={props.onClose}>Close saved</button>
    </aside>
  );
}

/** A page with a control that opens the panel, and something else to go to. */
function Page(props: { takeFocus?: boolean; openerGoesAway?: boolean; openerRemoved?: boolean }) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  return (
    <>
      <div tabIndex={0} aria-label="Message from Sam">
        {!(props.openerRemoved && opened) && (
          <button
            disabled={props.openerGoesAway && opened}
            onClick={() => {
              setOpen(true);
              setOpened(true);
            }}
          >
            Open saved
          </button>
        )}
      </div>
      <textarea aria-label="Message #general" />
      {open && <Panel takeFocus={props.takeFocus ?? true} onClose={() => setOpen(false)} />}
    </>
  );
}

/** A panel opened and closed from outside it. */
function Shown(props: { open: boolean }) {
  return (
    <>
      <button>Opener</button>
      <textarea aria-label="Message #general" />
      {props.open && <Panel takeFocus onClose={() => {}} />}
    </>
  );
}

describe("a side panel", () => {
  it("puts focus on its heading when it opens, and back on its opener when it closes", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole("button", { name: "Open saved" }));
    const heading = screen.getByRole("heading", { name: "Saved" });
    expect(heading).toHaveFocus();
    expect(await accessibilityProblems(screen.getByRole("complementary"))).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Close saved" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open saved" })).toHaveFocus();
  });

  it("goes back to a button pressed in Safari, which leaves focus on the page", () => {
    render(<Page />);
    // As Safari presses a button: clicked, but not focused.
    const opener = screen.getByRole("button", { name: "Open saved" });
    fireEvent.pointerDown(opener);
    fireEvent.click(opener);
    expect(screen.getByRole("heading", { name: "Saved" })).toHaveFocus();
    const close = screen.getByRole("button", { name: "Close saved" });
    fireEvent.pointerDown(close);
    fireEvent.click(close);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("leaves focus alone when somebody has moved on before it closes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Shown open={false} />);
    await user.click(screen.getByRole("button", { name: "Opener" }));
    rerender(<Shown open />);
    const composer = screen.getByRole("textbox", { name: "Message #general" });
    await user.click(composer);
    // Closed from elsewhere, the way opening another channel closes a thread.
    rerender(<Shown open={false} />);
    expect(composer).toHaveFocus();
  });

  it("does not take focus when its own box does, and still hands it back", async () => {
    const user = userEvent.setup();
    render(<Page takeFocus={false} />);
    await user.click(screen.getByRole("button", { name: "Open saved" }));
    expect(screen.getByRole("heading", { name: "Saved" })).not.toHaveFocus();
    await user.click(screen.getByRole("textbox", { name: "Reply" }));
    await user.click(screen.getByRole("button", { name: "Close saved" }));
    expect(screen.getByRole("button", { name: "Open saved" })).toHaveFocus();
  });

  it("leaves focus on a toggle that opened it, which can close it again", async () => {
    const user = userEvent.setup();
    function Toggled() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button aria-pressed={open} onClick={() => setOpen((o) => !o)}>
            Pinned messages
          </button>
          {open && <Panel takeFocus onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Toggled />);
    const toggle = screen.getByRole("button", { name: "Pinned messages" });
    await user.click(toggle);
    expect(screen.getByRole("heading", { name: "Saved" })).toBeInTheDocument();
    expect(toggle).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Close saved" }));
    expect(toggle).toHaveFocus();
  });

  it("gives focus to a toggle pressed in Safari, which leaves focus on the page", () => {
    function Toggled() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button aria-pressed={open} onClick={() => setOpen((o) => !o)}>
            Pinned messages
          </button>
          {open && <Panel takeFocus onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Toggled />);
    const toggle = screen.getByRole("button", { name: "Pinned messages" });
    fireEvent.pointerDown(toggle);
    fireEvent.click(toggle);
    expect(screen.getByRole("heading", { name: "Saved" })).toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it("takes focus from a toggle it covers, as on a phone, and gives it back when it closes", async () => {
    const user = userEvent.setup();
    function Covering() {
      const [open, setOpen] = useState(false);
      return (
        <>
          {/* On a phone the panel covers the page, which goes inert beneath it. */}
          <main inert={open}>
            <button aria-pressed={open} onClick={() => setOpen((o) => !o)}>
              Pinned messages
            </button>
          </main>
          {open && <Panel takeFocus onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Covering />);
    const toggle = screen.getByRole("button", { name: "Pinned messages" });
    await user.click(toggle);
    expect(screen.getByRole("heading", { name: "Saved" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Close saved" }));
    expect(toggle).toHaveFocus();
  });

  it("hands focus to the control a hidden container names, when nothing nearer can take it", async () => {
    const user = userEvent.setup();
    function Drawer() {
      const [open, setOpen] = useState(false);
      const [drawerClosed, setDrawerClosed] = useState(false);
      return (
        <>
          <button id="open-navigation">Open navigation</button>
          {/* The drawer closes as the panel opens, so its button can no longer take focus. */}
          <nav aria-label="Workspace navigation" data-focus-fallback="open-navigation">
            <button
              disabled={drawerClosed}
              onClick={() => {
                setOpen(true);
                setDrawerClosed(true);
              }}
            >
              Saved
            </button>
          </nav>
          {open && <Panel takeFocus onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Drawer />);
    await user.click(screen.getByRole("button", { name: "Saved" }));
    expect(screen.getByRole("heading", { name: "Saved" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Close saved" }));
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveFocus();
  });

  it("hands focus to what holds the opener when the opener can no longer take it", async () => {
    const user = userEvent.setup();
    render(<Page openerGoesAway />);
    await user.click(screen.getByRole("button", { name: "Open saved" }));
    await user.click(screen.getByRole("button", { name: "Close saved" }));
    expect(screen.getByLabelText("Message from Sam")).toHaveFocus();
  });

  it("hands focus to what held the opener when the opener has left the page", async () => {
    // A message's toolbar is made only while the message has the pointer or focus.
    const user = userEvent.setup();
    render(<Page openerRemoved />);
    await user.click(screen.getByRole("button", { name: "Open saved" }));
    expect(screen.queryByRole("button", { name: "Open saved" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close saved" }));
    expect(screen.getByLabelText("Message from Sam")).toHaveFocus();
  });
});
