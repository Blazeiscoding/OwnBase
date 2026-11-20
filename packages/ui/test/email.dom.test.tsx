import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Api, ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { ServerInfo, User } from "@ownbase/protocol";
import { render } from "./render.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { EmailSettings } from "../src/components/EmailSettings.js";
import { InviteByEmail } from "../src/components/InviteByEmail.js";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import { parseDeepLink } from "../src/lib/deeplink.js";
import { confirmEmailLink } from "../src/lib/emailLinks.js";
import type { Platform, SavedServer } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Email in the app (G10): "Forgot your password?" and the mailed link that
 * sets a new one, the link that confirms an address, the address in Account
 * settings, and sending an invite by email. Where the workspace sends no
 * email, none of it shows.
 */
const URL_ = "https://chat.example.test";
const TOKEN = "a1".repeat(24);
const info = (over: Partial<ServerInfo> = {}): ServerInfo => ({
  app: "ownbase",
  protocolVersion: 2,
  serverVersion: "0.0.0-test",
  workspaceName: "Rocket Team",
  userCount: 3,
  requiresInvite: false,
  accessPolicy: "account_required",
  workspaceCopies: false,
  iconVersion: null,
  requiresClaim: false,
  email: true,
  ...over,
});
const maya: User = {
  id: "U_MAYA",
  handle: "maya",
  displayName: "Maya Lin",
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};
const shell: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
});

function joinScreen(given: ServerInfo, opts: { resetToken?: string; saved?: SavedServer[] } = {}) {
  vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(given);
  render(
    <PlatformContext.Provider value={shell}>
      <JoinScreen
        platform={shell}
        savedServers={opts.saved ?? []}
        autoProbe={URL_}
        resetToken={opts.resetToken}
        onConnected={() => {}}
        onForget={() => {}}
      />
    </PlatformContext.Provider>,
  );
  return userEvent.setup();
}

function workspace(given: ServerInfo) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: maya,
    users: { U_MAYA: maya },
    status: "online",
    workspaceName: "Rocket Team",
    accessPolicy: "account_required",
  });
  vi.spyOn(client.api, "serverInfo").mockResolvedValue(given);
  return client;
}

describe("links from mail", () => {
  it("read as a new password's link or an address's, and nothing else", () => {
    expect(parseDeepLink(`${URL_}/#/reset/${TOKEN}`)).toEqual({
      kind: "reset",
      serverUrl: URL_,
      token: TOKEN,
    });
    expect(parseDeepLink(`${URL_}/#/verify-email/${TOKEN}`)).toEqual({
      kind: "verifyEmail",
      serverUrl: URL_,
      token: TOKEN,
    });
    expect(parseDeepLink(`${URL_}/#/reset/`)).toBeNull();
    expect(parseDeepLink(`${URL_}/#/reset/${TOKEN}/more`)).toBeNull();
    expect(parseDeepLink(`${URL_}/#/verify-email/not%20a%20token`)).toBeNull();
  });

  it("confirming an address says so, or why not", async () => {
    vi.spyOn(Api.prototype, "confirmEmail").mockResolvedValueOnce({ email: "maya@example.test" });
    expect(await confirmEmailLink(URL_, TOKEN)).toEqual({
      ok: true,
      message:
        "Your email address maya@example.test is confirmed. A link to set a new password can go to it now.",
    });
    vi.spyOn(Api.prototype, "confirmEmail").mockRejectedValueOnce(
      new ApiError(410, "email_link_gone"),
    );
    expect(await confirmEmailLink(URL_, TOKEN)).toEqual({
      ok: false,
      message:
        "This link no longer works. It may have been used already or be too old. Ask for a new one.",
    });
  });
});

describe("forgot your password", () => {
  it("is not offered where the workspace sends no email", async () => {
    joinScreen(info({ email: false }));
    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByRole("button", { name: "Forgot your password?" })).toBeNull();
    cleanup();
    joinScreen(info({ email: undefined }));
    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByRole("button", { name: "Forgot your password?" })).toBeNull();
  });

  it("asks for the address, and answers the same whoever it belongs to", async () => {
    const forgot = vi.spyOn(Api.prototype, "forgotPassword").mockResolvedValue({ ok: true });
    const user = joinScreen(info());
    await user.click(await screen.findByRole("button", { name: "Forgot your password?" }));
    const field = screen.getByLabelText("Email address");
    expect(field).toHaveFocus();
    expect(await accessibilityProblems()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the email address on your account");
    expect(forgot).not.toHaveBeenCalled();
    await user.type(field, "maya@example.test");
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "If an account here uses maya@example.test, a link to set a new password is on its way to it.",
    );
    expect(forgot).toHaveBeenCalledWith("maya@example.test");
    await user.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(screen.getByLabelText("Username")).toBeVisible();
  });
});

describe("a mailed link to set a new password", () => {
  it("sets it, then asks for a sign-in with it, the saved one not reopened", async () => {
    const me = vi.spyOn(Api.prototype, "me");
    const reset = vi
      .spyOn(Api.prototype, "resetPasswordWithLink")
      .mockResolvedValue({ handle: "maya" });
    const saved: SavedServer = {
      url: URL_,
      token: "older-token",
      workspaceName: "Rocket Team",
      // Another account on this device: the link says whose password it set.
      handle: "sam",
      lastUsedAt: 1,
    };
    const user = joinScreen(info(), { resetToken: TOKEN, saved: [saved] });
    const fresh = await screen.findByLabelText("New password");
    expect(fresh).toHaveFocus();
    expect(me).not.toHaveBeenCalled();
    await user.type(fresh, "password456");
    await user.type(screen.getByLabelText("Confirm new password"), "password457");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Those two do not match.");
    await user.clear(screen.getByLabelText("Confirm new password"));
    await user.type(screen.getByLabelText("Confirm new password"), "password456");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    expect(reset).toHaveBeenCalledWith(TOKEN, "password456");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your new password is set, and every device was signed out. Sign in with it.",
    );
    expect(screen.getByLabelText("Username")).toHaveValue("maya");
  });

  it("says when the link no longer works, and goes back to sign in", async () => {
    vi.spyOn(Api.prototype, "resetPasswordWithLink").mockRejectedValue(
      new ApiError(410, "email_link_gone"),
    );
    const user = joinScreen(info(), { resetToken: TOKEN });
    await user.type(await screen.findByLabelText("New password"), "password456");
    await user.type(screen.getByLabelText("Confirm new password"), "password456");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This link no longer works.");
    await user.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(screen.getByLabelText("Username")).toBeVisible();
  });
});

describe("the email address in Account settings", () => {
  const settings = (client: WorkspaceClient) =>
    render(
      <ClientContext.Provider value={client}>
        <ConfirmProvider>
          <EmailSettings />
        </ConfirmProvider>
      </ClientContext.Provider>,
    );

  it("is not there where the workspace sends no email", async () => {
    const client = workspace(info({ email: false }));
    const asked = vi.spyOn(client.api, "emailAddress");
    settings(client);
    await waitFor(() => expect(client.api.serverInfo).toHaveBeenCalled());
    expect(asked).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Email address" })).toBeNull();
  });

  it("is not there, and says nothing, when the workspace cannot be asked", async () => {
    const client = workspace(info());
    vi.mocked(client.api.serverInfo).mockRejectedValue(new ApiError(0, "network_error"));
    settings(client);
    await waitFor(() => expect(client.api.serverInfo).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("heading", { name: "Email address" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is added with the password, and waits for its link to be opened", async () => {
    const client = workspace(info());
    const read = vi
      .spyOn(client.api, "emailAddress")
      .mockResolvedValue({ email: null, verifiedAt: null, pending: null });
    const set = vi.spyOn(client.api, "setEmailAddress").mockResolvedValue({ ok: true });
    settings(client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add email address" }));
    await user.type(screen.getByLabelText("New email address"), "maya@example.test");
    await user.type(screen.getByLabelText("Current password"), "password123");
    read.mockResolvedValue({ email: null, verifiedAt: null, pending: "maya@example.test" });
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect(set).toHaveBeenCalledWith("maya@example.test", "password123");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "A link is on its way to maya@example.test. Open it to confirm the address.",
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    // Said once: the notice, rather than the notice and the waiting line too.
    expect(screen.queryByText(/Waiting for you to open the link/)).toBeNull();

    // Opened again later, the address is still waiting on its link.
    cleanup();
    settings(client);
    expect(
      await screen.findByText(
        "Waiting for you to open the link sent to maya@example.test. It works for 24 hours.",
      ),
    ).toBeVisible();
  });
});

describe("sending an invite by email", () => {
  const invite = (client: WorkspaceClient) =>
    render(
      <ClientContext.Provider value={client}>
        <ToastProvider>
          <InviteByEmail code="ABCD2345" />
        </ToastProvider>
      </ClientContext.Provider>,
    );

  it("is not offered where the workspace sends no email", async () => {
    const client = workspace(info({ email: false }));
    invite(client);
    await waitFor(() => expect(client.api.serverInfo).toHaveBeenCalled());
    expect(screen.queryByLabelText("Send the link by email")).toBeNull();
  });

  it("sends the invite's link, and says when the invite no longer works", async () => {
    const client = workspace(info());
    const send = vi.spyOn(client.api, "emailInvite").mockResolvedValue({ ok: true });
    invite(client);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Send the link by email"), "sam@example.test");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(send).toHaveBeenCalledWith("ABCD2345", "sam@example.test");
    expect(await screen.findByText("Invite sent to sam@example.test.")).toBeVisible();
    send.mockRejectedValue(new ApiError(409, "invite_inactive"));
    await user.type(screen.getByLabelText("Send the link by email"), "sam@example.test");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That invite no longer works. Make a new link and send that.",
    );
  });
});
