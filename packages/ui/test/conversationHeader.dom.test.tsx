import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, ID, Message, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";

/**
 * The conversation's header (UX-23): its name, who is in it, Huddle and one
 * menu for the rest, with a slim line under it while there are pins.
 */
const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.toLowerCase(),
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const owner = { ...person("U_OWNER", "Owner"), role: "owner" as const };
const maya = person("U_MAYA", "Maya");
const omar = person("U_OMAR", "Omar");
const room = (id: string, name: string): Channel => ({
  id,
  type: "public",
  name,
  topic: "",
  description: "",
  creatorId: owner.id,
  archived: false,
  createdAt: 0,
});
const general = room("C_GENERAL", "general");
const design = room("C_DESIGN", "design");
const pinned = {
  id: "M_PINNED",
  channelId: general.id,
  userId: maya.id,
  text: "Standup moves to 10:30",
  seq: 4,
  createdAt: Date.UTC(2026, 8, 20, 10, 0),
  editedAt: null,
  threadRootId: null,
  replyCount: 0,
  lastReplyAt: null,
  reactions: [],
  files: [],
  pinned: true,
} as unknown as Message;

const clients: WorkspaceClient[] = [];
afterEach(() => {
  // Unmount before the globals go: the setup file's cleanup runs after this hook.
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function workspace(
  opts: { members?: ID[]; pins?: Message[]; total?: number; channelId?: ID } = {},
) {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-test-token");
  clients.push(client);
  client.store.setState({
    self: owner,
    users: { [owner.id]: owner, [maya.id]: maya, [omar.id]: omar },
    workspaceId: "W_HEADER",
    channels: { [general.id]: general, [design.id]: design },
    // Design is looked into, not joined.
    memberships: { [general.id]: 0 },
    status: "online",
  });
  writeRoute(
    client.baseUrl,
    { channelId: opts.channelId ?? general.id, threadRootId: null },
    "replace",
  );
  vi.spyOn(client, "loadTimeline").mockResolvedValue();
  vi.spyOn(client, "loadCommands").mockResolvedValue();
  const members = vi
    .spyOn(client.api, "channelMembers")
    .mockResolvedValue({ memberIds: opts.members ?? [owner.id, maya.id] });
  const pins = vi.spyOn(client.api, "listPins").mockResolvedValue({
    messages: opts.pins ?? [],
    nextCursor: null,
    total: opts.total ?? opts.pins?.length ?? 0,
  });
  const search = vi
    .spyOn(client.api, "search")
    .mockResolvedValue({ messages: [], nextCursor: null });
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };
  const { container } = render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <WorkspaceScreen
          client={client}
          platform={platform}
          onLeaveWorkspace={() => {}}
          onSignedOut={() => {}}
        />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  // The screen checks the saved access before it shows the workspace.
  await screen.findByRole("button", { name: /^Members/ }, { timeout: 3_000 });
  const header = container.querySelector<HTMLElement>("header.channel-header")!;
  return { client, header, members, pins, search };
}

describe("the conversation's header", () => {
  it("has the name and three controls: who is here, Huddle and a menu", async () => {
    const { header } = await workspace();
    await within(header).findByRole("button", { name: "Members (2)" });
    const names = within(header)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    // The first opens the drawer, on a phone only.
    expect(names).toEqual([
      "Open navigation",
      "#general",
      "Members (2)",
      "Start a huddle",
      "Conversation options",
    ]);
    expect(within(header).queryByRole("searchbox")).toBeNull();
  });

  it("opens the member list from the faces, and both count again when someone joins", async () => {
    const user = userEvent.setup();
    const { client, header, members } = await workspace();
    const button = await within(header).findByRole("button", { name: "Members (2)" });
    await user.click(button);
    const panel = await screen.findByRole("complementary", { name: "Members" });
    await within(panel).findByText("Maya");
    expect(button).toHaveAttribute("aria-pressed", "true");

    members.mockResolvedValue({ memberIds: [owner.id, maya.id, omar.id] });
    act(() =>
      client.store.setState((s) => ({ memberChanges: { ...s.memberChanges, [general.id]: 9 } })),
    );
    expect(await within(header).findByRole("button", { name: "Members (3)" })).toBeInTheDocument();
    expect(await within(panel).findByText("Omar")).toBeInTheDocument();
  });

  it("offers pins, search here, notification settings and details from its menu", async () => {
    const user = userEvent.setup();
    const { header, search } = await workspace();
    await user.click(within(header).getByRole("button", { name: "Conversation options" }));
    const menu = await screen.findByRole("menu", { name: "Conversation options" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Pinned messages",
      "Search in #general",
      "Notification settings",
      "Channel details",
    ]);

    await user.click(within(menu).getByRole("menuitem", { name: "Search in #general" }));
    const dialog = await screen.findByRole("dialog", { name: "Search messages" });
    expect(within(dialog).getByRole("combobox", { name: "Conversation" })).toHaveValue(general.id);
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(
        "",
        30,
        expect.objectContaining({ channelId: general.id }),
      ),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(within(header).getByRole("button", { name: "Conversation options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Notification settings" }));
    const details = await screen.findByRole("dialog", { name: "#general" });
    expect(within(details).getByRole("tab", { name: "Notifications" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("has no notification settings in a channel only looked into", async () => {
    const user = userEvent.setup();
    const { header } = await workspace({ channelId: design.id });
    await within(header).findByRole("heading", { name: "#design" });
    await user.click(within(header).getByRole("button", { name: "Conversation options" }));
    const menu = await screen.findByRole("menu", { name: "Conversation options" });
    expect(within(menu).queryByRole("menuitem", { name: "Notification settings" })).toBeNull();
  });
});

describe("the pinned line", () => {
  it("says how many and the newest, opens the Pinned panel, and goes with the last pin", async () => {
    const user = userEvent.setup();
    const { client, pins } = await workspace({ pins: [pinned], total: 2 });
    const bar = await screen.findByRole("button", { name: "2 pinned: Standup moves to 10:30" });
    // One pin is all it needs, with the count.
    expect(pins).toHaveBeenCalledWith(general.id, expect.anything(), undefined, 1);

    await user.click(bar);
    expect(await screen.findByRole("complementary", { name: "Pinned" })).toBeInTheDocument();
    expect(bar).toHaveAttribute("aria-pressed", "true");

    pins.mockResolvedValue({ messages: [], nextCursor: null, total: 0 });
    act(() =>
      client.store.setState((s) => ({ changedContent: { ...s.changedContent, [general.id]: 9 } })),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: /pinned:/ })).toBeNull());
  });

  it("is not there without pins, and says only Pinned to a server that does not count", async () => {
    const { pins } = await workspace();
    await waitFor(() => expect(pins).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /pinned/i })).toBeNull();
    cleanup();

    const older = await workspace({ pins: [pinned] });
    older.pins.mockResolvedValue({ messages: [pinned], nextCursor: "next" });
    act(() =>
      older.client.store.setState((s) => ({
        changedContent: { ...s.changedContent, [general.id]: 9 },
      })),
    );
    expect(
      await screen.findByRole("button", { name: "Pinned: Standup moves to 10:30" }),
    ).toBeInTheDocument();
  });
});
