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
    // Where to get a new one: Account settings, under Security.
    expect(await confirmEmailLink(URL_, TOKEN)).toEqual({
      ok: false,
      message:
        "This link was already used or is too old. If your address isn't confirmed yet, send a new link from Account settings, under Security.",
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

  it("says what to do without an address on the account", async () => {
    const user = joinScreen(info());
    await user.click(await screen.findByRole("button", { name: "Forgot your password?" }));
    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeVisible();
    expect(
      screen.getByText(
        "If you added an email address in Account settings, enter it and a link to set a new password goes to it. If you didn't, ask an admin of this workspace to reset it.",
      ),
    ).toBeVisible();
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
    // Tied to the field it is about.
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(/Enter the email address on your account/);
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
    const check = vi.spyOn(Api.prototype, "checkResetLink").mockResolvedValue({ ok: true });
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
    expect(check).toHaveBeenCalledWith(TOKEN);
    expect(screen.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
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

  const GONE =
    "This link was already used or is more than 30 minutes old. Send yourself a new one.";

  it("says when the link stops working while the form is open, and goes back to sign in", async () => {
    vi.spyOn(Api.prototype, "checkResetLink").mockResolvedValue({ ok: true });
    vi.spyOn(Api.prototype, "resetPasswordWithLink").mockRejectedValue(
      new ApiError(410, "email_link_gone"),
    );
    const user = joinScreen(info(), { resetToken: TOKEN });
    await user.type(await screen.findByLabelText("New password"), "password456");
    await user.type(screen.getByLabelText("Confirm new password"), "password456");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(GONE);
    await user.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(screen.getByLabelText("Username")).toBeVisible();
  });

  it("says a used or old link no longer works as soon as it opens, and sends a new one", async () => {
    vi.spyOn(Api.prototype, "checkResetLink").mockRejectedValue(
      new ApiError(410, "email_link_gone"),
    );
    const reset = vi.spyOn(Api.prototype, "resetPasswordWithLink");
    const user = joinScreen(info(), { resetToken: TOKEN });
    expect(await screen.findByRole("alert")).toHaveTextContent(GONE);
    expect(screen.queryByLabelText("New password")).toBeNull();
    const again = screen.getByRole("button", { name: "Send a new link" });
    expect(again).toHaveFocus();
    expect(again.className).toContain("bg-copper ");
    expect(screen.getByRole("button", { name: "Back to sign in" }).className).not.toContain(
      "bg-copper ",
    );
    expect(await accessibilityProblems()).toEqual([]);
    await user.click(again);
    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeVisible();
    expect(screen.getByLabelText("Email address")).toHaveFocus();
    expect(reset).not.toHaveBeenCalled();
  });

  it("shows the form when the link cannot be checked, and lets setting it say", async () => {
    vi.spyOn(Api.prototype, "checkResetLink").mockRejectedValue(new ApiError(0, "network_error"));
    joinScreen(info(), { resetToken: TOKEN });
    expect(await screen.findByLabelText("New password")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
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
    // One "Current password" in Security is the password form's.
    expect(screen.queryByLabelText("Current password")).toBeNull();
    const password = screen.getByLabelText("Your password");
    expect(password).toHaveAccessibleDescription("To check it's you.");
    await user.type(password, "password123");
    read.mockResolvedValue({ email: null, verifiedAt: null, pending: "maya@example.test" });
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect(set).toHaveBeenCalledWith("maya@example.test", "password123");
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(
      "A link is on its way to maya@example.test. Open it to confirm the address.",
    );
    // News, not success: the address does not count yet.
    expect(notice.className).not.toContain("text-online");
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    // Said once: the notice, rather than the notice and the waiting line too.
    expect(screen.queryByText(/isn't confirmed yet/)).toBeNull();

    // Opened again later, the address is still waiting on its link.
    cleanup();
    settings(client);
    expect(
      await screen.findByText(
        "maya@example.test isn't confirmed yet. Open the link sent to it within 24 hours.",
      ),
    ).toBeVisible();
  });

  it("while an address waits, sends its link again or takes a different one", async () => {
    const client = workspace(info());
    vi.spyOn(client.api, "emailAddress").mockResolvedValue({
      email: null,
      verifiedAt: null,
      pending: "maya@example.test",
    });
    const resend = vi.spyOn(client.api, "resendEmailLink").mockResolvedValue({ ok: true });
    settings(client);
    const user = userEvent.setup();
    const waiting = await screen.findByText(
      "maya@example.test isn't confirmed yet. Open the link sent to it within 24 hours.",
    );
    expect(waiting.className).not.toContain("text-online");
    expect(screen.queryByText(/Add one so that/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add email address" })).toBeNull();
    expect(await accessibilityProblems()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Send the link again" }));
    expect(resend).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "A new link is on its way to maya@example.test. Open it within 24 hours.",
    );

    await user.click(screen.getByRole("button", { name: "Use a different address" }));
    expect(screen.getByLabelText("New email address")).toHaveFocus();
  });

  it("ties each mistake to its field", async () => {
    const client = workspace(info());
    vi.spyOn(client.api, "emailAddress").mockResolvedValue({
      email: null,
      verifiedAt: null,
      pending: null,
    });
    const set = vi
      .spyOn(client.api, "setEmailAddress")
      .mockRejectedValue(new ApiError(403, "invalid_credentials", "That is not your password."));
    settings(client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add email address" }));
    const email = screen.getByLabelText("New email address");
    const password = screen.getByLabelText("Your password");
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAccessibleDescription(/Enter an email address/);
    expect(email).toHaveFocus();

    await user.type(email, "maya@example.test");
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect(email).not.toHaveAttribute("aria-invalid");
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(password).toHaveAccessibleDescription(/Enter your password/);
    expect(set).not.toHaveBeenCalled();

    await user.type(password, "wrong-password");
    await user.click(screen.getByRole("button", { name: "Send link" }));
    await waitFor(() => expect(password).toHaveAccessibleDescription(/That is not your password/));
    expect(password).toHaveFocus();
  });

  it("asks again once the address is confirmed, wherever its link was opened", async () => {
    const client = workspace(info());
    const read = vi.spyOn(client.api, "emailAddress").mockResolvedValue({
      email: null,
      verifiedAt: null,
      pending: "maya@example.test",
    });
    settings(client);
    await screen.findByText(/isn't confirmed yet/);
    const confirmed = { email: "maya@example.test", verifiedAt: 1, pending: null };

    // Opened in another tab or app: coming back to this window asks again.
    read.mockResolvedValue(confirmed);
    window.dispatchEvent(new Event("focus"));
    expect(
      await screen.findByText(/^maya@example\.test\. If you forget your password/),
    ).toBeVisible();

    // Opened in this window: confirming it asks again too.
    read.mockResolvedValue({ email: null, verifiedAt: null, pending: "maya@example.test" });
    document.dispatchEvent(new Event("visibilitychange"));
    await screen.findByText(/isn't confirmed yet/);
    read.mockResolvedValue(confirmed);
    vi.spyOn(Api.prototype, "confirmEmail").mockResolvedValueOnce({ email: "maya@example.test" });
    await confirmEmailLink(URL_, TOKEN);
    expect(
      await screen.findByText(/^maya@example\.test\. If you forget your password/),
    ).toBeVisible();
  });
});

describe("sending an invite by email", () => {
  const invite = (client: WorkspaceClient, onSent = () => {}) =>
    render(
      <ClientContext.Provider value={client}>
        <ToastProvider>
          <InviteByEmail onSent={onSent} />
        </ToastProvider>
      </ClientContext.Provider>,
    );

  it("is not offered where the workspace sends no email", async () => {
    const client = workspace(info({ email: false }));
    invite(client);
    await waitFor(() => expect(client.api.serverInfo).toHaveBeenCalled());
    expect(screen.queryByLabelText("Send an invite by email")).toBeNull();
  });

  it("sends an invite of its own, and ties a mistake to the field", async () => {
    const client = workspace(info());
    const send = vi.spyOn(client.api, "emailInvite").mockResolvedValue({
      invite: {
        code: "WXYZ6789",
        createdBy: "U_MAYA",
        createdAt: 0,
        expiresAt: 7 * 24 * 3600_000,
        maxUses: 1,
        uses: 0,
        revokedAt: null,
        status: "active",
      },
    });
    const onSent = vi.fn();
    invite(client, onSent);
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Send an invite by email");
    expect(field).toHaveAccessibleDescription("Each one works once, for 7 days.");
    await user.click(screen.getByRole("button", { name: "Send invite" }));
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(/Enter an email address/);
    expect(send).not.toHaveBeenCalled();

    await user.type(field, "sam@example.test");
    await user.click(screen.getByRole("button", { name: "Send invite" }));
    expect(send).toHaveBeenCalledWith("sam@example.test");
    expect(await screen.findByText("Invite sent to sam@example.test.")).toBeVisible();
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(field).not.toHaveAttribute("aria-invalid");

    send.mockRejectedValue(new ApiError(502, "mail_failed", "The mail server did not send it."));
    await user.type(field, "sam@example.test");
    await user.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() =>
      expect(field).toHaveAccessibleDescription(
        /The invite was not sent\. The workspace's mail server did not take it\./,
      ),
    );
  });
});
