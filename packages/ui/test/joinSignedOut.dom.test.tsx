import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { render } from "./render.js";
import userEvent from "@testing-library/user-event";
import { Api, ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { ServerInfo } from "@ownbase/protocol";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import { signedOutHow, type SignedOutFrom } from "../src/lib/signOut.js";
import type { HostingStatus, Platform, SavedServer } from "../src/platform.js";

/**
 * A workspace that ends a sign-in (another device signed this one out, the
 * password changed, the sign-in ran out) says so on the form that follows,
 * with the username already there, rather than leaving a blank form that
 * looks like nothing happened.
 */
const info: ServerInfo = {
  app: "ownbase",
  protocolVersion: 2,
  serverVersion: "0.0.0-test",
  workspaceName: "Rocket Team",
  userCount: 4,
  requiresInvite: false,
  accessPolicy: "account_required",
  workspaceCopies: false,
  iconVersion: null,
  requiresClaim: false,
};
const rocket: SavedServer = {
  url: "http://rocket.test:8543",
  token: "test-token-not-a-credential",
  workspaceName: "Rocket Team",
  handle: "sam",
  lastUsedAt: 2,
};
const stopped: HostingStatus = { running: false, phase: "stopped", backgroundAvailable: true };
const platform: Platform = {
  kind: "desktop",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

function renderJoin(props: { savedServers?: SavedServer[]; signedOut?: SignedOutFrom }) {
  return render(
    <JoinScreen
      platform={platform}
      savedServers={props.savedServers ?? []}
      signedOut={props.signedOut}
      onConnected={() => {}}
      onForget={() => {}}
      hostingStatus={stopped}
      lastHosted={null}
    />,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("a sign-in the workspace ended", () => {
  it("opens that workspace's form, says why, and leaves only the password to type", async () => {
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    renderJoin({
      signedOut: { url: rocket.url, handle: "sam", workspaceName: "Rocket Team" },
    });

    expect(await screen.findByText(/You were signed out of Rocket Team/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Username").value).toBe("sam");
    // The form takes focus in an effect, which a busy machine runs after the notice is drawn.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Password")));
  });

  it("says so too when a saved sign-in no longer works", async () => {
    const user = userEvent.setup();
    vi.spyOn(Api.prototype, "me").mockRejectedValue(new ApiError(401, "unauthorized"));
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    renderJoin({ savedServers: [rocket] });

    await user.click(screen.getByRole("button", { name: /Rocket Team.*@sam/ }));

    expect(await screen.findByText(/You were signed out of Rocket Team/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Username").value).toBe("sam");
  });

  it("tells a guest the visit is over, without offering the guest's name as a username", async () => {
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    renderJoin({
      signedOut: { url: rocket.url, handle: "guest-k2", workspaceName: "Rocket Team" },
    });

    expect(await screen.findByText(/Your guest visit to Rocket Team has ended/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Username").value).toBe("");
  });

  it("forgets the note on the way back to the list", async () => {
    const user = userEvent.setup();
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    renderJoin({
      savedServers: [{ ...rocket, token: "test-other-token-not-a-credential" }],
      signedOut: { url: rocket.url, handle: "sam", workspaceName: "Rocket Team" },
    });

    await screen.findByText(/You were signed out/);
    await user.click(screen.getByRole("button", { name: /All workspaces/ }));
    expect(screen.queryByText(/You were signed out/)).toBeNull();
  });
});

describe("why a workspace stopped", () => {
  const client = () => new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");

  it("is news when the server ended the sign-in", () => {
    expect(signedOutHow(client(), "auth_failed")).toBe("ended");
  });

  it("is not news while this window signs out on purpose", async () => {
    const leaving = client();
    let during: string | undefined = "unset";
    vi.spyOn(leaving.api, "logout").mockImplementation(async () => {
      during = signedOutHow(leaving, "auth_failed");
      return { ok: true };
    });
    await leaving.signOut();
    expect(during).toBeUndefined();
    expect(signedOutHow(leaving, "auth_failed")).toBeUndefined();
  });

  it("is news again after a sign-out that failed", async () => {
    const staying = client();
    vi.spyOn(staying.api, "logout").mockRejectedValue(new Error("offline"));
    await expect(staying.signOut()).rejects.toThrow("offline");
    expect(signedOutHow(staying, "auth_failed")).toBe("ended");
  });

  it("is never news for a password that must be replaced", () => {
    expect(signedOutHow(client(), "password_change_required")).toBeUndefined();
  });
});
