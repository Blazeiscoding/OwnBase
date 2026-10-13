import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { BrowseChannelsDialog } from "../src/components/dialogs.js";

/**
 * Browse channels: active and archived are two tabs, a channel is found by
 * what it is about as well as its name, and a join that fails says so.
 */
const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

function room(id: string, name: string, extra: Partial<Channel> = {}): Channel {
  return {
    id,
    type: "public",
    name,
    topic: "",
    description: "",
    creatorId: sam.id,
    archived: false,
    createdAt: 0,
    ...extra,
  };
}

const general = room("C_GENERAL", "general");
const design = room("C_DESIGN", "design", { description: "Mockups and critique" });
const secret = room("C_SECRET", "launch", { type: "private" });
const old = room("C_OLD", "old-project", { archived: true });

afterEach(() => vi.restoreAllMocks());

function browse() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: Object.fromEntries([general, design, secret, old].map((c) => [c.id, c])),
    memberships: { [general.id]: 0, [secret.id]: 0 },
    status: "online",
  });
  const join = vi.spyOn(client.api, "joinChannel");
  const onOpen = vi.fn();
  render(
    <ClientContext.Provider value={client}>
      <BrowseChannelsDialog onClose={() => {}} onOpen={onOpen} />
    </ClientContext.Provider>,
  );
  const dialog = within(screen.getByRole("dialog"));
  const names = () =>
    dialog.queryAllByRole("listitem").map((row) => row.querySelector(".font-medium")?.textContent);
  return { dialog, join, names, onOpen, user: userEvent.setup() };
}

describe("browse channels", () => {
  it("lists active channels, and archived ones on a tab of their own", async () => {
    const { dialog, names, user } = browse();
    expect(dialog.getByRole("tab", { name: "Active" })).toHaveAttribute("aria-selected", "true");
    expect(names()).toEqual(["design", "general", "launch"]);
    expect(dialog.getByText("Private")).toBeInTheDocument();
    // The tabs and the filter stay over the channels, which are what scrolls.
    const scroller = document.querySelector(".dialog-scroll")!;
    expect(scroller).toContainElement(dialog.getByRole("button", { name: /#design$/ }));
    expect(scroller).not.toContainElement(dialog.getByRole("tablist"));
    expect(scroller).not.toContainElement(dialog.getByRole("textbox", { name: "Filter channels" }));

    await user.click(dialog.getByRole("tab", { name: "Archived (1)" }));
    expect(names()).toEqual(["old-project"]);
    expect(dialog.getByRole("button", { name: "Open #old-project" })).toBeVisible();
  });

  it("finds a channel by its description", async () => {
    const { dialog, names, user } = browse();
    await user.type(dialog.getByRole("textbox", { name: "Filter channels" }), "critique");
    expect(names()).toEqual(["design"]);

    await user.clear(dialog.getByRole("textbox", { name: "Filter channels" }));
    await user.type(dialog.getByRole("textbox", { name: "Filter channels" }), "nothing like it");
    expect(dialog.getByText("No channels match.")).toBeVisible();
  });

  it("opens a channel once joined, and says so when joining fails", async () => {
    const { dialog, join, onOpen, user } = browse();
    join.mockRejectedValueOnce(new Error("offline"));
    await user.click(dialog.getByRole("button", { name: "Join #design" }));
    expect(dialog.getByRole("alert")).toHaveTextContent(
      "Could not join #design. Check your connection and try again.",
    );
    expect(onOpen).not.toHaveBeenCalled();

    join.mockResolvedValueOnce({ ok: true });
    await user.click(dialog.getByRole("button", { name: "Join #design" }));
    expect(join).toHaveBeenLastCalledWith(design.id);
    expect(onOpen).toHaveBeenCalledWith(design.id);
  });

  it("opens a channel already joined without joining it again", async () => {
    const { dialog, join, onOpen, user } = browse();
    expect(dialog.getAllByText("Joined")).toHaveLength(2);
    await user.click(dialog.getByRole("button", { name: "Open #general" }));
    expect(onOpen).toHaveBeenCalledWith(general.id);
    expect(join).not.toHaveBeenCalled();
  });
});
