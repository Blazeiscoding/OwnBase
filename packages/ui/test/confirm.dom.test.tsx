import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmProvider, useConfirm } from "../src/components/Confirm.js";
import { Dialog } from "../src/components/Dialog.js";
import { accessibilityProblems } from "./accessibility.js";

function DestructiveQuestion({ answered }: { answered: (answer: boolean) => void }) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      onClick={() => {
        void confirm({
          title: "Delete this message?",
          body: "Everyone in the conversation stops seeing it.",
          confirmLabel: "Delete",
          destructive: true,
        }).then(answered);
      }}
    >
      Ask to delete
    </button>
  );
}

describe("shared confirmations", () => {
  it("names the consequence, starts a destructive question on Cancel, and returns focus", async () => {
    const user = userEvent.setup();
    const answered = vi.fn();
    render(
      <ConfirmProvider>
        <Dialog title="Conversation" onClose={() => {}}>
          <DestructiveQuestion answered={answered} />
        </Dialog>
      </ConfirmProvider>,
    );

    const lower = screen.getByRole("dialog", { name: "Conversation" });
    const opener = screen.getByRole("button", { name: "Ask to delete" });
    await user.click(opener);
    const question = screen.getByRole("dialog", { name: "Delete this message?" });
    expect(question).toHaveAccessibleDescription("Everyone in the conversation stops seeing it.");
    expect(within(question).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(lower.parentElement).toHaveAttribute("inert");
    expect(await accessibilityProblems(question)).toEqual([]);

    await user.keyboard("{Escape}");
    expect(question).not.toBeInTheDocument();
    expect(answered).toHaveBeenCalledWith(false);
    expect(opener).toHaveFocus();
    expect(lower.parentElement).not.toHaveAttribute("inert");

    await user.click(opener);
    await user.click(
      within(screen.getByRole("dialog", { name: "Delete this message?" })).getByRole("button", {
        name: "Delete",
      }),
    );
    expect(answered).toHaveBeenLastCalledWith(true);
  });

  it("treats the close button and backdrop as one cancellation each", async () => {
    const user = userEvent.setup();
    const answered = vi.fn();
    render(
      <ConfirmProvider>
        <DestructiveQuestion answered={answered} />
      </ConfirmProvider>,
    );

    const opener = screen.getByRole("button", { name: "Ask to delete" });
    await user.click(opener);
    let question = screen.getByRole("dialog", { name: "Delete this message?" });
    await user.click(within(question).getByRole("button", { name: "Close" }));
    expect(answered).toHaveBeenCalledTimes(1);
    expect(answered).toHaveBeenLastCalledWith(false);

    await user.click(opener);
    question = screen.getByRole("dialog", { name: "Delete this message?" });
    fireEvent.mouseDown(question.parentElement!);
    await waitFor(() => expect(answered).toHaveBeenCalledTimes(2));
    expect(answered).toHaveBeenLastCalledWith(false);
  });

  it("starts a reversible question on its named action", async () => {
    const user = userEvent.setup();
    function Question() {
      const confirm = useConfirm();
      return (
        <button
          onClick={() =>
            void confirm({
              title: "Reconnect now?",
              body: "OwnBase will try the connection again.",
              confirmLabel: "Reconnect",
            })
          }
        >
          Ask to reconnect
        </button>
      );
    }
    render(
      <ConfirmProvider>
        <Question />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Ask to reconnect" }));
    expect(
      within(screen.getByRole("dialog", { name: "Reconnect now?" })).getByRole("button", {
        name: "Reconnect",
      }),
    ).toHaveFocus();
  });

  it("cancels a question replaced by a newer one, without a stale answer closing the new dialog", async () => {
    let ask: ReturnType<typeof useConfirm> | null = null;
    function Capture() {
      ask = useConfirm();
      return null;
    }
    render(
      <ConfirmProvider>
        <Capture />
      </ConfirmProvider>,
    );

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = ask!({ title: "Repeated question?", confirmLabel: "First" });
      second = ask!({ title: "Repeated question?", confirmLabel: "Second" });
    });
    await expect(first).resolves.toBe(false);
    expect(screen.getAllByRole("dialog", { name: "Repeated question?" })).toHaveLength(1);
    const latest = screen.getByRole("dialog", { name: "Repeated question?" });
    expect(within(latest).getByRole("button", { name: "Second" })).toHaveFocus();

    await userEvent.setup().click(within(latest).getByRole("button", { name: "Second" }));
    await expect(second).resolves.toBe(true);
  });

  it("answers no when its provider goes away", async () => {
    let ask: ReturnType<typeof useConfirm> | null = null;
    function Capture() {
      ask = useConfirm();
      return null;
    }
    const view = render(
      <ConfirmProvider>
        <Capture />
      </ConfirmProvider>,
    );
    let answer!: Promise<boolean>;
    act(() => {
      answer = ask!({ title: "Leave this page?", confirmLabel: "Leave" });
    });

    view.unmount();
    await expect(answer).resolves.toBe(false);
  });

  it("answers no when the component that asked goes away", async () => {
    let ask: ReturnType<typeof useConfirm> | null = null;
    function Capture() {
      ask = useConfirm();
      return null;
    }
    const view = render(
      <ConfirmProvider>
        <Capture />
      </ConfirmProvider>,
    );
    let answer!: Promise<boolean>;
    act(() => {
      answer = ask!({ title: "Delete this old message?", confirmLabel: "Delete" });
    });
    expect(screen.getByRole("dialog", { name: "Delete this old message?" })).toBeVisible();

    view.rerender(
      <ConfirmProvider>
        <p>The message is gone.</p>
      </ConfirmProvider>,
    );
    await expect(answer).resolves.toBe(false);
    expect(screen.queryByRole("dialog", { name: "Delete this old message?" })).toBeNull();
  });
});
