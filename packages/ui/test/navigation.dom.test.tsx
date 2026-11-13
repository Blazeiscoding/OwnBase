import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { Sidebar } from "../src/components/Sidebar.js";
import { Navigation } from "../src/lib/navigation.js";
import { paletteCommands, type ActionContext } from "../src/lib/actions.js";
import { OpenDialog } from "../src/screens/workspaceViews.js";
import { renderPart, testPlatform } from "./workspaceParts.js";

const member: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};
const general: Channel = {
  id: "C_GENERAL",
  name: "general",
  type: "public",
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
};
const random: Channel = { ...general, id: "C_RANDOM", name: "random" };

const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  window.history.replaceState(null, "", "/");
});

function workspace(self: User = member) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self,
    users: { [self.id]: self },
    channels: { C_GENERAL: general, C_RANDOM: random },
    memberships: { C_GENERAL: 0, C_RANDOM: 0 },
    status: "online",
    workspaceName: "Rocket Team",
  });
  return client;
}

function actionContext(client: WorkspaceClient): ActionContext {
  return {
    client,
    state: client.state,
    nav: new Navigation(client, client.baseUrl, { channelId: general.id }),
    shell: {
      platform: testPlatform(),
      otherWorkspaces: [],
      railPlace: 0,
      onLeaveWorkspace: () => {},
      onSignedOut: () => {},
    },
    toast: () => () => {},
    confirm: async () => true,
    theme: { dark: false, set: () => {} },
  };
}

// Before, Ctrl+K and the workspace menu offered Invite people to every member,
// while the channel rows asked whether they may invite.
describe("Invite people, for a member an admin has not let invite", () => {
  const barred = { ...member, canInvite: false };

  it("is in none of the workspace menu, Ctrl+K or a channel's row", async () => {
    const client = workspace(barred);
    renderPart(client, <Sidebar />, { channelId: general.id });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Rocket Team, workspace menu" }));
    const menu = screen.getByRole("menu", { name: "Workspace" });
    expect(within(menu).queryByRole("menuitem", { name: "Invite people" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite people" })).toBeNull();
    expect(paletteCommands(actionContext(client)).map((c) => c.label)).not.toContain(
      "Invite people",
    );
  });

  it("is in each for a member who may invite", async () => {
    const client = workspace();
    renderPart(client, <Sidebar />, { channelId: general.id });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Rocket Team, workspace menu" }));
    expect(screen.getByRole("menuitem", { name: "Invite people" })).toBeVisible();
    expect(paletteCommands(actionContext(client)).map((c) => c.label)).toContain("Invite people");
  });

  it("closes when an address names it", async () => {
    const client = workspace(barred);
    const { navigation } = renderPart(client, <OpenDialog />, {
      channelId: general.id,
      state: { dialog: { kind: "invite" } },
    });
    await vi.waitFor(() => expect(navigation.state.dialog).toEqual({ kind: "none" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// Before, Ctrl+K offered a guest Set a status and Account settings, which the
// account menu and its gear leave out: a guest's picture, password, devices
// and storage are refused there.
describe("Profile and Account settings, for a guest", () => {
  const guest: User = { ...member, id: "U_VIC", handle: "vic", role: "guest" };

  it("are in neither the account menu nor Ctrl+K", async () => {
    const client = workspace(guest);
    renderPart(client, <Sidebar />, { channelId: general.id });
    await userEvent.setup().click(screen.getByRole("button", { name: /, your account$/ }));
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).not.toContain("Profile and status");
    expect(items).not.toContain("Account settings");
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    const offered = paletteCommands(actionContext(client)).map((c) => c.label);
    expect(offered).not.toContain("Set a status");
    expect(offered).not.toContain("Account settings");
  });

  it("are in both for a member", () => {
    const offered = paletteCommands(actionContext(workspace())).map((c) => c.label);
    expect(offered).toContain("Set a status");
    expect(offered).toContain("Account settings");
  });
});

describe("the address and Back", () => {
  function opened() {
    const client = workspace();
    const navigation = new Navigation(client, client.baseUrl, { channelId: general.id });
    const stop = navigation.attach();
    return { navigation, stop };
  }

  it("adds a step for each place, and a dialog over the same place, which closing goes Back through", () => {
    const { navigation, stop } = opened();
    const steps = window.history.length;
    expect(window.location.hash).toBe("#/c/C_GENERAL");
    navigation.navigate({ to: "conversation", channelId: random.id });
    expect(window.history.length).toBe(steps + 1);
    navigation.navigate({ to: "dialog", dialog: { kind: "account", section: "profile" } });
    expect(window.history.length).toBe(steps + 2);
    // Another section of the same dialog rewrites the step rather than adding one.
    navigation.navigate({
      to: "dialog",
      dialog: { kind: "account", section: "security" },
      replace: true,
    });
    expect(window.history.length).toBe(steps + 2);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    navigation.closeDialog();
    expect(back).toHaveBeenCalledOnce();
    stop();
  });

  it("rewrites the entry when the screen moves on its own, so Back does not lead there", () => {
    const { navigation, stop } = opened();
    const steps = window.history.length;
    navigation.settle(random.id);
    expect(window.history.length).toBe(steps);
    expect(window.history.state.ownbase.channelId).toBe(random.id);
    stop();
  });

  it("returns to the place a history entry names when Back or Forward lands on it", () => {
    const { navigation, stop } = opened();
    const entry = window.history.state;
    navigation.navigate({ to: "panel", panel: { kind: "saved" } });
    navigation.navigate({ to: "dialog", dialog: { kind: "shortcuts" } });
    act(() => {
      window.history.replaceState(entry, "");
      window.dispatchEvent(new PopStateEvent("popstate", { state: entry }));
    });
    expect(navigation.state.channelId).toBe(general.id);
    expect(navigation.state.panel).toEqual({ kind: "none" });
    expect(navigation.state.dialog).toEqual({ kind: "none" });
    stop();
  });
});
