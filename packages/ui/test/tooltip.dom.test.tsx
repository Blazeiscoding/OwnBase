import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../src/components/Modal.js";
import { Tooltip } from "../src/components/Tooltip.js";
import { accessibilityProblems } from "./accessibility.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a tooltip", () => {
  it("waits on pointer hover, can itself be hovered, and leaves no native title", () => {
    vi.useFakeTimers();
    render(
      <Tooltip label="Attach a file">
        <button aria-label="Attach a file" title="Browser hint">
          +
        </button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Attach a file" });
    expect(trigger).not.toHaveAttribute("title");
    expect(trigger).not.toHaveAccessibleDescription();

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(399));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Attach a file");
    expect(trigger).toHaveAccessibleDescription("Attach a file");

    // The short grace period lets a magnified pointer cross the gap and keep
    // the content visible while it is over the tooltip itself. Message
    // toolbars disappear as the pointer leaves, so exercise that bridge too.
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    trigger.hidden = true;
    fireEvent.scroll(document);
    act(() => vi.advanceTimersByTime(80));
    fireEvent.pointerEnter(tooltip, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("tooltip")).toBeVisible();

    fireEvent.pointerLeave(tooltip, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(120));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(trigger).not.toHaveAccessibleDescription();
  });

  it("closes when its trigger disappears outside a pointer transfer", () => {
    render(
      <Tooltip label="Pinned messages">
        <button aria-label="Pinned messages">pin</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Pinned messages" });
    act(() => trigger.focus());
    expect(screen.getByRole("tooltip")).toBeVisible();

    trigger.hidden = true;
    fireEvent.scroll(document);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("opens immediately on focus while preserving the child's ref, handlers and description", async () => {
    const ref = createRef<HTMLButtonElement>();
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    const onPointerEnter = vi.fn();
    const user = userEvent.setup();
    render(
      <main>
        <p id="shortcut-context">Available while writing a message.</p>
        <Tooltip label="Insert emoji" keys="Ctrl Shift E">
          <button
            ref={ref}
            aria-label="Insert emoji"
            aria-describedby="shortcut-context"
            onFocus={onFocus}
            onBlur={onBlur}
            onPointerEnter={onPointerEnter}
          >
            emoji
          </button>
        </Tooltip>
      </main>,
    );
    const trigger = screen.getByRole("button", { name: "Insert emoji" });
    expect(ref.current).toBe(trigger);
    expect(trigger).toHaveAccessibleDescription("Available while writing a message.");

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    expect(onPointerEnter).toHaveBeenCalledOnce();
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await user.tab();
    expect(onFocus).toHaveBeenCalledOnce();
    expect(trigger).toHaveAccessibleDescription(
      "Available while writing a message. Insert emoji. Shortcut: Ctrl Shift E",
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(/Insert emoji.*Ctrl Shift E/);
    expect(await accessibilityProblems(document.body)).toEqual([]);

    await user.tab();
    expect(onBlur).toHaveBeenCalledOnce();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("consumes the first Escape inside a dialog without moving focus or closing the dialog", async () => {
    const close = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal title="Preferences" onClose={close} className="p-4">
        <Tooltip label="More settings">
          <button aria-label="More settings">...</button>
        </Tooltip>
      </Modal>,
    );
    await user.tab();
    const trigger = screen.getByRole("button", { name: "More settings" });
    expect(trigger).toHaveFocus();
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.closest("[data-tandem-modal]")).not.toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Preferences" })).toBeVisible();
    expect(close).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(close).toHaveBeenCalledOnce();
  });

  it("lets Escape go on to the focused control when the pointer opened it on another", async () => {
    const close = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal title="Preferences" onClose={close} className="p-4">
        <input aria-label="Display name" autoFocus />
        <Tooltip label="More settings">
          <button aria-label="More settings">...</button>
        </Tooltip>
      </Modal>,
    );
    const field = screen.getByRole("textbox", { name: "Display name" });
    expect(field).toHaveFocus();
    fireEvent.pointerEnter(screen.getByRole("button", { name: "More settings" }), {
      pointerType: "mouse",
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("More settings");

    // The key is the dialog's, where the keyboard is; the hint goes with it.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(close).toHaveBeenCalledOnce();
  });

  it("flips at a viewport edge, follows scroll, and updates an open label", async () => {
    let triggerBox = new DOMRect(40, 2, 20, 20);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      if ((this as HTMLElement).getAttribute("role") === "tooltip")
        return new DOMRect(0, 0, 120, 24);
      if (this instanceof HTMLButtonElement) return triggerBox;
      return new DOMRect(0, 0, 1, 1);
    });

    const user = userEvent.setup();
    const { rerender } = render(
      <Tooltip label="Mute">
        <button aria-label="Mute microphone">mic</button>
      </Tooltip>,
    );
    await user.tab();
    let tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveAttribute("data-side", "bottom");

    triggerBox = new DOMRect(window.innerWidth - 6, window.innerHeight - 30, 20, 20);
    fireEvent.scroll(document);
    tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveAttribute("data-side", "top");
    expect(Number.parseFloat(tooltip.style.left)).toBeLessThanOrEqual(window.innerWidth - 128);

    rerender(
      <Tooltip label="Unmute">
        <button aria-label="Mute microphone">mic</button>
      </Tooltip>,
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent("Unmute");

    triggerBox = new DOMRect(40, -40, 20, 20);
    fireEvent.scroll(document);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("ignores touch hover because the control already carries its accessible name", () => {
    vi.useFakeTimers();
    render(
      <Tooltip label="Pinned messages">
        <button aria-label="Pinned messages">pin</button>
      </Tooltip>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Pinned messages" }), {
      pointerType: "touch",
    });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("does not reopen from the focus caused by a pointer click", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Pinned messages">
        <button aria-label="Pinned messages">pin</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Pinned messages" });
    await user.click(trigger);
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("keeps only the most recently opened tooltip", () => {
    vi.useFakeTimers();
    render(
      <>
        <Tooltip label="First hint">
          <button aria-label="First control">one</button>
        </Tooltip>
        <Tooltip label="Second hint">
          <button aria-label="Second control">two</button>
        </Tooltip>
      </>,
    );
    const first = screen.getByRole("button", { name: "First control" });
    const second = screen.getByRole("button", { name: "Second control" });
    act(() => first.focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent("First hint");

    fireEvent.pointerEnter(second, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Second hint");
  });

  it("stays inside the Fullscreen API top layer", () => {
    const fullscreen = document.createElement("section");
    document.body.append(fullscreen);
    const previous = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    try {
      const view = render(
        <Tooltip label="Hide video">
          <button aria-label="Hide video">hide</button>
        </Tooltip>,
        { container: fullscreen },
      );
      act(() => screen.getByRole("button", { name: "Hide video" }).focus());
      expect(screen.getByRole("tooltip").parentElement).toBe(document.body);

      fullscreenElement = fullscreen;
      act(() => document.dispatchEvent(new Event("fullscreenchange")));
      expect(screen.getByRole("tooltip").parentElement).toBe(fullscreen);
      expect(screen.getByRole("tooltip")).toHaveStyle({ visibility: "visible" });
      view.unmount();
    } finally {
      if (previous) Object.defineProperty(document, "fullscreenElement", previous);
      else Reflect.deleteProperty(document, "fullscreenElement");
      fullscreen.remove();
    }
  });

  it("preserves a React 19 callback ref's cleanup", () => {
    const cleanup = vi.fn();
    const ref = vi.fn((element: HTMLButtonElement | null) =>
      element ? () => cleanup() : undefined,
    );
    const view = render(
      <Tooltip label="More settings">
        <button ref={ref} aria-label="More settings">
          more
        </button>
      </Tooltip>,
    );
    expect(ref).toHaveBeenCalledWith(screen.getByRole("button", { name: "More settings" }));

    view.unmount();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(ref).not.toHaveBeenCalledWith(null);
  });

  it("opens before its floating text has arrived, and draws it once it has", async () => {
    // A copy of the module that has not fetched the text yet, as in the first
    // moment after the app starts.
    vi.resetModules();
    const fresh = await import("../src/components/Tooltip.js");
    render(
      <fresh.Tooltip label="Start a huddle">
        <button aria-label="Start a huddle">huddle</button>
      </fresh.Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Start a huddle" });
    act(() => trigger.focus());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Start a huddle");
    expect(trigger).toHaveAccessibleDescription("Start a huddle");
  });
});
