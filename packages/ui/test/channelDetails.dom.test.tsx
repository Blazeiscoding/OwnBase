import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { ChannelDetailsDialog } from "../src/components/ChannelDetailsDialog.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Channel details: each change that cannot be undone by a click asks first,
 * and a refusal is said in words rather than as the server's code.
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
};
const alex: User = {
  ...sam,
  id: "U_ALEX",
  handle: "alex",
  displayName: "Alex Chen",
  role: "member",
};

const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  managerIds: [],
};

afterEach(() => vi.restoreAllMocks());

function details(channel: Channel = design) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [alex.id]: alex },
    channels: { [channel.id]: channel },
    memberships: { [channel.id]: 0 },
    status: "online",
  });
  const api = {
    members: vi
      .spyOn(client.api, "channelMembers")
      .mockResolvedValue({ memberIds: [sam.id, alex.id] }),
    update: vi
      .spyOn(client.api, "updateChannel")
      .mockImplementation(async (_id, patch) => ({ channel: { ...channel, ...patch } }) as never),
    leave: vi.spyOn(client.api, "leaveChannel").mockResolvedValue({ ok: true } as never),
    remove: vi.spyOn(client.api, "removeChannelMember").mockResolvedValue({ ok: true } as never),
    manager: vi.spyOn(client.api, "setChannelManager").mockResolvedValue({ channel } as never),
  };
  const onLeft = vi.fn();
  render(
    <ClientContext.Provider value={client}>
      <ChannelDetailsDialog
        channelId={channel.id}
        onClose={() => {}}
        onLeft={onLeft}
        onOpenProfile={() => {}}
        onChangeParticipants={() => {}}
      />
    </ClientContext.Provider>,
  );
  const dialog = within(screen.getByRole("dialog"));
  return { api, client, dialog, onLeft, user: userEvent.setup() };
}

describe("channel details", () => {
  it("says in words why a save was refused, or that the workspace could not be reached", async () => {
    const { api, dialog, user } = details();
    api.update.mockRejectedValueOnce(new ApiError(409, "name_taken", "name_taken"));
    const name = dialog.getByRole("textbox", { name: "Channel name" });
    await user.clear(name);
    await user.type(name, "general");
    await user.click(dialog.getByRole("button", { name: "Save changes" }));
    // A name in use is said under the name, with the cursor put back in it.
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "Another channel already has that name.",
    );
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Another channel already has that name.");

    api.update.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await user.click(dialog.getByRole("button", { name: "Save changes" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "Could not save channel details. Check your connection and try again.",
    );
    expect(dialog.getByRole("alert")).not.toHaveTextContent("Failed to fetch");
    // That one is about no field, so the name is no longer marked.
    expect(name).not.toHaveAttribute("aria-invalid");
  });

  it("says there is nothing to save, or that the name is missing, rather than greying out Save", async () => {
    const { api, dialog, user } = details();
    const save = dialog.getByRole("button", { name: "Save changes" });
    const name = dialog.getByRole("textbox", { name: "Channel name" });
    expect(save).toBeEnabled();
    expect(save).not.toHaveAttribute("aria-disabled");

    // Unchanged, nothing is written to everyone in the channel again.
    await user.click(save);
    expect(api.update).not.toHaveBeenCalled();
    expect(
      dialog.getByText("Nothing to save: the name, topic and description are as they were."),
    ).toHaveAttribute("role", "status");
    expect(dialog.queryByRole("alert")).toBeNull();

    await user.clear(name);
    expect(dialog.queryByText(/Nothing to save/)).toBeNull();
    await user.type(dialog.getByRole("textbox", { name: "Topic" }), "Launch week");
    await user.click(save);
    expect(api.update).not.toHaveBeenCalled();
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Give the channel a name.");
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);

    await user.type(name, "design-studio{Enter}");
    expect(api.update).toHaveBeenCalledWith(design.id, {
      name: "design-studio",
      topic: "Launch week",
      description: "",
    });
    expect(await dialog.findByText("Saved.")).toHaveAttribute("role", "status");
    expect(name).not.toHaveAttribute("aria-invalid");
  });

  it("asks before archiving, and Cancel leaves the channel open", async () => {
    const { api, dialog, user } = details();
    await user.click(dialog.getByRole("button", { name: "Archive channel" }));
    expect(dialog.getByText("Archive #design for everyone?")).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(api.update).not.toHaveBeenCalled();

    await user.click(dialog.getByRole("button", { name: "Archive channel" }));
    await user.click(dialog.getByRole("button", { name: "Confirm archive" }));
    expect(api.update).toHaveBeenCalledWith(design.id, { archived: true });
  });

  it("leaves a public channel at once, since it can be joined again", async () => {
    const { api, dialog, onLeft, user } = details();
    await user.click(dialog.getByRole("button", { name: "Leave channel" }));
    expect(api.leave).toHaveBeenCalledWith(design.id);
    expect(onLeft).toHaveBeenCalledOnce();
  });

  it("asks before leaving a private channel, which only an invitation reopens", async () => {
    const leads: Channel = { ...design, id: "C_LEADS", name: "leads", type: "private" };
    const { api, dialog, onLeft, user } = details(leads);
    await user.click(dialog.getByRole("button", { name: "Leave channel" }));
    expect(dialog.getByText(/Leave #leads\? It is private/)).toBeVisible();
    expect(dialog.queryByRole("button", { name: "Leave channel" })).toBeNull();
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(api.leave).not.toHaveBeenCalled();

    await user.click(dialog.getByRole("button", { name: "Leave channel" }));
    await user.click(dialog.getByRole("button", { name: "Confirm leave" }));
    expect(api.leave).toHaveBeenCalledWith(leads.id);
    expect(onLeft).toHaveBeenCalledOnce();
  });

  it("stays open and says why when leaving fails", async () => {
    const { api, dialog, onLeft, user } = details();
    api.leave.mockRejectedValueOnce(new ApiError(404, "channel_not_found", "channel_not_found"));
    await user.click(dialog.getByRole("button", { name: "Leave channel" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "This conversation is no longer available to you.",
    );
    expect(onLeft).not.toHaveBeenCalled();
  });

  it("asks before removing someone, saying what they keep", async () => {
    const { api, dialog, user } = details();
    await user.click(dialog.getByRole("tab", { name: /Members/ }));
    // What can be done to someone is in the menu at the end of their row.
    await user.click(await dialog.findByRole("button", { name: "Actions for Alex Chen" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from #design" }));
    expect(
      dialog.getByText(
        "Remove Alex Chen from #design? This public channel remains readable, and they can rejoin. Their messages remain.",
      ),
    ).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(api.remove).not.toHaveBeenCalled();

    api.remove.mockRejectedValueOnce(
      new ApiError(403, "channel_removal_forbidden", "channel_removal_forbidden"),
    );
    await user.click(dialog.getByRole("button", { name: "Actions for Alex Chen" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from #design" }));
    await user.click(dialog.getByRole("button", { name: "Confirm removal" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "You cannot remove this person from this channel.",
    );
    expect(dialog.getByRole("tab", { name: "Members (2)" })).toBeVisible();

    await user.click(dialog.getByRole("button", { name: "Confirm removal" }));
    expect(api.remove).toHaveBeenLastCalledWith(design.id, alex.id);
    expect(await dialog.findByRole("tab", { name: "Members (1)" })).toBeVisible();
  });

  it("asks before making someone a manager, saying what they may then do", async () => {
    const { api, dialog, user } = details();
    await user.click(dialog.getByRole("tab", { name: /Members/ }));
    await user.click(await dialog.findByRole("button", { name: "Actions for Alex Chen" }));
    await user.click(screen.getByRole("menuitem", { name: "Make channel manager" }));
    expect(
      dialog.getByText(/Make Alex Chen a manager of #design\? They can edit, rename and archive/),
    ).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "Confirm role change" }));
    expect(api.manager).toHaveBeenCalledWith(design.id, alex.id, true);
  });

  it("asks before leaving a group conversation", async () => {
    const group: Channel = {
      ...design,
      id: "G1",
      type: "group_dm",
      name: "",
      memberIds: [sam.id, alex.id, "U_PRIYA"],
    };
    const { api, dialog, onLeft, user } = details(group);
    await user.click(dialog.getByRole("tab", { name: /Members/ }));
    await user.click(dialog.getByRole("button", { name: "Leave group conversation" }));
    expect(dialog.getByText(/Leave this group conversation\?/)).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "Confirm leave" }));
    expect(api.leave).toHaveBeenCalledWith("G1");
    expect(onLeft).toHaveBeenCalledOnce();
  });
});

describe("notification settings", () => {
  it("says when a choice was not saved, shows what the workspace has, and tries again", async () => {
    const { client, dialog, user } = details();
    const save = vi
      .spyOn(client.api, "setChannelPrefs")
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async (_id, body) => ({
        prefs: { notifyLevel: "mentions", muted: false, ...body },
      }));
    await user.click(dialog.getByRole("tab", { name: "Notifications" }));
    const mute = dialog.getByRole("checkbox", { name: /Mute this channel/ });
    await user.click(mute);

    const alert = await dialog.findByRole("alert");
    expect(alert).toHaveTextContent(/not saved/);
    expect(mute).not.toBeChecked();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(save).toHaveBeenLastCalledWith("C_DESIGN", { muted: true });
    await vi.waitFor(() => expect(dialog.queryByRole("alert")).toBeNull());
    expect(mute).toBeChecked();
  });

  it("does not speak for a star that was not saved, which says so where it was chosen", async () => {
    const { client, dialog, user } = details();
    vi.spyOn(client.api, "setChannelPrefs").mockRejectedValueOnce(new Error("offline"));
    client.setChannelPrefs("C_DESIGN", { starred: true });
    await vi.waitFor(() =>
      expect(client.state.prefsWrites.C_DESIGN).toEqual({
        saving: false,
        failed: { starred: true },
      }),
    );
    await user.click(dialog.getByRole("tab", { name: "Notifications" }));
    expect(dialog.queryByRole("alert")).toBeNull();
  });
});
