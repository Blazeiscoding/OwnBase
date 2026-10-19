import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { PeopleDialog } from "../src/components/PeopleDialog.js";
import { accessibilityProblems } from "./accessibility.js";

const owner: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "owner",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
  canInvite: true,
};

const member: User = {
  id: "U_ALEX",
  handle: "alex",
  displayName: "Alex Chen",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
  canInvite: true,
};

/** The People dialog over a client whose admin API answers from stubs. */
async function people(fill: (api: WorkspaceClient["api"]) => void = () => {}) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: owner, users: { U_SAM: owner, U_ALEX: member }, status: "online" });
  vi.spyOn(client.api, "listAllUsers").mockResolvedValue({
    users: [
      { ...owner, lastSeenAt: null },
      { ...member, lastSeenAt: null },
    ],
  });
  fill(client.api);
  render(
    <ClientContext.Provider value={client}>
      <PeopleDialog onClose={() => {}} />
    </ClientContext.Provider>,
  );
  const dialog = screen.getByRole("dialog", { name: "People" });
  await within(dialog).findByText("@alex");
  return { dialog: within(dialog), root: dialog, user: userEvent.setup(), client };
}

describe("people actions", () => {
  it("offers one menu per person instead of a row of buttons", async () => {
    const { dialog, root, user } = await people();
    // The owner's own row offers nothing: you cannot lock yourself out.
    const ownerRow = dialog.getByText("@sam").closest("li")!;
    expect(within(ownerRow).queryByRole("button")).toBeNull();

    const memberRow = dialog.getByText("@alex").closest("li")!;
    const actions = within(memberRow).getByRole("button", { name: "Actions for Alex Chen" });
    await user.click(actions);
    const menu = screen.getByRole("menu", { name: "Actions for Alex Chen" });
    for (const item of [
      "Make admin",
      "Stop inviting",
      "Deactivate",
      "Reset password",
      "Transfer ownership",
    ]) {
      expect(within(menu).getByRole("menuitem", { name: item })).toBeVisible();
    }
    expect(await accessibilityProblems(root)).toEqual([]);
  });

  it("deactivates through the menu", async () => {
    const update = vi.fn().mockResolvedValue({ user: { ...member, deactivated: true } });
    const { dialog, user } = await people((api) => {
      vi.spyOn(api, "updateUserAdmin").mockImplementation(update);
    });
    const memberRow = dialog.getByText("@alex").closest("li")!;
    await user.click(within(memberRow).getByRole("button", { name: "Actions for Alex Chen" }));
    await user.click(screen.getByRole("menuitem", { name: "Deactivate" }));
    expect(update).toHaveBeenCalledWith("U_ALEX", { deactivated: true });
  });
});

describe("people's load, confirmations and refusals", () => {
  it("says the list could not load, and Refresh loads it", async () => {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({ self: owner, users: { U_SAM: owner }, status: "online" });
    const list = vi
      .spyOn(client.api, "listAllUsers")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({
        users: [
          { ...owner, lastSeenAt: null },
          { ...member, lastSeenAt: null },
        ],
      });
    render(
      <ClientContext.Provider value={client}>
        <PeopleDialog onClose={() => {}} />
      </ClientContext.Provider>,
    );
    const dialog = within(screen.getByRole("dialog", { name: "People" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "Could not load the member list. Try refreshing.",
    );
    await userEvent.setup().click(dialog.getByRole("button", { name: "Refresh" }));
    expect(await dialog.findByText("@alex")).toBeVisible();
    expect(dialog.queryByRole("alert")).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("asks before resetting a password, then shows the temporary one hidden until asked", async () => {
    const reset = vi.fn().mockResolvedValue({ temporaryPassword: "temp-horse-battery" });
    const { dialog, user } = await people((api) => {
      vi.spyOn(api, "resetPassword").mockImplementation(reset);
    });
    const row = dialog.getByText("@alex").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Actions for Alex Chen" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset password" }));
    expect(dialog.getByRole("heading", { name: "Reset Alex Chen's password?" })).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(reset).not.toHaveBeenCalled();

    await user.click(
      within(dialog.getByText("@alex").closest("li")!).getByRole("button", {
        name: "Actions for Alex Chen",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Reset password" }));
    await user.click(dialog.getByRole("button", { name: "Reset password" }));
    expect(reset).toHaveBeenCalledWith("U_ALEX");
    const shown = await dialog.findByLabelText("Temporary password");
    expect(shown).toHaveValue("temp-horse-battery");
    expect(shown).toHaveAttribute("type", "password");
    await user.click(dialog.getByRole("button", { name: "Show password" }));
    expect(shown).toHaveAttribute("type", "text");
    await user.click(dialog.getByRole("button", { name: "Done" }));
    expect(dialog.queryByLabelText("Temporary password")).toBeNull();
  });

  it("transfers ownership only once the new owner's handle is typed, saying what is missing", async () => {
    const transfer = vi.fn().mockResolvedValue({
      owner: { ...member, role: "owner" },
      previousOwner: { ...owner, role: "admin" },
    });
    const { dialog, user, client } = await people((api) => {
      vi.spyOn(api, "transferOwnership").mockImplementation(transfer);
    });
    const row = dialog.getByText("@alex").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Actions for Alex Chen" }));
    await user.click(screen.getByRole("menuitem", { name: "Transfer ownership" }));
    const confirm = dialog.getByRole("button", { name: "Transfer ownership" });
    const typed = dialog.getByLabelText("Type alex to confirm");
    // Never off for want of the handle: pressed without it, it says so under the field.
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(transfer).not.toHaveBeenCalled();
    expect(typed).toHaveFocus();
    expect(typed).toHaveAttribute("aria-invalid", "true");
    expect(typed).toHaveAccessibleDescription("Type alex to confirm.");

    await user.type(typed, "Alex");
    expect(typed).not.toHaveAttribute("aria-invalid");
    await user.keyboard("{Enter}");
    expect(transfer).not.toHaveBeenCalled();
    expect(typed).toHaveAccessibleDescription("That isn't alex. Type it exactly to confirm.");

    await user.clear(typed);
    await user.type(typed, "alex");
    await user.click(confirm);
    expect(transfer).toHaveBeenCalledWith("U_ALEX");
    expect(await dialog.findByRole("status")).toHaveTextContent(
      "Alex Chen now owns this workspace. You are an administrator.",
    );
    expect(client.state.self?.role).toBe("admin");
  });

  it("says why a change was refused, in words", async () => {
    const { dialog, user } = await people((api) => {
      vi.spyOn(api, "updateUserAdmin").mockRejectedValue(new ApiError(403, "admins_are_equals"));
    });
    const row = dialog.getByText("@alex").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Actions for Alex Chen" }));
    await user.click(screen.getByRole("menuitem", { name: "Deactivate" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "Only the owner can change another admin.",
    );
  });
});
