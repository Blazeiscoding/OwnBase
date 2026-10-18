import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { AccessPolicy, Channel, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { WorkspaceSettings } from "../src/components/WorkspaceSettings.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Workspace settings (UX-60): the workspace's name and who may join, for its
 * owner and admins, as a page of its own.
 */
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
const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
};
const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

const clients: WorkspaceClient[] = [];
// jsdom lays nothing out, so it has nothing to scroll into view.
Element.prototype.scrollIntoView ??= () => {};
afterEach(() => {
  // Unmount before the globals go: vitest runs these hooks in reverse.
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function client(
  self: User,
  state: { accessPolicy?: AccessPolicy | null; workspaceSettings?: boolean; others?: User[] } = {},
) {
  const workspace = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(workspace);
  workspace.store.setState({
    self,
    users: Object.fromEntries([self, ...(state.others ?? [])].map((u) => [u.id, u])),
    channels: { [general.id]: general },
    memberships: { [general.id]: 0 },
    status: "online",
    workspaceName: "Rocket Team",
    workspaceSettings: state.workspaceSettings ?? true,
    accessPolicy: state.accessPolicy === undefined ? "account_required" : state.accessPolicy,
  });
  return workspace;
}

/** The page on its own, over a client whose admin calls answer from stubs. */
function page(
  options: Parameters<typeof client>[1] & { hostedHere?: boolean; role?: User["role"] } = {},
) {
  const workspace = client(person("U_SAM", "Sam Rivera", options.role ?? "owner"), options);
  const rename = vi
    .spyOn(workspace.api, "renameWorkspace")
    .mockImplementation(async (name) => ({ workspaceName: name.trim() }));
  const choose = vi
    .spyOn(workspace.api, "setAccessPolicy")
    .mockImplementation(async (accessPolicy) => ({ accessPolicy }));
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={workspace}>
        <ConfirmProvider>
          <WorkspaceSettings onClose={() => {}} hostedHere={options.hostedHere} />
        </ConfirmProvider>
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Workspace settings" });
  return { client: workspace, dialog, rename, choose, user: userEvent.setup() };
}

/** The whole workspace, as `role`, to find where the page opens from. */
async function workspaceAs(role: User["role"]) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const self = person("U_SAM", "Sam Rivera", role);
  const workspace = client(self);
  writeRoute(workspace.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
  vi.spyOn(workspace, "loadTimeline").mockResolvedValue();
  vi.spyOn(workspace, "loadCommands").mockResolvedValue();
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={workspace}>
        <ConfirmProvider>
          <WorkspaceScreen
            client={workspace}
            platform={platform}
            onLeaveWorkspace={() => {}}
            onSignedOut={() => {}}
          />
        </ConfirmProvider>
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const user = userEvent.setup();
  // The screen checks saved workspace access first.
  const trigger = await screen.findByRole(
    "button",
    { name: "Rocket Team, workspace menu" },
    { timeout: 3_000 },
  );
  await user.click(trigger);
  const menu = screen.getByRole("menu", { name: "Workspace" });
  return { menu, user };
}

describe("where Workspace settings opens", () => {
  it("is in the workspace menu for the owner and admins, and opens as a page", async () => {
    const { menu, user } = await workspaceAs("admin");
    await user.click(within(menu).getByRole("menuitem", { name: "Workspace settings" }));
    const settings = await screen.findByRole(
      "dialog",
      { name: "Workspace settings" },
      { timeout: 3_000 },
    );
    expect(await within(settings).findByLabelText("Workspace name")).toHaveValue("Rocket Team");
    // A place of its own: the address names it, so Back closes it and a reload reopens it.
    expect(window.location.hash).toMatch(/\/d\/workspace$/);
  });

  it("is not offered to a member or a guest", async () => {
    for (const role of ["member", "guest"] as const) {
      const { menu } = await workspaceAs(role);
      expect(within(menu).queryByRole("menuitem", { name: "Workspace settings" })).toBeNull();
      cleanup();
    }
  });
});

describe("the workspace's name", () => {
  it("checks on Save, saying what is missing under the field, and keeps a good one", async () => {
    const { dialog, rename, user, client } = page();
    const field = within(dialog).getByLabelText("Workspace name");
    const save = within(dialog).getByRole("button", { name: "Save" });
    await user.clear(field);
    // Never off until something is typed: sent empty, it says why.
    expect(save).toBeEnabled();
    await user.click(save);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Give the workspace a name.");
    expect(field).toHaveAccessibleDescription(/Give the workspace a name/);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveFocus();
    expect(rename).not.toHaveBeenCalled();

    await user.type(field, "  Blue Team ");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await user.click(save);
    expect(rename).toHaveBeenCalledWith("Blue Team");
    expect(await within(dialog).findByText("Saved")).toBeVisible();
    expect(field).toHaveValue("Blue Team");
    expect(client.state.workspaceName).toBe("Blue Team");
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("puts a refusal from the server under the field", async () => {
    const { dialog, rename, user } = page();
    rename.mockRejectedValueOnce(new ApiError(400, "invalid_request"));
    const field = within(dialog).getByLabelText("Workspace name");
    await user.clear(field);
    await user.type(field, "Blue Team");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "A workspace name has 1 to 80 characters, without tabs or line breaks.",
    );
    expect(field).toHaveFocus();
    expect(within(dialog).queryByText("Saved")).toBeNull();
  });

  it("follows a rename made elsewhere until something is typed", async () => {
    const { dialog, client, user } = page();
    const field = within(dialog).getByLabelText("Workspace name");
    client.store.setState({ workspaceName: "Green Team" });
    await waitFor(() => expect(field).toHaveValue("Green Team"));
    await user.type(field, "!");
    client.store.setState({ workspaceName: "Red Team" });
    // The page still names the workspace as it is now.
    await waitFor(() => expect(within(dialog).getByText("Red Team")).toBeVisible());
    expect(field).toHaveValue("Green Team!");
  });
});

describe("who can join", () => {
  async function joining(options: Parameters<typeof page>[0] = {}) {
    const opened = page(options);
    await opened.user.click(within(opened.dialog).getByRole("tab", { name: "Who can join" }));
    return opened;
  }

  it("offers the three rules plainly, and saves one the moment it is chosen", async () => {
    const { dialog, choose, user, client } = await joining();
    const group = within(dialog).getByRole("group", { name: "Who can join" });
    const rules = within(group).getAllByRole("radio");
    expect(rules.map((rule) => rule.getAttribute("value"))).toEqual([
      "invite_only",
      "account_required",
      "guest_allowed",
    ]);
    expect(
      within(group).getByRole("radio", { name: /Anyone who creates an account/ }),
    ).toBeChecked();
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();

    await user.click(within(group).getByRole("radio", { name: /People with an invite/ }));
    expect(choose).toHaveBeenCalledWith("invite_only");
    expect(await within(dialog).findByText("Saved")).toBeVisible();
    expect(within(group).getByRole("radio", { name: /People with an invite/ })).toBeChecked();
    expect(client.state.accessPolicy).toBe("invite_only");
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("goes back to what the workspace has when the change is refused, and says so", async () => {
    const { dialog, choose, user } = await joining();
    choose.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const group = within(dialog).getByRole("group", { name: "Who can join" });
    await user.click(within(group).getByRole("radio", { name: /Anyone, guests included/ }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Who can join was not changed.",
    );
    expect(
      within(group).getByRole("radio", { name: /Anyone who creates an account/ }),
    ).toBeChecked();
    expect(within(dialog).queryByText("Saved")).toBeNull();
  });

  it("warns that leaving guests allowed signs guests out, and asks first when there are any", async () => {
    const guest = person("U_VIC", "Vic", "guest");
    const { dialog, choose, user } = await joining({
      accessPolicy: "guest_allowed",
      others: [guest],
    });
    expect(dialog).toHaveTextContent(
      "Choosing either of the others signs every guest out at once, and nobody new can join as a guest.",
    );
    const group = within(dialog).getByRole("group", { name: "Who can join" });

    await user.click(within(group).getByRole("radio", { name: /People with an invite/ }));
    let ask = await screen.findByRole("dialog", { name: "Sign every guest out?" });
    expect(ask).toHaveTextContent("A guest has joined this workspace.");
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(choose).not.toHaveBeenCalled();
    expect(within(group).getByRole("radio", { name: /Anyone, guests included/ })).toBeChecked();

    await user.click(within(group).getByRole("radio", { name: /People with an invite/ }));
    ask = await screen.findByRole("dialog", { name: "Sign every guest out?" });
    await user.click(within(ask).getByRole("button", { name: "Sign guests out" }));
    await waitFor(() => expect(choose).toHaveBeenCalledWith("invite_only"));
    expect(await within(dialog).findByText("Saved")).toBeVisible();
  });

  it("does not ask when no guest has joined", async () => {
    const { dialog, choose, user } = await joining({ accessPolicy: "guest_allowed" });
    const group = within(dialog).getByRole("group", { name: "Who can join" });
    await user.click(within(group).getByRole("radio", { name: /Anyone who creates an account/ }));
    expect(choose).toHaveBeenCalledWith("account_required");
    expect(screen.queryByRole("dialog", { name: "Sign every guest out?" })).toBeNull();
  });

  it("says Manage hosting has the same setting, where this computer hosts it", async () => {
    const { dialog } = await joining({ hostedHere: true });
    expect(dialog).toHaveTextContent(
      "while the link is open Manage hosting shows and changes this same setting.",
    );
  });
});

describe("a workspace whose server is older", () => {
  it("shows the name and offers nothing the server would refuse", async () => {
    const { dialog, user, rename, choose } = page({
      workspaceSettings: false,
      accessPolicy: null,
    });
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "changed where it is hosted, not here",
    );
    expect(within(within(dialog).getByRole("tabpanel")).getByText("Rocket Team")).toBeVisible();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
    await user.click(within(dialog).getByRole("tab", { name: "Who can join" }));
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(rename).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });
});
