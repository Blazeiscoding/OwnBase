import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Api, ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { ServerInfo, ServerToClient, User } from "@slackoss/protocol";
import { AccountDialog } from "../src/components/AccountDialog.js";
import { PeopleDialog } from "../src/components/PeopleDialog.js";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { HostingStatus, Platform, SavedServer } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Two-step sign-in in the app (E11): set up in Account settings under
 * Security with the password, a QR code and a first code, then recovery codes
 * shown once; asked for by the sign-in card after the password; and turned
 * off for someone by an admin in People.
 */
const sam: User = {
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
const alex: User = {
  ...sam,
  id: "U_ALEX",
  handle: "alex",
  displayName: "Alex Chen",
  role: "member",
};

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const CODES = [
  "k7mq-3hxv",
  "p2rt-9wzc",
  "h4nd-6ysb",
  "m8xe-2qfa",
  "t5gu-7jkp",
  "w3ca-8nre",
  "z9hy-4mdt",
  "b6vs-5qxg",
  "e2kw-3pzn",
  "r7fm-9tah",
];

const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

// jsdom lays nothing out, so it has no scrolling to do.
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => vi.restoreAllMocks());

/** Account settings at Security, over a client whose two-step calls answer from stubs. */
function security(enabled = false, recoveryCodesLeft = 0) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    status: "online",
    workspaceName: "Rocket Team",
  });
  vi.spyOn(client.api, "listSessions").mockResolvedValue({ sessions: [] });
  const api = {
    status: vi.spyOn(client.api, "twoStep").mockResolvedValue({ enabled, recoveryCodesLeft }),
    start: vi.spyOn(client.api, "startTwoStep").mockResolvedValue({
      secret: SECRET,
      uri: `otpauth://totp/Rocket%20Team%20on%20Tandem%3Asam?secret=${SECRET}`,
    }),
    enable: vi.spyOn(client.api, "enableTwoStep").mockResolvedValue({ recoveryCodes: CODES }),
    codes: vi.spyOn(client.api, "newRecoveryCodes").mockResolvedValue({ recoveryCodes: CODES }),
    disable: vi.spyOn(client.api, "disableTwoStep").mockResolvedValue({ ok: true }),
  };
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <AccountDialog onClose={() => {}} onSignedOut={() => {}} section="security" />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const root = screen.getByRole("dialog", { name: "Account settings" });
  const section = () => within(within(root).getByRole("region", { name: "Two-step sign-in" }));
  return { api, root, section, user: userEvent.setup() };
}

describe("setting two-step sign-in up", () => {
  it("takes the password, shows a QR code and the key, and turns on with a code", async () => {
    const { api, root, section, user } = security();
    await user.click(await section().findByRole("button", { name: "Set up two-step sign-in" }));
    // Nothing goes to the server without the password.
    await user.click(section().getByRole("button", { name: "Continue" }));
    expect(section().getByRole("alert")).toHaveTextContent("Enter your current password.");
    expect(api.start).not.toHaveBeenCalled();
    expect(section().getByLabelText("Current password")).toHaveFocus();

    await user.type(section().getByLabelText("Current password"), "password123");
    await user.click(section().getByRole("button", { name: "Continue" }));
    expect(api.start).toHaveBeenCalledWith("password123");
    expect(
      await section().findByRole("img", { name: "QR code for your authenticator app" }),
    ).toBeVisible();
    // The key in fours, for typing into the app by hand.
    expect(section().getByText("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP")).toBeVisible();
    expect(section().getByText(/under “Rocket Team on Tandem”/)).toBeVisible();
    const code = section().getByLabelText("Code from the app");
    expect(code).toHaveFocus();
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(await accessibilityProblems(root)).toEqual([]);

    api.enable.mockRejectedValueOnce(new ApiError(400, "invalid_two_step_code"));
    await user.type(code, "000000");
    await user.click(section().getByRole("button", { name: "Turn on" }));
    expect(await section().findByRole("alert")).toHaveTextContent(
      "That code is not right. Enter the one your authenticator app shows now.",
    );
    fireEvent.change(code, { target: { value: "123456" } });
    await user.click(section().getByRole("button", { name: "Turn on" }));
    expect(api.enable).toHaveBeenLastCalledWith("123456");

    // The codes, once, with what to do with them.
    const codes = await section().findByRole("list", { name: "Recovery codes" });
    expect(
      within(codes)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(CODES);
    expect(section().getByText("Save your recovery codes").parentElement).toHaveFocus();
    expect(section().getByRole("button", { name: "Save as a file" })).toBeVisible();
    await user.click(section().getByRole("button", { name: "Done" }));
    expect(section().queryByRole("list", { name: "Recovery codes" })).toBeNull();
    expect(section().getByText(/^On\./)).toBeVisible();
    expect(section().getByText("10 recovery codes left.")).toBeVisible();
  });

  it("starts again from the password when setting up took too long", async () => {
    const { api, section, user } = security();
    await user.click(await section().findByRole("button", { name: "Set up two-step sign-in" }));
    await user.type(section().getByLabelText("Current password"), "password123");
    await user.click(section().getByRole("button", { name: "Continue" }));
    api.enable.mockRejectedValueOnce(new ApiError(409, "two_step_setup_expired"));
    await user.type(await section().findByLabelText("Code from the app"), "123456");
    await user.click(section().getByRole("button", { name: "Turn on" }));
    expect(await section().findByRole("alert")).toHaveTextContent(
      "Setting up took too long. Start again.",
    );
    expect(section().getByLabelText("Current password")).toHaveFocus();
    expect(section().getByLabelText("Current password")).toHaveValue("");
  });
});

describe("two-step sign-in once on", () => {
  it("warns when few recovery codes are left, and makes new ones with the password", async () => {
    const { api, section, user } = security(true, 2);
    expect(await section().findByText("2 recovery codes left.")).toHaveClass("text-alert");
    await user.click(section().getByRole("button", { name: "New recovery codes" }));
    expect(section().getByText(/old recovery codes stop working/)).toBeVisible();
    await user.type(section().getByLabelText("Current password"), "password123");
    await user.click(section().getByRole("button", { name: "Make new codes" }));
    expect(api.codes).toHaveBeenCalledWith("password123");
    expect(await section().findByRole("list", { name: "Recovery codes" })).toBeVisible();
    await user.click(section().getByRole("button", { name: "Done" }));
    expect(section().getByText("10 recovery codes left.")).not.toHaveClass("text-alert");
    // The password asked next starts empty.
    await user.click(section().getByRole("button", { name: "Turn off" }));
    expect(section().getByLabelText("Current password")).toHaveValue("");
  });

  it("says so when no recovery codes are left", async () => {
    const { section } = security(true, 0);
    expect(
      await section().findByText(
        "You have no recovery codes left. Make new ones so you can still sign in without your phone.",
      ),
    ).toHaveClass("text-alert");
  });

  it("turns off with the password, and says a wrong one was refused", async () => {
    const { api, section, user } = security(true, 10);
    await user.click(await section().findByRole("button", { name: "Turn off" }));
    api.disable.mockRejectedValueOnce(new ApiError(403, "invalid_credentials"));
    await user.type(section().getByLabelText("Current password"), "not-it");
    await user.click(section().getByRole("button", { name: "Turn off two-step sign-in" }));
    expect(await section().findByRole("alert")).toHaveTextContent(
      "Your current password was not accepted.",
    );
    fireEvent.change(section().getByLabelText("Current password"), {
      target: { value: "password123" },
    });
    await user.click(section().getByRole("button", { name: "Turn off two-step sign-in" }));
    expect(api.disable).toHaveBeenLastCalledWith("password123");
    expect(await section().findByRole("status")).toHaveTextContent(
      "Two-step sign-in is off. Your password alone signs you in.",
    );
    expect(section().getByRole("button", { name: "Set up two-step sign-in" })).toBeVisible();
  });

  it("is not offered to a guest, who has no password", async () => {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    const guest = { ...alex, role: "guest" as const };
    client.store.setState({ self: guest, users: { [guest.id]: guest }, status: "online" });
    vi.spyOn(client.api, "listSessions").mockResolvedValue({ sessions: [] });
    const status = vi.spyOn(client.api, "twoStep");
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <AccountDialog onClose={() => {}} onSignedOut={() => {}} section="security" />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    expect(await screen.findByRole("heading", { name: "Change password" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Two-step sign-in" })).toBeNull();
    expect(status).not.toHaveBeenCalled();
  });
});

describe("signing in with two-step sign-in", () => {
  const info: ServerInfo = {
    app: "slackoss",
    protocolVersion: 1,
    serverVersion: "0.0.0-test",
    workspaceName: "Rocket Team",
    userCount: 2,
    requiresInvite: false,
    requiresClaim: false,
  };
  const rocket: SavedServer = {
    url: "http://rocket.test:8543",
    token: "test-token-not-a-credential",
    workspaceName: "Rocket Team",
    handle: "sam",
    lastUsedAt: 2,
  };
  const stopped: HostingStatus = { running: false, phase: "stopped" };

  /** The card for a saved workspace whose sign-in has expired, through its password. */
  async function atSecondStep() {
    vi.spyOn(Api.prototype, "me").mockRejectedValue(new ApiError(401, "unauthorized"));
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    const login = vi
      .spyOn(Api.prototype, "login")
      .mockResolvedValue({ twoStep: { challenge: "C1", expiresAt: Date.now() + 300_000 } });
    const second = vi.spyOn(Api.prototype, "signInSecondStep").mockResolvedValue({
      token: "test-token-not-a-credential",
      user: sam,
      recoveryCodesLeft: 10,
    });
    const onConnected = vi.fn();
    const view = render(
      <JoinScreen
        platform={platform}
        savedServers={[rocket]}
        onConnected={onConnected}
        onForget={() => {}}
        hostingStatus={stopped}
        lastHosted={null}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Rocket Team.*@sam/ }));
    await user.type(await screen.findByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByLabelText("Code");
    return { login, second, onConnected, user, view };
  }

  it("asks for the app's code after the password, and goes in once it is right", async () => {
    const { login, second, onConnected, user, view } = await atSecondStep();
    expect(login).toHaveBeenCalledWith({ handle: "sam", password: "password123" });
    const code = screen.getByLabelText("Code");
    expect(code).toHaveFocus();
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(code).toHaveAttribute("inputmode", "numeric");
    expect(screen.getByText(/This account has two-step sign-in/)).toBeVisible();
    expect(await accessibilityProblems(view.container)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the code your app shows.");
    expect(second).not.toHaveBeenCalled();

    second.mockRejectedValueOnce(
      new ApiError(
        401,
        "invalid_two_step_code",
        "That code is not right. Enter the one your authenticator app shows now.",
      ),
    );
    await user.type(code, "000000");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code is not right.");
    expect(onConnected).not.toHaveBeenCalled();

    fireEvent.change(code, { target: { value: "123 456" } });
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(second).toHaveBeenLastCalledWith({ challenge: "C1", code: "123 456" });
    await vi.waitFor(() =>
      expect(onConnected).toHaveBeenCalledWith(
        expect.objectContaining({ url: rocket.url, handle: "sam" }),
      ),
    );
  });

  it("takes a recovery code instead, and says how many are left before going in", async () => {
    const { second, onConnected, user } = await atSecondStep();
    await user.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
    const field = screen.getByLabelText("Recovery code");
    expect(field).toHaveFocus();
    expect(field).not.toHaveAttribute("autocomplete", "one-time-code");
    second.mockResolvedValueOnce({
      token: "test-token-not-a-credential",
      user: sam,
      recoveryCodesLeft: 1,
    });
    await user.type(field, "abcd-efgh");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(second).toHaveBeenLastCalledWith({ challenge: "C1", recoveryCode: "abcd-efgh" });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "You signed in with a recovery code. You have 1 left, and each works once.",
    );
    expect(onConnected).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ handle: "sam" }));
  });

  it("asks for a new password after the code when the one given was issued by someone else", async () => {
    const { second, onConnected, user } = await atSecondStep();
    second.mockResolvedValueOnce({
      token: "test-token-not-a-credential",
      user: sam,
      mustChangePassword: true,
      recoveryCodesLeft: 10,
    });
    await user.type(screen.getByLabelText("Code"), "123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByLabelText("New password")).toBeVisible();
    expect(screen.getByText(/That password was issued to you by someone else/)).toBeVisible();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("goes back to the password when the second step has expired", async () => {
    const { second, user } = await atSecondStep();
    second.mockRejectedValueOnce(
      new ApiError(401, "two_step_expired", "That sign-in has expired. Enter your password again."),
    );
    await user.type(screen.getByLabelText("Code"), "123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That sign-in has expired. Enter your password again.",
    );
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.queryByLabelText("Code")).toBeNull();
  });
});

describe("resetting someone's two-step sign-in", () => {
  async function people(twoStep: boolean | undefined) {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({
      self: sam,
      users: { [sam.id]: sam, [alex.id]: alex },
      status: "online",
    });
    vi.spyOn(client.api, "listAllUsers").mockResolvedValue({
      users: [
        { ...sam, lastSeenAt: null },
        { ...alex, lastSeenAt: null, ...(twoStep === undefined ? {} : { twoStep }) },
      ],
    });
    const reset = vi.spyOn(client.api, "resetTwoStep").mockResolvedValue({ ok: true });
    render(
      <ClientContext.Provider value={client}>
        <PeopleDialog onClose={() => {}} />
      </ClientContext.Provider>,
    );
    const dialog = within(screen.getByRole("dialog", { name: "People" }));
    await dialog.findByText("@alex");
    return { client, dialog, reset, user: userEvent.setup() };
  }
  const openMenu = async (
    dialog: ReturnType<typeof within>,
    user: ReturnType<typeof userEvent.setup>,
  ) => {
    await user.click(dialog.getByRole("button", { name: "Actions for Alex Chen" }));
    return within(screen.getByRole("menu", { name: "Actions for Alex Chen" }));
  };

  it("is offered for someone who has it, kept as their details change, and asks first", async () => {
    const { client, dialog, reset, user } = await people(true);
    // A change heard over the socket keeps what the admin list said.
    const connection = client as unknown as { handleServerMessage(message: ServerToClient): void };
    act(() =>
      connection.handleServerMessage({
        type: "event",
        envelope: { seq: 1, event: { type: "user.updated", user: { ...alex, statusText: "Out" } } },
      }),
    );
    await vi.waitFor(async () =>
      expect(
        (await openMenu(dialog, user)).getByRole("menuitem", { name: "Reset two-step sign-in" }),
      ).toBeVisible(),
    );
    await user.click(screen.getByRole("menuitem", { name: "Reset two-step sign-in" }));
    expect(
      dialog.getByRole("heading", { name: "Turn off Alex Chen's two-step sign-in?" }),
    ).toBeVisible();
    expect(dialog.getByText(/lost their phone and their recovery codes/)).toBeVisible();
    expect(reset).not.toHaveBeenCalled();
    await user.click(dialog.getByRole("button", { name: "Turn off two-step sign-in" }));
    expect(reset).toHaveBeenCalledWith("U_ALEX");
    expect(
      await dialog.findByText(
        "Alex Chen's two-step sign-in is off. They can set it up again in Account settings.",
      ),
    ).toHaveAttribute("role", "status");
    expect(
      (await openMenu(dialog, user)).queryByRole("menuitem", { name: "Reset two-step sign-in" }),
    ).toBeNull();
  });

  it("is not offered for someone without it, or by a server that does not say", async () => {
    for (const twoStep of [false, undefined]) {
      const { dialog, user } = await people(twoStep);
      const menu = await openMenu(dialog, user);
      expect(menu.getByRole("menuitem", { name: "Reset password" })).toBeVisible();
      expect(menu.queryByRole("menuitem", { name: "Reset two-step sign-in" })).toBeNull();
      cleanup();
    }
  });
});
