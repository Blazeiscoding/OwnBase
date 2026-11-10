import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { SessionInfo, User } from "@ownbase/protocol";
import { AccountDialog } from "../src/components/AccountDialog.js";
import type { AccountSection } from "../src/lib/accountSections.js";
import { renderPart } from "./workspaceParts.js";

/**
 * Account settings' Security and Devices sections: a password change checked
 * before it is sent and explained when refused, and every sign-out asking
 * first, with Cancel leaving everything signed in.
 */
const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const session = (id: string, current: boolean, userAgent: string): SessionInfo => ({
  id,
  current,
  userAgent,
  createdAt: Date.UTC(2026, 8, 1),
  lastSeenAt: Date.UTC(2026, 8, 26),
  expiresAt: Date.UTC(2026, 11, 1),
});

// jsdom lays nothing out, so it has no scrolling to do.
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => vi.restoreAllMocks());

function account(section: AccountSection) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
  const api = {
    sessions: vi.spyOn(client.api, "listSessions").mockResolvedValue({
      sessions: [
        session("S1", true, "OwnBase desktop"),
        session("S2", false, "Mozilla/5.0 (iPhone)"),
      ],
    }),
    password: vi.spyOn(client.api, "changePassword").mockResolvedValue({ ok: true } as never),
    logout: vi.spyOn(client.api, "logout").mockResolvedValue({ ok: true } as never),
    revokeOthers: vi
      .spyOn(client.api, "revokeOtherSessions")
      .mockResolvedValue({ revoked: 1 } as never),
    // Security also says whether two-step sign-in is on (E11).
    twoStep: vi.spyOn(client.api, "twoStep").mockResolvedValue({
      enabled: false,
      recoveryCodesLeft: 0,
    }),
  };
  const onSignedOut = vi.fn();
  renderPart(client, <AccountDialog onClose={() => {}} section={section} />, {
    shell: { onSignedOut },
  });
  const dialog = within(screen.getByRole("dialog", { name: "Account settings" }));
  return { api, dialog, onSignedOut, user: userEvent.setup() };
}

describe("changing a password", () => {
  async function fill(
    dialog: ReturnType<typeof account>["dialog"],
    user: ReturnType<typeof userEvent.setup>,
    current: string,
    next: string,
    repeat: string,
  ) {
    // Set rather than typed: the keystrokes are not what is under test.
    fireEvent.change(dialog.getByLabelText("Current password"), { target: { value: current } });
    fireEvent.change(dialog.getByLabelText("New password"), { target: { value: next } });
    fireEvent.change(dialog.getByLabelText("Confirm new password"), { target: { value: repeat } });
    await user.click(dialog.getByRole("button", { name: "Update password" }));
  }

  it("catches a mistyped repeat, or the same password again, before asking the server", async () => {
    const { api, dialog, user } = account("security");
    await fill(dialog, user, "old-password", "new-password-1", "new-password-2");
    expect(dialog.getByRole("alert")).toHaveTextContent("The new passwords do not match.");

    await fill(dialog, user, "old-password", "old-password", "old-password");
    expect(dialog.getByRole("alert")).toHaveTextContent(
      "Choose a different password from your current one.",
    );
    expect(api.password).not.toHaveBeenCalled();
  });

  it("keeps what was typed and says so when the current password is wrong", async () => {
    const { api, dialog, user } = account("security");
    api.password.mockRejectedValueOnce(new ApiError(403, "invalid_credentials"));
    await fill(dialog, user, "not-it", "new-password-1", "new-password-1");
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "Your current password was not accepted.",
    );
    expect(dialog.getByLabelText("New password")).toHaveValue("new-password-1");
  });

  it("clears the fields and says the other devices were signed out once it changes", async () => {
    const { api, dialog, user } = account("security");
    await fill(dialog, user, "old-password", "new-password-1", "new-password-1");
    expect(api.password).toHaveBeenCalledWith("old-password", "new-password-1");
    expect(await dialog.findByRole("status")).toHaveTextContent(
      "Password changed. Your other devices are signed out. This device stays signed in.",
    );
    expect(dialog.getByLabelText("Current password")).toHaveValue("");
    expect(dialog.getByLabelText("New password")).toHaveValue("");
  });
});

describe("signing out", () => {
  it("asks before signing out of the workspace, as the account menu does, and Cancel keeps you signed in", async () => {
    const { api, dialog, onSignedOut, user } = account("security");
    await user.click(dialog.getByRole("button", { name: "Sign out of this workspace" }));
    let asking = await screen.findByRole("dialog", { name: "Sign out of this workspace?" });
    expect(asking).toHaveTextContent("You will need your password to sign in again.");
    await user.click(within(asking).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Sign out of this workspace?" })).toBeNull(),
    );
    expect(api.logout).not.toHaveBeenCalled();

    await user.click(dialog.getByRole("button", { name: "Sign out of this workspace" }));
    asking = await screen.findByRole("dialog", { name: "Sign out of this workspace?" });
    await user.click(within(asking).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledOnce());
    expect(api.logout).toHaveBeenCalledOnce();
  });

  it("asks before signing out every other device, then drops them from the list", async () => {
    const { api, dialog, user } = account("devices");
    await user.click(await dialog.findByRole("button", { name: "Sign out all other devices" }));
    expect(dialog.getByRole("region", { name: "Confirm sign out" })).toHaveTextContent(
      "Sign out your other devices?",
    );
    api.sessions.mockResolvedValue({ sessions: [session("S1", true, "OwnBase desktop")] });
    await user.click(dialog.getByRole("button", { name: "Confirm sign out" }));
    expect(api.revokeOthers).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(dialog.queryByRole("button", { name: "Sign out all other devices" })).toBeNull(),
    );
    expect(
      within(dialog.getByRole("list", { name: "Signed-in devices" })).getAllByRole("listitem"),
    ).toHaveLength(1);
    expect(await dialog.findByText("Your other devices have been signed out.")).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("stays signed in, and says so, when the workspace cannot be reached", async () => {
    const { api, dialog, onSignedOut, user } = account("security");
    api.logout.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await user.click(dialog.getByRole("button", { name: "Sign out of this workspace" }));
    const asking = await screen.findByRole("dialog", { name: "Sign out of this workspace?" });
    await user.click(within(asking).getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText(/You are still signed in/)).toHaveTextContent(
      "You are still signed in. Check your connection and try again.",
    );
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Account settings" })).toBeVisible();
  });
});
