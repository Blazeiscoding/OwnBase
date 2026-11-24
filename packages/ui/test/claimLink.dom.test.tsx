import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { render } from "./render.js";
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
  protocolVersion: 2,
  serverVersion: "0.0.0-test",
  workspaceName: "Acme",
  userCount: 0,
  requiresInvite: false,
  accessPolicy: "account_required",
  workspaceCopies: false,
  iconVersion: null,
  requiresClaim: true,
};

const web: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

function joinScreen(info: ServerInfo, claimCode?: string) {
  vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
  const onConnected = vi.fn();
  render(
    <JoinScreen
      platform={web}
      savedServers={[]}
      autoProbe="https://acme.ownbase.chat"
      claimCode={claimCode}
      onConnected={onConnected}
      onForget={() => {}}
    />,
  );
  return { onConnected };
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

  it("names the workspace as its first account makes it, before the first invite", async () => {
    const order: string[] = [];
    const register = vi.spyOn(Api.prototype, "register").mockImplementation(async () => {
      order.push("register");
      return { token: "made-now", user: { handle: "riley", role: "owner" } } as never;
    });
    const rename = vi.spyOn(Api.prototype, "renameWorkspace").mockImplementation(async (name) => {
      order.push("rename");
      return { workspaceName: name };
    });
    const { onConnected } = joinScreen(
      { ...unclaimed, workspaceName: "My Workspace" },
      "claim-0123456789abcdef",
    );
    await screen.findByRole("heading", { name: "My Workspace" });
    const name = screen.getByLabelText(/^Workspace name/);
    // The default name is not offered as theirs, and the box comes first.
    expect(name).toHaveValue("");
    expect(name).toHaveFocus();
    expect(await accessibilityProblems()).toEqual([]);

    const user = userEvent.setup();
    await user.type(name, "Riley Studio");
    await user.type(screen.getByLabelText("Username"), "riley");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(order).toEqual(["register", "rename"]);
    expect(rename).toHaveBeenCalledWith("Riley Studio");
    expect(register.mock.calls[0]![0]).not.toHaveProperty("workspaceName");
    expect(onConnected.mock.calls[0]![0]).toMatchObject({ workspaceName: "Riley Studio" });
  });

  it("keeps a name the host already gave, and goes in even if renaming fails", async () => {
    vi.spyOn(Api.prototype, "register").mockResolvedValue({
      token: "made-now",
      user: { handle: "ada", role: "owner" },
    } as never);
    const rename = vi.spyOn(Api.prototype, "renameWorkspace").mockRejectedValue(new Error("down"));
    const { onConnected } = joinScreen(unclaimed, "claim-0123456789abcdef");
    await screen.findByRole("heading", { name: "Acme" });
    expect(screen.getByLabelText(/^Workspace name/)).toHaveValue("Acme");

    const user = userEvent.setup();
    // Left as it was: nothing to rename.
    await user.type(screen.getByLabelText("Username"), "ada");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(rename).not.toHaveBeenCalled();

    // Changed, and refused: the account is made and opened all the same.
    cleanup();
    onConnected.mockClear();
    const second = joinScreen(unclaimed, "claim-0123456789abcdef");
    await screen.findByRole("heading", { name: "Acme" });
    await user.clear(screen.getByLabelText(/^Workspace name/));
    await user.type(screen.getByLabelText(/^Workspace name/), "Acme Labs");
    await user.type(screen.getByLabelText("Username"), "ada");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(second.onConnected).toHaveBeenCalled());
    expect(rename).toHaveBeenCalledWith("Acme Labs");
    expect(second.onConnected.mock.calls[0]![0]).toMatchObject({ workspaceName: "Acme" });
  });

  it("brings nothing to a workspace someone already owns", async () => {
    joinScreen({ ...unclaimed, userCount: 3, requiresClaim: false }, "claim-0123456789abcdef");
    await screen.findByRole("heading", { name: "Acme" });
    expect(screen.queryByLabelText("Workspace claim code")).toBeNull();
    expect(screen.getByRole("tab", { name: "Sign in" })).toHaveAttribute("aria-selected", "true");
  });
});
