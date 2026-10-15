import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Api, WorkspaceClient } from "@slackoss/client-core";
import type { Channel, Invite, ServerInfo, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { InviteDialog } from "../src/components/InviteDialog.js";
import { JoinScreen } from "../src/screens/JoinScreen.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { writeRoute } from "../src/lib/route.js";
import type { HostingStatus, Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Founding a workspace ends with inviting people (UX-42): the first account
 * lands on a link ready to copy, with what it takes to reach people elsewhere,
 * instead of an empty #general.
 */
const person = (id: string, role: User["role"]): User => ({
  id,
  handle: id.toLowerCase(),
  displayName: id,
  role,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
  canInvite: true,
});
const owner = person("U_OWNER", "owner");

const info: ServerInfo = {
  app: "slackoss",
  protocolVersion: 1,
  serverVersion: "0.0.0-test",
  workspaceName: "Rocket Team",
  userCount: 0,
  requiresInvite: false,
  requiresClaim: false,
};

const webPlatform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};
const hosting: HostingStatus = {
  running: true,
  phase: "running",
  workspaceName: "Rocket Team",
  port: 8543,
  lanUrls: ["192.168.1.20:8543"],
};
const desktopPlatform: Platform = {
  ...webPlatform,
  kind: "desktop",
  hosting: { status: async () => hosting, start: vi.fn(), stop: vi.fn() },
};

const madeInvite: Invite = {
  code: "WELC0ME1",
  createdBy: owner.id,
  createdAt: 0,
  expiresAt: null,
  maxUses: null,
  uses: 0,
  status: "active",
};

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("creating an account", () => {
  async function signUp(serverInfo: ServerInfo, role: User["role"]) {
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(serverInfo);
    vi.spyOn(Api.prototype, "register").mockResolvedValue({
      token: "new-token",
      user: person("U_NEW", role),
    });
    const onConnected = vi.fn();
    render(
      <JoinScreen
        platform={webPlatform}
        savedServers={[]}
        autoProbe="http://127.0.0.1:9"
        onConnected={onConnected}
        onForget={() => {}}
      />,
    );
    await screen.findByRole("heading", { name: "Rocket Team" });
    const user = userEvent.setup();
    const create = screen.queryByRole("tab", { name: "Create account" });
    if (create) await user.click(create);
    await user.type(screen.getByLabelText("Username"), "olu");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Join workspace" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    return onConnected;
  }

  it("says it founded the workspace when it is the first, so its owner", async () => {
    const onConnected = await signUp(info, "owner");
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ token: "new-token" }), {
      founded: true,
    });
  });

  it("says nothing of the kind for someone joining a workspace that has people", async () => {
    const onConnected = await signUp({ ...info, userCount: 3 }, "member");
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ token: "new-token" }), {
      founded: false,
    });
  });
});

describe("the workspace a founder opens", () => {
  it("opens on inviting people, and Done leaves the workspace behind it", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("min-width"),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const general: Channel = {
      id: "C_GENERAL",
      type: "public",
      name: "general",
      topic: "",
      description: "",
      creatorId: owner.id,
      archived: false,
      createdAt: 0,
    };
    const client = new WorkspaceClient("http://192.168.1.20:8543", "synthetic-test-token");
    clients.push(client);
    client.store.setState({
      self: owner,
      users: { [owner.id]: owner },
      workspaceId: "W_NEW",
      channels: { [general.id]: general },
      memberships: { [general.id]: 0 },
      status: "online",
    });
    writeRoute(client.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
    vi.spyOn(client, "loadTimeline").mockResolvedValue();
    vi.spyOn(client, "loadCommands").mockResolvedValue();
    vi.spyOn(client.api, "listInvites").mockResolvedValue({ invites: [] });
    const create = vi.spyOn(client.api, "createInvite").mockResolvedValue({ invite: madeInvite });
    render(
      <ConfirmProvider>
        <PlatformContext.Provider value={webPlatform}>
          <ClientContext.Provider value={client}>
            <WorkspaceScreen
              client={client}
              platform={webPlatform}
              welcome
              onLeaveWorkspace={() => {}}
              onSignedOut={() => {}}
            />
          </ClientContext.Provider>
        </PlatformContext.Provider>
      </ConfirmProvider>,
    );
    const welcome = await screen.findByRole(
      "dialog",
      { name: "Invite your people" },
      { timeout: 3_000 },
    );
    expect(
      await within(welcome).findByText("http://192.168.1.20:8543/#/join/WELC0ME1"),
    ).toBeVisible();
    expect(create).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(within(welcome).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Invite your people" })).toBeNull(),
    );
  });
});

describe("the welcome step", () => {
  function welcome(baseUrl: string, platform: Platform) {
    const client = new WorkspaceClient(baseUrl, "test-token-not-a-credential");
    clients.push(client);
    client.store.setState({ self: owner, users: { [owner.id]: owner }, status: "online" });
    vi.spyOn(client.api, "listInvites").mockResolvedValue({ invites: [madeInvite] });
    vi.spyOn(client.api, "createInvite").mockResolvedValue({ invite: madeInvite });
    const onClose = vi.fn();
    render(
      <ConfirmProvider>
        <PlatformContext.Provider value={platform}>
          <ClientContext.Provider value={client}>
            <InviteDialog welcome onClose={onClose} />
          </ClientContext.Provider>
        </PlatformContext.Provider>
      </ConfirmProvider>,
    );
    return { dialog: screen.getByRole("dialog", { name: "Invite your people" }), onClose };
  }

  it("says a link on this network reaches only it, and where to share it further", async () => {
    const { dialog, onClose } = welcome("http://192.168.1.20:8543", desktopPlatform);
    expect(await within(dialog).findByText(/#\/join\/WELC0ME1$/)).toBeVisible();
    expect(dialog).toHaveTextContent(
      "Your workspace is ready. Send this link to the people you want in it, or let them scan the code with a phone.",
    );
    expect(dialog).toHaveTextContent(
      "This link works for people on the same network as this computer. To let people elsewhere join, choose Manage hosting at the bottom of the window and share the workspace on the internet.",
    );
    // Its one code is the link above; a list of one says nothing more.
    expect(within(dialog).queryByRole("list", { name: "Invite codes" })).toBeNull();
    expect(await accessibilityProblems(dialog)).toEqual([]);
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says the network part only of a server elsewhere, and nothing of an address anyone can reach", async () => {
    const lan = welcome("http://10.0.0.7:8543", webPlatform);
    expect(await within(lan.dialog).findByText(/#\/join\/WELC0ME1$/)).toBeVisible();
    expect(lan.dialog).toHaveTextContent(
      "This link works for people on the same network as the workspace's server.",
    );
    expect(lan.dialog).not.toHaveTextContent(/Manage hosting/);
    cleanup();

    const open = welcome("https://chat.team.dev", webPlatform);
    expect(await within(open.dialog).findByText(/#\/join\/WELC0ME1$/)).toBeVisible();
    expect(open.dialog).not.toHaveTextContent(/same network/);
  });

  it("speaks of no code to scan where there is none, on an address only this computer reaches", async () => {
    const { dialog } = welcome("http://127.0.0.1:8543", webPlatform);
    expect(await within(dialog).findByText(/#\/join\/WELC0ME1$/)).toBeVisible();
    expect(dialog).toHaveTextContent(
      "Your workspace is ready. Send this link to the people you want in it.",
    );
    expect(dialog).not.toHaveTextContent(/scan/);
    expect(within(dialog).queryByRole("img", { name: /QR code/ })).toBeNull();
  });
});
