import { useRef } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../src/components/Dialog.js";
import { ToastProvider, useToast, type ToastRequest } from "../src/components/Toast.js";
import { accessibilityProblems } from "./accessibility.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A control that raises a notice, and can take its own notice back. */
function Raiser({ label = "Do it", request }: { label?: string; request: ToastRequest }) {
  const toast = useToast();
  const dismiss = useRef<(() => void) | null>(null);
  return (
    <>
      <button type="button" onClick={() => (dismiss.current = toast(request))}>
        {label}
      </button>
      <button type="button" onClick={() => dismiss.current?.()}>
        Take it back
      </button>
    </>
  );
}

/** One control that raises several notices at once. */
function Many({ count, kind = "error" }: { count: number; kind?: ToastRequest["kind"] }) {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        for (let n = 1; n <= count; n++) toast({ message: `Problem ${n}.`, kind });
      }}
    >
      Raise
    </button>
  );
}

function stack() {
  return document.querySelector<HTMLElement>("[data-ownbase-toasts]")!;
}

function noticeFor(text: string) {
  return screen.getByText(text).closest<HTMLElement>("[data-toast]")!;
}

describe("shared notices", () => {
  it("clears a success on its own", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Raiser label="Saved" request={{ message: "Saved for later.", kind: "success" }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Saved" }));
    expect(screen.getByText("Saved for later.")).toBeVisible();

    act(() => vi.advanceTimersByTime(4999));
    expect(screen.getByText("Saved for later.")).toBeVisible();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Saved for later.")).not.toBeInTheDocument();
  });

  it("keeps a failure on screen however long it takes to notice", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Raiser request={{ message: "Could not pin that message." }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Could not pin that message.")).toBeVisible();
  });

  it("stops the countdown while the pointer is over it, and resumes what was left", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Raiser request={{ message: "Saved for later.", kind: "success" }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    act(() => vi.advanceTimersByTime(3000));

    const notice = noticeFor("Saved for later.");
    fireEvent.pointerEnter(notice);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Saved for later.")).toBeVisible();

    // Reading it does not extend it indefinitely: leaving picks the countdown
    // up where it stopped rather than starting a fresh one.
    fireEvent.pointerLeave(notice);
    act(() => vi.advanceTimersByTime(1999));
    expect(screen.getByText("Saved for later.")).toBeVisible();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Saved for later.")).not.toBeInTheDocument();
  });

  it("keeps holding while focus stays inside, after the pointer has gone", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Raiser request={{ message: "Saved for later.", kind: "success" }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    const notice = noticeFor("Saved for later.");
    fireEvent.pointerEnter(notice);
    act(() => within(notice).getByRole("button", { name: "Dismiss" }).focus());
    fireEvent.pointerLeave(notice);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Saved for later.")).toBeVisible();

    act(() => screen.getByRole("button", { name: "Do it" }).focus());
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByText("Saved for later.")).not.toBeInTheDocument();
  });

  it("lets a notice that goes while held take its hold with it", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Many count={2} kind="success" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Raise" }));
    const first = noticeFor("Problem 1.");
    fireEvent.pointerEnter(first);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Problem 2.")).toBeVisible();

    // A removed element gets no pointerleave. Were the hold not its own, the
    // other notice would never count down again.
    fireEvent.click(within(first).getByRole("button", { name: "Dismiss" }));
    act(() => vi.advanceTimersByTime(4999));
    expect(screen.getByText("Problem 2.")).toBeVisible();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Problem 2.")).not.toBeInTheDocument();
  });

  it("offers the action, runs it, and takes the notice away", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(
      <ToastProvider>
        <Raiser
          request={{
            message: "That reaction did not go through.",
            action: { label: "Try again", run },
          }}
        />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Do it" }));
    const again = screen.getByRole("button", { name: "Try again" });
    expect(again).toHaveAccessibleDescription("That reaction did not go through.");
    await user.click(again);
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByText("That reaction did not go through.")).not.toBeInTheDocument();
  });

  it("can be dismissed by hand, or taken back by whoever raised it", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Raiser request={{ message: "Could not pin that message." }} />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Do it" }));
    await user.click(
      screen.getByRole("button", { name: "Dismiss", description: "Could not pin that message." }),
    );
    expect(screen.queryByText("Could not pin that message.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Do it" }));
    expect(screen.getByText("Could not pin that message.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Take it back" }));
    expect(screen.queryByText("Could not pin that message.")).not.toBeInTheDocument();
  });

  it("says the same thing once", () => {
    render(
      <ToastProvider>
        <Raiser label="Same" request={{ message: "That reaction did not go through." }} />
      </ToastProvider>,
    );
    const same = screen.getByRole("button", { name: "Same" });
    fireEvent.click(same);
    fireEvent.click(same);
    fireEvent.click(same);
    expect(screen.getAllByText("That reaction did not go through.")).toHaveLength(1);
  });

  it("drops the oldest once more have arrived than the screen has room for", () => {
    render(
      <ToastProvider>
        <Many count={5} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Raise" }));
    expect(screen.queryByText("Problem 1.")).not.toBeInTheDocument();
    for (const n of [2, 3, 4, 5]) expect(screen.getByText(`Problem ${n}.`)).toBeVisible();
  });

  it("keeps focus nearby when the notice holding it goes, then gives it back", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Many count={2} />
      </ToastProvider>,
    );
    const raise = screen.getByRole("button", { name: "Raise" });
    await user.click(raise);
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Dismiss", description: "Problem 1." }),
    ).toHaveFocus();

    // Focus never falls to the page when a notice goes: the next notice takes
    // it, and after the last one it returns where it came from.
    await user.keyboard("{Enter}");
    expect(screen.queryByText("Problem 1.")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss", description: "Problem 2." }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByText("Problem 2.")).not.toBeInTheDocument();
    expect(raise).toHaveFocus();
  });

  it("dismisses the focused notice on Escape without reaching the page behind it", async () => {
    const user = userEvent.setup();
    const pageEscape = vi.fn();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") pageEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    try {
      render(
        <ToastProvider>
          <Many count={1} />
        </ToastProvider>,
      );
      const raise = screen.getByRole("button", { name: "Raise" });
      await user.click(raise);
      await user.tab();
      await user.keyboard("{Escape}");
      expect(screen.queryByText("Problem 1.")).not.toBeInTheDocument();
      expect(raise).toHaveFocus();
      // The side panel behind would otherwise close on the same key press.
      expect(pageEscape).not.toHaveBeenCalled();

      await user.keyboard("{Escape}");
      expect(pageEscape).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("keydown", onKeyDown);
    }
  });

  it("stays readable and usable over a dialog that makes everything else inert", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    const run = vi.fn();
    render(
      <ToastProvider>
        <Dialog title="Account settings" onClose={close}>
          <Raiser
            request={{ message: "Could not save that.", action: { label: "Try again", run } }}
          />
        </Dialog>
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Do it" }));

    // The trap this component was written around: the modal layer marks every
    // other child of the body inert, which would hide the notice from a screen
    // reader and disable its action.
    expect(stack()).not.toHaveAttribute("inert");
    expect(stack().closest("[inert]")).toBeNull();
    expect(screen.getByText("Could not save that.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(run).toHaveBeenCalledOnce();
    // The dialog underneath is untouched by any of this.
    expect(screen.getByRole("dialog", { name: "Account settings" })).toBeVisible();
    expect(close).not.toHaveBeenCalled();
  });

  it("never takes focus away from whatever raised it", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Raiser
          request={{
            message: "Could not pin that message.",
            action: { label: "Try again", run: vi.fn() },
          }}
        />
      </ToastProvider>,
    );
    const opener = screen.getByRole("button", { name: "Do it" });
    await user.click(opener);
    expect(screen.getByText("Could not pin that message.")).toBeVisible();
    expect(opener).toHaveFocus();
  });

  it("announces failures and successes in regions that were already there", async () => {
    render(
      <ToastProvider>
        <Raiser label="Fail" request={{ message: "Could not pin that message." }} />
        <Raiser label="Succeed" request={{ message: "Saved for later.", kind: "success" }} />
      </ToastProvider>,
    );
    // Both regions exist before anything is said, so a screen reader is
    // watching them rather than meeting a region that has just appeared.
    const polite = stack().querySelector<HTMLElement>('[aria-live="polite"]')!;
    const assertive = stack().querySelector<HTMLElement>('[aria-live="assertive"]')!;
    expect(polite).toBeEmptyDOMElement();
    expect(assertive).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole("button", { name: "Fail" }));
    fireEvent.click(screen.getByRole("button", { name: "Succeed" }));
    expect(within(assertive).getByText("Could not pin that message.")).toBeVisible();
    expect(within(polite).getByText("Saved for later.")).toBeVisible();
    expect(await accessibilityProblems(document.body)).toEqual([]);
  });
});
