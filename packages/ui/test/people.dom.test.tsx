import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { ServerToClient, User } from "@slackoss/protocol";
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

const former: User = {
  ...member,
  id: "U_BO",
  handle: "bo",
  displayName: "Bo Lindqvist",
  deactivated: true,
};

/** The People dialog over a client whose admin API answers from stubs. */
async function people(
  fill: (api: WorkspaceClient["api"]) => void = () => {},
  users: User[] = [owner, member],
) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: owner,
    users: Object.fromEntries(users.map((u) => [u.id, u])),
    status: "online",
  });
  const list = vi.spyOn(client.api, "listAllUsers").mockResolvedValue({
    users: users.map((u) => ({ ...u, lastSeenAt: null })),
  });
  fill(client.api);
  const onClose = vi.fn();
  render(
    <ClientContext.Provider value={client}>
      <PeopleDialog onClose={onClose} />
    </ClientContext.Provider>,
  );
  const dialog = screen.getByRole("dialog", { name: "People" });
  await within(dialog).findByText("@alex");
  await vi.waitFor(() => expect(list).toHaveBeenCalled());
  return { dialog: within(dialog), root: dialog, user: userEvent.setup(), client, onClose, list };
}

/** A user event from the server, heard over the socket. */
function receive(client: WorkspaceClient, seq: number, user: User) {
  const connection = client as unknown as { handleServerMessage(message: ServerToClient): void };
  act(() =>
    connection.handleServerMessage({
      type: "event",
      envelope: { seq, event: { type: "user.joined", user } },
    }),
  );
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

  it("deactivates through the menu, and shows it before the socket says so", async () => {
    const update = vi.fn().mockResolvedValue({ user: { ...member, deactivated: true } });
    const { dialog, user } = await people((api) => {
      vi.spyOn(api, "updateUserAdmin").mockImplementation(update);
    });
    const memberRow = dialog.getByText("@alex").closest("li")!;
    await user.click(within(memberRow).getByRole("button", { name: "Actions for Alex Chen" }));
    await user.click(screen.getByRole("menuitem", { name: "Deactivate" }));
    expect(update).toHaveBeenCalledWith("U_ALEX", { deactivated: true });
    // The answer itself moves Alex under deactivated.
    await vi.waitFor(() => expect(dialog.queryByText("@alex")).toBeNull());
    await user.click(dialog.getByRole("button", { name: "Show 1 deactivated account" }));
    expect(within(dialog.getByText("@alex").closest("li")!).getByText("Deactivated")).toBeVisible();
  });
});

describe("people's load, confirmations and refusals", () => {
  it("lists everyone while last-seen times fail to load, and Try again loads them", async () => {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({
      self: owner,
      users: { U_SAM: owner, U_ALEX: member },
      status: "online",
    });
    const seen = new Date(2026, 0, 5, 9, 30).getTime();
    const list = vi
      .spyOn(client.api, "listAllUsers")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({
        users: [
          { ...owner, lastSeenAt: null },
          { ...member, lastSeenAt: seen },
        ],
      });
    render(
      <ClientContext.Provider value={client}>
        <PeopleDialog onClose={() => {}} />
      </ClientContext.Provider>,
    );
    const dialog = within(screen.getByRole("dialog", { name: "People" }));
    // The rows are the workspace's, so they do not wait for the admin list.
    expect(dialog.getByText("@alex")).toBeVisible();
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "Could not load when people were last here. Try again",
    );
    expect(dialog.queryByRole("button", { name: "Refresh" })).toBeNull();
    await userEvent.setup().click(dialog.getByRole("button", { name: "Try again" }));
    const row = dialog.getByText("@alex").closest("li")!;
    expect(await within(row).findByText(/last seen/)).toBeVisible();
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
    expect(
      await dialog.findByText("Alex Chen now owns this workspace. You are an administrator."),
    ).toHaveAttribute("role", "status");
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

describe("finding people and keeping the list current", () => {
  it("finds a person by name or handle, and says when no one matches", async () => {
    const { dialog, root, user, onClose } = await people(undefined, [owner, member, former]);
    const search = dialog.getByRole("searchbox", { name: "Find a person" });
    expect(search).toHaveFocus();

    await user.type(search, "chen");
    expect(dialog.getByText("@alex")).toBeVisible();
    expect(dialog.queryByText("@sam")).toBeNull();

    // Written as a handle is written, with its @.
    await user.clear(search);
    await user.type(search, "@SA");
    expect(dialog.getByText("@sam")).toBeVisible();
    expect(dialog.queryByText("@alex")).toBeNull();

    await user.clear(search);
    await user.type(search, "zz");
    expect(dialog.getByRole("status")).toHaveTextContent("No one matches \u201czz\u201d.");
    expect(await accessibilityProblems(root)).toEqual([]);

    // A deactivated match is not hidden without saying so.
    await user.clear(search);
    await user.type(search, "lindqvist");
    expect(dialog.getByRole("status")).toHaveTextContent(
      "No active account matches \u201clindqvist\u201d.",
    );
    await user.click(dialog.getByRole("button", { name: "Show 1 deactivated account" }));
    expect(dialog.getByText("@bo")).toBeVisible();

    // Escape empties the search first, and only then closes.
    search.focus();
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.getByText("@alex")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows someone who joins, and a change made elsewhere, as they happen", async () => {
    const { dialog, client, list } = await people();
    expect(dialog.queryByRole("button", { name: "Refresh" })).toBeNull();
    const calls = list.mock.calls.length;

    const jo: User = { ...member, id: "U_JO", handle: "jo", displayName: "Jo Park" };
    receive(client, 1, jo);
    expect(await dialog.findByText("@jo")).toBeVisible();

    receive(client, 2, { ...member, role: "admin" });
    const row = dialog.getByText("@alex").closest("li")!;
    expect(await within(row).findByText(/^Admin/)).toBeVisible();
    // Nothing was fetched for either.
    expect(list).toHaveBeenCalledTimes(calls);
  });

  it("says someone who leaves while the list is open was last seen then", async () => {
    const { dialog, client } = await people();
    act(() => client.store.setState({ presence: { U_ALEX: "online" } }));
    const row = () => dialog.getByText("@alex").closest("li")!;
    expect(within(row()).getByText(/active now/)).toBeVisible();
    act(() => client.store.setState({ presence: { U_ALEX: "offline" } }));
    expect(within(row()).getByText(/last seen/)).toBeVisible();
  });
});
