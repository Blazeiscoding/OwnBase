import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { ChannelDetailsDialog } from "../src/components/ChannelDetailsDialog.js";
import { accessibilityProblems } from "./accessibility.js";

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

const channel: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function membersDialog() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [alex.id]: alex },
    channels: { [channel.id]: channel },
    status: "online",
  });
  const user = userEvent.setup();
  async function renderMembers() {
    render(
      <ClientContext.Provider value={client}>
        <ChannelDetailsDialog
          channelId={channel.id}
          onClose={() => {}}
          onLeft={() => {}}
          onOpenProfile={() => {}}
          onChangeParticipants={() => {}}
        />
      </ClientContext.Provider>,
    );
    const dialog = screen.getByRole("dialog", { name: "#general" });
    await user.click(within(dialog).getByRole("tab", { name: "Members" }));
    return dialog;
  }
  return { client, user, renderMembers };
}

afterEach(() => vi.restoreAllMocks());

describe("Channel members list status", () => {
  it("does not report zero members before the first load succeeds, and recovers from failure", async () => {
    const { client, user, renderMembers } = membersDialog();
    const firstLoad = deferred<{ memberIds: string[] }>();
    const retryLoad = deferred<{ memberIds: string[] }>();
    const channelMembers = vi
      .spyOn(client.api, "channelMembers")
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementationOnce(() => retryLoad.promise);
    const dialog = await renderMembers();
    const status = within(dialog).getByRole("status");

    expect(status).toHaveTextContent("Loading members…");
    expect(within(dialog).getByRole("tab", { name: "Members" })).toBeVisible();
    expect(within(dialog).queryByText(/No members were returned/)).not.toBeInTheDocument();

    await act(async () => firstLoad.reject(new Error("offline")));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Could not load members. Check your connection and try again.",
    );
    expect(within(dialog).getByRole("tab", { name: "Members" })).toBeVisible();
    expect(within(dialog).queryByText(/No members were returned/)).not.toBeInTheDocument();

    const retry = within(dialog).getByRole("button", { name: "Retry" });
    retry.focus();
    await user.keyboard("{Enter}");
    expect(channelMembers).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Loading members…");
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByRole("tab", { name: "Members" })).toBeVisible();

    await act(async () => retryLoad.resolve({ memberIds: [] }));
    expect(within(dialog).getByRole("status")).toBe(status);
    expect(status).toHaveTextContent(
      "No members were returned. Refresh to check this conversation.",
    );
    expect(within(dialog).getByRole("tab", { name: "Members (0)" })).toBeVisible();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(status.parentElement).toHaveFocus();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("preserves the displayed members and count if a refresh fails, then updates on Retry", async () => {
    const { client, user, renderMembers } = membersDialog();
    const refresh = deferred<{ memberIds: string[] }>();
    const channelMembers = vi
      .spyOn(client.api, "channelMembers")
      .mockResolvedValueOnce({ memberIds: [sam.id, alex.id] })
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValueOnce({ memberIds: [sam.id] });
    const dialog = await renderMembers();
    const list = within(dialog).getByRole("list", { name: "Channel members" });
    expect(await within(list).findByText("Alex Chen")).toBeVisible();
    expect(within(dialog).getByRole("tab", { name: "Members (2)" })).toBeVisible();
    const status = within(dialog).getByRole("status");

    await user.click(within(dialog).getByRole("button", { name: "Refresh members" }));
    expect(status).toHaveTextContent("Loading members…");
    expect(within(list).getByText("Alex Chen")).toBeVisible();
    expect(within(dialog).getByRole("tab", { name: "Members (2)" })).toBeVisible();

    await act(async () => refresh.reject(new Error("offline")));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Could not load members.");
    expect(within(list).getByText("Alex Chen")).toBeVisible();
    expect(within(dialog).getByRole("tab", { name: "Members (2)" })).toBeVisible();
    expect(within(dialog).queryByText(/No members were returned/)).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(channelMembers).toHaveBeenCalledTimes(3);
    expect(within(dialog).getByRole("status")).toBe(status);
    expect(within(dialog).getByRole("tab", { name: "Members (1)" })).toBeVisible();
    expect(within(list).queryByText("Alex Chen")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("channel details tabs", () => {
  it("are tabs: one selected, one Tab stop, and the arrow keys move between them", async () => {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({
      self: sam,
      users: { [sam.id]: sam, [alex.id]: alex },
      channels: { [channel.id]: channel },
      status: "online",
    });
    vi.spyOn(client.api, "channelMembers").mockResolvedValue({ memberIds: [sam.id] } as never);
    const user = userEvent.setup();
    render(
      <ClientContext.Provider value={client}>
        <ChannelDetailsDialog
          channelId={channel.id}
          onClose={() => {}}
          onLeft={() => {}}
          onOpenProfile={() => {}}
          onChangeParticipants={() => {}}
        />
      </ClientContext.Provider>,
    );
    const dialog = screen.getByRole("dialog", { name: "#general" });
    const tabs = within(dialog).getByRole("tablist", { name: "Channel details" });
    const about = within(tabs).getByRole("tab", { name: "About" });
    expect(about).toHaveAttribute("aria-selected", "true");
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.tabIndex),
    ).toEqual([0, -1, -1]);
    expect(within(dialog).getByRole("tabpanel", { name: "About" })).toBeVisible();

    about.focus();
    await user.keyboard("{ArrowRight}");
    const members = within(tabs).getByRole("tab", { name: /^Members/ });
    expect(members).toHaveFocus();
    expect(members).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(within(tabs).getByRole("tab", { name: "Notifications" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(about).toHaveFocus();
    expect(within(dialog).getByRole("tabpanel", { name: "About" })).toBeVisible();
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });
});
