import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Api, ApiError } from "@ownbase/client-core";
import type { ServerInfo } from "@ownbase/protocol";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import type { Platform } from "../src/platform.js";

/** Creating an account while an admin changes who may join: the invite withdrawn, or invites required. */
const info = (requiresInvite: boolean): ServerInfo => ({
  app: "ownbase",
  protocolVersion: 2,
  serverVersion: "0.0.0-test",
  workspaceName: "Rocket Team",
  userCount: 4,
  requiresInvite,
  requiresClaim: false,
  accessPolicy: requiresInvite ? "invite_only" : "account_required",
  workspaceCopies: false,
  iconVersion: null,
});

const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

async function joinCard(requiresInvite: boolean, inviteCode?: string) {
  vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info(requiresInvite));
  const register = vi
    .spyOn(Api.prototype, "register")
    .mockRejectedValue(
      new ApiError(403, "invite_required", "This workspace needs a valid invite code to join."),
    );
  render(
    <JoinScreen
      platform={platform}
      savedServers={[]}
      autoProbe="http://127.0.0.1:9"
      inviteCode={inviteCode}
      onConnected={() => {}}
      onForget={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Rocket Team" });
  await waitFor(() => expect(screen.getByLabelText("Username")).toHaveFocus());
  const user = userEvent.setup();
  if (!inviteCode) await user.click(screen.getByRole("tab", { name: "Create account" }));
  await user.type(screen.getByLabelText("Username"), "newbie");
  await user.type(screen.getByLabelText("Password"), "a-long-password");
  return { register, user };
}

afterEach(() => vi.restoreAllMocks());

describe("joining with an invite that stopped working", () => {
  it("says the code no longer works, not that one is needed, when it came with the link", async () => {
    const { register, user } = await joinCard(true, "ABCD1234");
    await user.click(screen.getByRole("button", { name: "Join workspace" }));
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ inviteCode: "ABCD1234" }));
    expect(
      await screen.findByText(
        "That invite code no longer works. It may have been withdrawn, used up or run out. Ask whoever invited you for a new one.",
      ),
    ).toBeTruthy();
    // Left as typed, to send again with a new code put in its place.
    expect(screen.getByLabelText("Invite code")).toHaveValue("ABCD1234");
    expect(screen.getByLabelText("Username")).toHaveValue("newbie");
  });

  it("brings the code's field when the workspace became invite-only after the page opened", async () => {
    const { user } = await joinCard(false);
    expect(screen.queryByLabelText("Invite code")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Join workspace" }));
    expect(
      await screen.findByText(
        "This workspace needs an invite code to join. Ask whoever invited you for one.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Invite code")).toHaveValue("");
  });
});
