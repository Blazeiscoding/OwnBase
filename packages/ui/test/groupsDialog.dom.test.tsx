import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { User, UserGroup } from "@ownbase/protocol";
import { render } from "./render.js";
import { ClientContext } from "../src/context.js";
import { GroupsDialog, handleFromName } from "../src/components/GroupsDialog.js";
import { PeopleDialog } from "../src/components/PeopleDialog.js";
import { Navigation, NavigationContext } from "../src/lib/navigation.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * The Groups window (J13 follow-up): a list, and a view of its own for making
 * or changing a group, name first, its handle made from the name, people
 * added by search, taken handles said as they are typed.
 */
const person = (id: string, handle: string, displayName: string, over: Partial<User> = {}) =>
  ({
    id,
    handle,
    displayName,
    role: "member",
    canInvite: true,
    statusText: "",
    statusEmoji: "",
    isBot: false,
    deactivated: false,
    dndUntil: null,
    createdAt: 0,
    ...over,
  }) satisfies User;

const owner = person("U_SAM", "sam", "Sam Rivera", { role: "owner" });
const alex = person("U_ALEX", "alex", "Alex Chen");
const priya = person("U_PRIYA", "priya", "Priya Shah");
const bot = person("U_BOT", "deploy-bot", "Deploys", { isBot: true });
const design: UserGroup = {
  id: "G1",
  handle: "design",
  name: "Design",
  description: "",
  memberIds: [owner.id, alex.id],
};

function workspace(groups: UserGroup[] = []) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: owner,
    users: Object.fromEntries([owner, alex, priya, bot].map((u) => [u.id, u])),
    userGroups: Object.fromEntries(groups.map((g) => [g.id, g])),
    status: "online",
  });
  return client;
}

function groupsWindow(groups: UserGroup[] = []) {
  const client = workspace(groups);
  render(
    <ClientContext.Provider value={client}>
      <GroupsDialog onClose={() => {}} />
    </ClientContext.Provider>,
  );
  return { client, user: userEvent.setup() };
}

const dialog = (name: string) => screen.getByRole("dialog", { name });

describe("making a group", () => {
  it("starts from an empty list that says what a group is for", async () => {
    const { user } = groupsWindow();
    const list = dialog("Groups");
    expect(list).toHaveTextContent("A group lets anyone mention several people at once");
    await user.click(within(list).getByRole("button", { name: "New group" }));
    expect(dialog("New group")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
  });

  it("takes the name first and makes the handle from it, until a handle is typed", async () => {
    const { user } = groupsWindow();
    await user.click(screen.getByRole("button", { name: "New group" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Design ops");
    const handle = screen.getByRole("textbox", { name: "Handle" });
    expect(handle).toHaveValue("design-ops");
    await user.clear(handle);
    await user.type(handle, "dops");
    await user.type(screen.getByRole("textbox", { name: "Name" }), " team");
    expect(handle).toHaveValue("dops");
  });

  it("adds people by search, offers no apps, and lets one be taken out again", async () => {
    const { client, user } = groupsWindow();
    const create = vi
      .spyOn(client, "createUserGroup")
      .mockResolvedValue({ ...design, handle: "design", memberIds: [priya.id] });
    await user.click(screen.getByRole("button", { name: "New group" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Design");
    const search = screen.getByRole("combobox", { name: "Add people" });
    await user.type(search, "deploy");
    expect(screen.queryByRole("option", { name: /Deploys/ })).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "alex{Enter}");
    await user.type(search, "priya{Enter}");
    const chosen = screen.getByRole("list", { name: "People in the group" });
    expect(within(chosen).getAllByRole("listitem")).toHaveLength(2);
    await user.click(within(chosen).getByRole("button", { name: "Remove Alex Chen" }));
    expect(await accessibilityProblems(dialog("New group"))).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Make group" }));
    expect(create).toHaveBeenCalledWith({
      handle: "design",
      name: "Design",
      description: "",
      memberIds: [priya.id],
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Made @design. Anyone can mention it in a conversation now.",
    );
    expect(dialog("Groups")).toBeInTheDocument();
  });

  it("says a handle is taken as it is typed, and sends nothing", async () => {
    const { client, user } = groupsWindow([design]);
    const create = vi.spyOn(client, "createUserGroup");
    await user.click(screen.getByRole("button", { name: "New group" }));
    const handle = screen.getByRole("textbox", { name: "Handle" });
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Alex");
    expect(handle).toHaveAccessibleDescription(
      expect.stringContaining("@alex is Alex Chen's handle. Choose another."),
    );
    await user.clear(handle);
    await user.type(handle, "design");
    expect(handle).toHaveAccessibleDescription(
      expect.stringContaining("@design is the group Design."),
    );
    await user.clear(handle);
    await user.type(handle, "here");
    expect(handle).toHaveAccessibleDescription(
      expect.stringContaining("@here already means everyone in a conversation."),
    );
    await user.click(screen.getByRole("button", { name: "Make group" }));
    expect(create).not.toHaveBeenCalled();
    expect(handle).toHaveFocus();
  });

  it("puts the server's handle_taken at the handle", async () => {
    const { client, user } = groupsWindow();
    vi.spyOn(client, "createUserGroup").mockResolvedValue(
      new ApiError(409, "handle_taken", "@ops is taken. Choose another handle."),
    );
    await user.click(screen.getByRole("button", { name: "New group" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Ops");
    await user.click(screen.getByRole("button", { name: "Make group" }));
    const handle = screen.getByRole("textbox", { name: "Handle" });
    expect(handle).toHaveAccessibleDescription(expect.stringContaining("@ops is taken."));
    expect(handle).toHaveFocus();
  });

  it("asks before going back with something typed", async () => {
    const { user } = groupsWindow();
    await user.click(screen.getByRole("button", { name: "New group" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Design");
    await user.click(screen.getByRole("button", { name: "All groups" }));
    const ask = await screen.findByRole("dialog", { name: "Discard the new group?" });
    await user.click(within(ask).getByRole("button", { name: "Discard" }));
    expect(dialog("Groups")).toBeInTheDocument();
  });
});

describe("the list of groups", () => {
  it("shows how many each holds and opens one to change who is in it", async () => {
    const { client, user } = groupsWindow([design]);
    const update = vi.spyOn(client, "updateUserGroup").mockResolvedValue(design);
    await user.click(screen.getByRole("button", { name: "Edit Design, @design, 2 people" }));
    const form = dialog("Edit @design");
    expect(screen.getByRole("textbox", { name: "Handle" })).toHaveValue("design");
    await user.click(within(form).getByRole("button", { name: "Remove Alex Chen" }));
    await user.click(within(form).getByRole("button", { name: "Save changes" }));
    expect(update).toHaveBeenCalledWith("G1", {
      handle: "design",
      name: "Design",
      description: "",
      memberIds: [owner.id],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved @design.");
  });

  it("deletes from the row's menu, asking first and saying how many it holds", async () => {
    const { client, user } = groupsWindow([design]);
    const remove = vi.spyOn(client, "deleteUserGroup").mockResolvedValue(null);
    await user.click(screen.getByRole("button", { name: "Actions for @design" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete group" }));
    const ask = await screen.findByRole("dialog", { name: "Delete @design?" });
    expect(ask).toHaveTextContent("It holds 2 people.");
    expect(remove).not.toHaveBeenCalled();
    await user.click(within(ask).getByRole("button", { name: "Delete group" }));
    expect(remove).toHaveBeenCalledWith("G1");
    expect(await screen.findByRole("status")).toHaveTextContent("Deleted @design.");
  });
});

describe("finding the Groups window", () => {
  it("is named in People, which opens it", async () => {
    const client = workspace();
    vi.spyOn(client.api, "listAllUsers").mockResolvedValue({ users: [] });
    const navigation = new Navigation(client, client.baseUrl, { channelId: null });
    render(
      <ClientContext.Provider value={client}>
        <NavigationContext.Provider value={navigation}>
          <PeopleDialog onClose={() => {}} />
        </NavigationContext.Provider>
      </ClientContext.Provider>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Make a group" }));
    expect(navigation.store.getState().dialog).toEqual({ kind: "groups" });
  });
});

describe("handleFromName", () => {
  it("makes a handle people can type from a name", () => {
    expect(handleFromName("Design ops")).toBe("design-ops");
    expect(handleFromName("  Café Crew! ")).toBe("cafe-crew");
    expect(handleFromName("__QA__")).toBe("qa");
  });
});
