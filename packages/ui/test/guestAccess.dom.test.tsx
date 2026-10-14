import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Api, ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { Channel, ServerInfo, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { Composer } from "../src/components/Composer.js";
import { Sidebar } from "../src/components/Sidebar.js";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Joining as a guest where the workspace allows it, and what a guest is then
 * offered: public channels, and nothing it would be refused.
 */
const info: ServerInfo = {
  app: "slackoss",
  protocolVersion: 1,
  serverVersion: "0.0.0-test",
  workspaceName: "Rocket Team",
  userCount: 4,
  requiresInvite: false,
  requiresClaim: false,
  accessPolicy: "guest_allowed",
};

const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

const person = (id: string, displayName: string, role: User["role"]): User => ({
  id,
  handle: id.toLowerCase(),
  displayName,
  role,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});

afterEach(() => vi.restoreAllMocks());

async function joinCard(serverInfo: ServerInfo = info) {
  vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(serverInfo);
  const onConnected = vi.fn();
  const view = render(
    <JoinScreen
      platform={platform}
      savedServers={[]}
      autoProbe="http://127.0.0.1:9"
      onConnected={onConnected}
      onForget={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Rocket Team" });
  return { onConnected, view, user: userEvent.setup() };
}

describe("joining a workspace that allows guests", () => {
  it("offers joining as a guest first, with a display name alone", async () => {
    const join = vi
      .spyOn(Api.prototype, "joinAsGuest")
      .mockResolvedValue({ token: "guest-token", user: person("U_G", "Vic", "guest") });
    const { onConnected, user } = await joinCard();
    expect(screen.getByRole("tab", { name: "Join as guest" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const name = screen.getByLabelText("Display name");
    await waitFor(() => expect(name).toHaveFocus());
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(name).toHaveAccessibleDescription(/Creating an account is optional/);
    // Signing in and creating an account stay there to choose.
    expect(screen.getByRole("tab", { name: "Sign in" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Create account" })).toBeVisible();
    expect(await accessibilityProblems()).toEqual([]);

    // The button stays usable and says what is missing, rather than refusing silently.
    const submit = screen.getByRole("button", { name: "Join as guest" });
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the name everyone will see.");
    expect(name).toHaveFocus();
    expect(join).not.toHaveBeenCalled();
    await user.type(name, "  Vic ");
    await user.click(submit);
    expect(join).toHaveBeenCalledWith("Vic");
    expect(onConnected).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://127.0.0.1:9", token: "guest-token" }),
      // A guest founds nothing, so the workspace opens as usual.
      { founded: false },
    );
  });

  it("offers only accounts where guests are not allowed, or the server is older", async () => {
    for (const serverInfo of [
      { ...info, accessPolicy: "account_required" as const },
      { ...info, accessPolicy: undefined },
    ]) {
      const { view } = await joinCard(serverInfo);
      expect(screen.queryByRole("tab", { name: "Join as guest" })).toBeNull();
      expect(screen.getByRole("tab", { name: "Sign in" })).toHaveAttribute("aria-selected", "true");
      view.unmount();
      vi.restoreAllMocks();
    }
  });

  it("stays to try again when refused, and ignores an answer after going back", async () => {
    let answer!: (value: { token: string; user: User }) => void;
    vi.spyOn(Api.prototype, "joinAsGuest")
      .mockRejectedValueOnce(new ApiError(403, "guest_access_off"))
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { onConnected, user } = await joinCard();
    await user.type(screen.getByLabelText("Display name"), "Vic");
    await user.click(screen.getByRole("button", { name: "Join as guest" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This workspace no longer lets guests in.",
    );
    expect(screen.getByLabelText("Display name")).toHaveValue("Vic");

    await user.click(screen.getByRole("button", { name: "Join as guest" }));
    expect(screen.getByRole("button", { name: "Joining…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "All workspaces" }));
    answer({ token: "late-token", user: person("U_G", "Vic", "guest") });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onConnected).not.toHaveBeenCalled();
  });
});

describe("a guest in the workspace", () => {
  const general: Channel = {
    id: "C_GENERAL",
    type: "public",
    name: "general",
    topic: "",
    description: "",
    creatorId: "U_OWNER",
    archived: false,
    createdAt: 0,
  };

  function workspace(self: User) {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({
      self,
      users: { [self.id]: self },
      channels: { [general.id]: general },
      status: "online",
    });
    return client;
  }

  const noop = () => {};
  const sidebar = (client: WorkspaceClient, onCreateAccount = vi.fn()) =>
    render(
      <ClientContext.Provider value={client}>
        <Sidebar
          activeChannelId={general.id}
          onSelect={noop}
          onBrowseChannels={noop}
          onNewChannel={noop}
          onNewDm={noop}
          onFriends={noop}
          onSearch={noop}
          onSaved={noop}
          onScheduled={noop}
          onActivity={noop}
          onThreads={noop}
          onInvite={noop}
          onSwitchWorkspace={noop}
          onEditProfile={noop}
          onAccountSettings={noop}
          onCreateAccount={onCreateAccount}
          connectionLabel={null}
        />
      </ClientContext.Provider>,
    );

  it("is offered public channels, and creating an account, rather than what it cannot do", async () => {
    const user = userEvent.setup();
    const onCreateAccount = vi.fn();
    sidebar(workspace(person("U_G", "Vic", "guest")), onCreateAccount);
    const nav = screen.getByRole("navigation");
    for (const name of ["Friends", "New channel", "New message"])
      expect(within(nav).queryByRole("button", { name })).toBeNull();
    expect(within(nav).getByRole("button", { name: "Browse channels" })).toBeVisible();
    expect(within(nav).getByText("Guest")).toBeVisible();
    await user.click(within(nav).getByRole("button", { name: /, workspace menu$/ }));
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toContain("Create an account");
    expect(items).not.toContain("Invite people");
    expect(items).not.toContain("Account settings");
    await user.click(screen.getByRole("menuitem", { name: "Create an account" }));
    expect(onCreateAccount).toHaveBeenCalledOnce();
  });

  it("keeps a member's sidebar as it was", () => {
    sidebar(workspace(person("U_M", "Mia", "member")));
    const nav = screen.getByRole("navigation");
    for (const name of ["Friends", "New channel", "New message"])
      expect(within(nav).getByRole("button", { name })).toBeVisible();
  });

  it("writes, but is not offered attachments or sending later", async () => {
    const user = userEvent.setup();
    const client = workspace(person("U_G", "Vic", "guest"));
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <Composer channelId={general.id} placeholder="Message #general" />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const box = screen.getByRole("textbox", { name: "Message #general" });
    await waitFor(() => expect(box).toBeEnabled());
    await user.type(box, "hello");
    expect(screen.queryByRole("button", { name: "Attach a file" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send later" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });
});
