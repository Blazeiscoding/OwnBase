import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Api } from "@ownbase/client-core";
import type { ServerInfo } from "@ownbase/protocol";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * A link to claim a workspace nobody owns yet, <server>/#/claim/<code>, as
 * OwnBase's hosting sends a new workspace's owner (P7): it opens on creating
 * the account, with the claim code filled in.
 */
const unclaimed: ServerInfo = {
  app: "ownbase",
  protocolVersion: 1,
  serverVersion: "0.0.0-test",
  workspaceName: "Acme",
  userCount: 0,
  requiresInvite: false,
  requiresClaim: true,
};

const web: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

function joinScreen(info: ServerInfo, claimCode?: string) {
  vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
  render(
    <JoinScreen
      platform={web}
      savedServers={[]}
      autoProbe="https://acme.ownbase.chat"
      claimCode={claimCode}
      onConnected={() => {}}
      onForget={() => {}}
    />,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("a link to claim a workspace", () => {
  it("opens on creating the account, with the claim code filled in and sent", async () => {
    const register = vi.spyOn(Api.prototype, "register").mockRejectedValue(new Error("stop here"));
    joinScreen(unclaimed, "claim-0123456789abcdef");
    await screen.findByRole("heading", { name: "Acme" });
    const code = screen.getByLabelText("Workspace claim code");
    expect(code).toHaveValue("claim-0123456789abcdef");
    expect(code).toHaveAccessibleDescription(
      "Filled in from your link. It makes this account the workspace's owner.",
    );
    expect(await accessibilityProblems()).toEqual([]);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "ada");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: /^(Join workspace|Create workspace)$/ }));
    await waitFor(() => expect(register).toHaveBeenCalled());
    expect(register.mock.calls[0]![0]).toMatchObject({
      handle: "ada",
      claimCode: "claim-0123456789abcdef",
    });
  });

  it("brings nothing to a workspace someone already owns", async () => {
    joinScreen({ ...unclaimed, userCount: 3, requiresClaim: false }, "claim-0123456789abcdef");
    await screen.findByRole("heading", { name: "Acme" });
    expect(screen.queryByLabelText("Workspace claim code")).toBeNull();
    expect(screen.getByRole("tab", { name: "Sign in" })).toHaveAttribute("aria-selected", "true");
  });
});
