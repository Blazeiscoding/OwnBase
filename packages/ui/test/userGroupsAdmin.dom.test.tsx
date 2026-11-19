import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { User, UserGroup } from "@ownbase/protocol";
import { render } from "./render.js";
import { ClientContext } from "../src/context.js";
import { PeopleDialog } from "../src/components/PeopleDialog.js";
import { accessibilityProblems } from "./accessibility.js";

/** User groups in People (J13): admins make, change and delete them there. */
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
const bot = person("U_BOT", "deploy-bot", "Deploys", { isBot: true });
const design: UserGroup = {
  id: "G1",
  handle: "design",
  name: "Design",
  description: "",
  memberIds: [owner.id, alex.id],
};

async function people(groups: UserGroup[] = []) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const users = [owner, alex, bot];
  client.store.setState({
    self: owner,
    users: Object.fromEntries(users.map((u) => [u.id, u])),
    userGroups: Object.fromEntries(groups.map((g) => [g.id, g])),
    status: "online",
  });
  vi.spyOn(client.api, "listAllUsers").mockResolvedValue({
    users: users.map((u) => ({ ...u, lastSeenAt: null, twoStep: false })),
  });
  render(
    <ClientContext.Provider value={client}>
      <PeopleDialog onClose={() => {}} />
    </ClientContext.Provider>,
  );
  const dialog = screen.getByRole("dialog", { name: "People" });
  await within(dialog).findByText("@alex");
  return { client, root: dialog, dialog: within(dialog), user: userEvent.setup() };
}

describe("groups in People", () => {
  it("makes a group with a handle, a name and the people chosen, apps not offered", async () => {
    const { client, dialog, root, user } = await people();
    const create = vi.spyOn(client, "createUserGroup").mockResolvedValue({
      ...design,
      memberIds: [alex.id],
    });
    expect(dialog.getByText("No groups yet.")).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "New group" }));
    await user.type(dialog.getByRole("textbox", { name: /Handle/ }), "@Design");
    await user.type(dialog.getByRole("textbox", { name: "Name" }), "Design");
    expect(dialog.queryByRole("checkbox", { name: /Deploys/ })).not.toBeInTheDocument();
    await user.click(dialog.getByRole("checkbox", { name: /Alex Chen/ }));
    expect(await accessibilityProblems(root)).toEqual([]);
    await user.click(dialog.getByRole("button", { name: "Make group" }));
    expect(create).toHaveBeenCalledWith({
      handle: "design",
      name: "Design",
      description: "",
      memberIds: [alex.id],
    });
    expect(await dialog.findByRole("button", { name: "New group" })).toBeInTheDocument();
  });

  it("says a handle someone has is taken, at the field", async () => {
    const { client, dialog, user } = await people();
    vi.spyOn(client, "createUserGroup").mockResolvedValue(
      new ApiError(409, "handle_taken", "@alex is taken. Choose another handle."),
    );
    await user.click(dialog.getByRole("button", { name: "New group" }));
    await user.type(dialog.getByRole("textbox", { name: /Handle/ }), "alex");
    await user.type(dialog.getByRole("textbox", { name: "Name" }), "Alex fans");
    await user.click(dialog.getByRole("button", { name: "Make group" }));
    const handle = dialog.getByRole("textbox", { name: /Handle/ });
    expect(handle).toHaveAccessibleDescription(
      expect.stringContaining("@alex is taken by a person or another group"),
    );
    expect(handle).toHaveFocus();
  });

  it("lists each group with how many it holds, and changes who is in one", async () => {
    const { client, dialog, user } = await people([design]);
    expect(dialog.getByText("2 people")).toBeInTheDocument();
    const update = vi.spyOn(client, "updateUserGroup").mockResolvedValue(design);
    await user.click(dialog.getByRole("button", { name: "Edit @design" }));
    await user.click(dialog.getByRole("checkbox", { name: /Alex Chen/ }));
    await user.click(dialog.getByRole("button", { name: "Save group" }));
    expect(update).toHaveBeenCalledWith("G1", {
      handle: "design",
      name: "Design",
      description: "",
      memberIds: [owner.id],
    });
  });

  it("asks before deleting a group, saying how many it holds", async () => {
    const { client, dialog, user } = await people([design]);
    const remove = vi.spyOn(client, "deleteUserGroup").mockResolvedValue(null);
    await user.click(dialog.getByRole("button", { name: "Delete @design" }));
    const ask = await screen.findByRole("dialog", { name: "Delete @design?" });
    expect(ask).toHaveTextContent("It holds 2 people.");
    expect(remove).not.toHaveBeenCalled();
    await user.click(within(ask).getByRole("button", { name: "Delete group" }));
    expect(remove).toHaveBeenCalledWith("G1");
  });
});
