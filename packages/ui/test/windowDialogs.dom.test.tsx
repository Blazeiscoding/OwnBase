import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AskedQuestion } from "@ownbase/protocol/desktop";
import { PlatformContext } from "../src/context.js";
import { ToastProvider } from "../src/components/Toast.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { WindowDialogs } from "../src/components/WindowDialogs.js";
import type { Platform } from "../src/platform.js";

const QUIT: AskedQuestion = {
  id: 7,
  title: "Quit OwnBase and stop the hosted workspace?",
  detail: "Teammates lose their connection until you start hosting again.",
  buttons: [
    { label: "Cancel", tone: "quiet" },
    { label: "Stop hosting and quit", tone: "danger" },
  ],
  cancel: 0,
  focus: 0,
};

/** The main process's side, as the window's platform hands it over. */
function mainProcess() {
  const ask = new Set<(question: AskedQuestion) => void>();
  const withdraw = new Set<(id: number) => void>();
  const notice = new Set<(message: string) => void>();
  const dialogs = {
    onAsk: (cb: (question: AskedQuestion) => void) => {
      ask.add(cb);
      return () => ask.delete(cb);
    },
    onWithdraw: (cb: (id: number) => void) => {
      withdraw.add(cb);
      return () => withdraw.delete(cb);
    },
    onNotice: (cb: (message: string) => void) => {
      notice.add(cb);
      return () => notice.delete(cb);
    },
    shown: vi.fn(async (_id: number) => {}),
    answer: vi.fn(async (_id: number, _index: number) => {}),
  };
  const platform: Platform = {
    kind: "desktop",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
    windowDialogs: dialogs,
  };
  render(
    <PlatformContext.Provider value={platform}>
      <ToastProvider>
        <ConfirmProvider>
          <WindowDialogs />
        </ConfirmProvider>
      </ToastProvider>
    </PlatformContext.Provider>,
  );
  return {
    dialogs,
    ask: (question: AskedQuestion) => act(() => ask.forEach((cb) => cb(question))),
    withdraw: (id: number) => act(() => withdraw.forEach((cb) => cb(id))),
    notice: (message: string) => act(() => notice.forEach((cb) => cb(message))),
    user: userEvent.setup(),
  };
}

describe("questions from the desktop app, in its own dialog", () => {
  it("asks, says it is on screen, and answers with the button pressed", async () => {
    const { dialogs, ask, user } = mainProcess();
    ask(QUIT);
    const dialog = screen.getByRole("dialog", { name: QUIT.title });
    expect(dialog).toHaveAccessibleDescription(QUIT.detail!);
    expect(dialogs.shown).toHaveBeenCalledWith(7);
    // Focus starts on the button that keeps things as they are.
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Stop hosting and quit" }));
    expect(dialogs.answer).toHaveBeenCalledWith(7, 1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("answers with its cancel button on Escape", async () => {
    const { dialogs, ask, user } = mainProcess();
    ask(QUIT);
    await user.keyboard("{Escape}");
    expect(dialogs.answer).toHaveBeenCalledWith(7, 0);
  });

  it("asks one question at a time, and drops one taken back", async () => {
    const { ask, withdraw, user } = mainProcess();
    ask(QUIT);
    ask({ ...QUIT, id: 8, title: "Keep OwnBase open so you can copy what you wrote?" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    withdraw(7);
    const next = screen.getByRole("dialog", {
      name: "Keep OwnBase open so you can copy what you wrote?",
    });
    await user.click(within(next).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says what went wrong away from the window in a notice", () => {
    const { notice } = mainProcess();
    notice("OwnBase could not stop the workspace. Open Manage hosting and try again.");
    expect(screen.getByText(/could not stop the workspace/)).toBeVisible();
  });
});
