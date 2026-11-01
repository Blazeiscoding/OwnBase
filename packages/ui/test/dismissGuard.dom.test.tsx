import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { Dialog } from "../src/components/Dialog.js";
import { useDismissGuard } from "../src/lib/dismissGuard.js";
import { changeNotice } from "../src/components/PeopleDialog.js";

function Held({ held }: { held: boolean }) {
  useDismissGuard(
    held
      ? {
          title: "Close without your codes?",
          body: "Not shown again.",
          confirmLabel: "Close anyway",
        }
      : null,
  );
  return <p>Codes</p>;
}

function shown(held: boolean, onClose: () => void) {
  render(
    <ConfirmProvider>
      <Dialog title="Two-step sign-in" onClose={onClose}>
        <Held held={held} />
      </Dialog>
    </ConfirmProvider>,
  );
}

describe("a dialog holding something shown once", () => {
  it("asks before Escape or its close button put it away, and stays when told to", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    shown(true, onClose);
    await screen.findByText("Codes");

    await user.keyboard("{Escape}");
    const ask = await screen.findByRole("dialog", { name: "Close without your codes?" });
    expect(ask).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Close without your codes?" })).toBeNull(),
    );
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(await screen.findByRole("button", { name: "Close anyway" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("closes at once with nothing held", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    shown(false, onClose);
    await screen.findByText("Codes");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("what an account change says", () => {
  it("names the person and what changed", () => {
    expect(changeNotice("Sam", { role: "admin" })).toBe("Sam is now an admin.");
    expect(changeNotice("Sam", { deactivated: true })).toBe(
      "Sam is deactivated and signed out everywhere.",
    );
    expect(changeNotice("Sam", { canInvite: false })).toBe("Sam can no longer invite people.");
  });
});
