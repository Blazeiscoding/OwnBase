import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Api, WorkspaceClient } from "@ownbase/client-core";
import type { ServerInfo, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { AppsDialog } from "../src/components/AppsDialog.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ProfileForm } from "../src/components/ProfileDialog.js";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

const info: ServerInfo = {
  app: "ownbase",
  protocolVersion: 1,
  serverVersion: "0.0.0-test",
  workspaceName: "Rocket Team",
  userCount: 4,
  requiresInvite: true,
  requiresClaim: false,
};

const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "owner",
  statusText: "Heads down",
  statusEmoji: "🎧",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const desktop: Platform = {
  kind: "desktop",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

/** The join screen, told to open a workspace that answers from a stub rather than a server. */
async function signInCard(options: { inviteCode?: string } = {}) {
  vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
  render(
    <JoinScreen
      platform={desktop}
      savedServers={[]}
      autoProbe="http://127.0.0.1:9"
      inviteCode={options.inviteCode}
      onConnected={() => {}}
      onForget={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Rocket Team" });
  // The card puts the cursor in its first field once it has mounted. On a slow
  // machine that can come after a test has moved focus itself, and take it back.
  await waitFor(() => expect(screen.getByLabelText("Username")).toHaveFocus());
  return userEvent.setup();
}

afterEach(() => vi.restoreAllMocks());

describe("signing in", () => {
  it("names every field on the card, not only in a placeholder that goes when typing starts", async () => {
    const user = await signInCard();
    expect(screen.getByLabelText("Username")).not.toHaveAttribute("placeholder");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
    expect(await accessibilityProblems()).toEqual([]);

    await user.click(screen.getByRole("tab", { name: "Create account" }));
    expect(screen.getByLabelText("Display name")).toHaveAccessibleDescription(
      "What everyone sees. Left empty, it is your username.",
    );
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription("At least 8 characters.");
    expect(screen.getByLabelText("Invite code")).toHaveAccessibleDescription(
      "From whoever invited you. This workspace takes new accounts only with one.",
    );
    for (const field of ["Username", "Display name", "Password", "Invite code"]) {
      expect(screen.getByText(field, { selector: "label" })).toBeVisible();
    }
    expect(await accessibilityProblems()).toEqual([]);
  });

  it("switches between signing in and creating an account as a tab list", async () => {
    const user = await signInCard();
    const signIn = screen.getByRole("tab", { name: "Sign in" });
    const create = screen.getByRole("tab", { name: "Create account" });
    expect(signIn).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Sign in" })).toContainElement(
      screen.getByRole("button", { name: "Sign in" }),
    );
    // One stop for the pair, then arrows, leaving focus on the tabs.
    signIn.focus();
    await user.keyboard("{ArrowRight}");
    expect(create).toHaveFocus();
    expect(create).toHaveAttribute("aria-selected", "true");
    expect(signIn).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel", { name: "Create account" })).toContainElement(
      screen.getByRole("button", { name: "Join workspace" }),
    );
    await user.keyboard("{Home}");
    expect(signIn).toHaveFocus();
    // Left from the first tab wraps to the last, and Right from the last to the first.
    await user.keyboard("{ArrowLeft}");
    expect(create).toHaveFocus();
    expect(create).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}");
    expect(signIn).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Sign in" })).toBeVisible();
    // A click is a choice of form, so the cursor goes to its first field.
    await user.click(create);
    expect(screen.getByLabelText("Username")).toHaveFocus();
  });

  it("opens on the account form with the invite code filled in when an invite brought someone here", async () => {
    await signInCard({ inviteCode: "ABCD1234" });
    expect(screen.getByLabelText("Invite code")).toHaveValue("ABCD1234");
    expect(screen.getByRole("button", { name: "Join workspace" })).toBeVisible();
  });

  it("names the fields for replacing a password someone else issued", async () => {
    const user = await signInCard();
    vi.spyOn(Api.prototype, "login").mockResolvedValue({
      token: "test-session-not-a-credential",
      user: sam,
      mustChangePassword: true,
    });
    await user.type(screen.getByLabelText("Username"), "sam");
    await user.type(screen.getByLabelText("Password"), "issued-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByLabelText("New password")).toHaveAccessibleDescription(
      "At least 8 characters.",
    );
    expect(screen.getByLabelText("Confirm new password")).toBeVisible();
    expect(await accessibilityProblems()).toEqual([]);
  });
});

/** A workspace client that never connects, holding the account a test gives it. */
function workspace() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { U_SAM: sam }, status: "online" });
  return client;
}

describe("account and administration dialogs", () => {
  it("ties your profile's labels to their fields", async () => {
    render(
      <ClientContext.Provider value={workspace()}>
        <ProfileForm />
      </ClientContext.Provider>,
    );
    const dialog = screen.getByRole("form", { name: "Your profile" });
    expect(within(dialog).getByLabelText("Display name")).toHaveValue("Sam Rivera");
    const status = within(dialog).getByRole("group", { name: "Status" });
    expect(within(status).getByRole("button", { name: "Change status emoji, 🎧" })).toBeVisible();
    expect(within(status).getByLabelText("Status text")).toHaveValue("Heads down");
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("says what an integration can rely on instead of promising a changed URL is enough", async () => {
    const user = userEvent.setup();
    const client = workspace();
    const listApps = vi.spyOn(client.api, "listApps").mockResolvedValue({
      apps: [
        {
          id: "A_DEPLOY",
          name: "Deploy Bot",
          botUserId: "U_DEPLOY",
          createdBy: "U_SAM",
          createdAt: 0,
          interactivityUrl: "",
          signingSecret: "test-signing-secret-not-a-credential",
          webhooks: [],
          commands: [],
          subscriptions: [],
        },
      ],
    });
    const deleteApp = vi.spyOn(client.api, "deleteApp").mockRejectedValueOnce(new Error("offline"));
    render(
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <AppsDialog onClose={() => {}} />
        </ClientContext.Provider>
      </ConfirmProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Apps and integrations" });
    await within(dialog).findByText("Deploy Bot", { selector: "span" });
    listApps.mockRejectedValueOnce(new Error("still offline"));

    expect(dialog).not.toHaveTextContent(/work by changing the URL/);
    // The notes on Slack are folded away (UX-63), and link to the published contract.
    await user.click(within(dialog).getByText("How this differs from Slack"));
    expect(within(dialog).getByText("How this differs from Slack").closest("details")!.open).toBe(
      true,
    );
    const contract = within(dialog).getByRole("link", { name: "The integration contract" });
    expect(contract).toHaveAttribute(
      "href",
      "https://github.com/Blazeiscoding/OwnBase/blob/main/docs/INTEGRATIONS.md",
    );
    expect(within(dialog).getByLabelText("App name")).toBeVisible();
    // Each of an app's forms is a group named for what it adds, so its fields
    // can say only "Request URL" and still be told apart.
    for (const [group, fields] of [
      ["Slash commands", ["Command", "Request URL", "Description"]],
      ["Event subscriptions", ["Request URL"]],
      ["Interactivity", ["Request URL"]],
    ] as const) {
      const section = within(dialog).getByRole("group", { name: group });
      for (const field of fields) {
        expect(within(section).getByText(field, { selector: "label" })).toBeVisible();
        expect(within(section).getByLabelText(field)).toBeVisible();
      }
    }

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    const question = screen.getByRole("dialog", { name: "Delete Deploy Bot?" });
    expect(deleteApp).not.toHaveBeenCalled();
    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(deleteApp).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Delete Deploy Bot?" })).getByRole("button", {
        name: "Delete",
      }),
    );
    expect(deleteApp).toHaveBeenCalledWith("A_DEPLOY");
    expect(
      await within(dialog).findByText(/Could not confirm whether the app was deleted/),
    ).toHaveAttribute("role", "alert");
    expect(within(dialog).getByRole("button", { name: "Retry" })).toBeVisible();
    expect(listApps).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByText("Deploy Bot", { selector: "span" })).toBeVisible();
    expect(within(dialog).queryByText("No apps yet.")).toBeNull();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });
});
