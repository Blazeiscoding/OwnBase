import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, ChannelPrefs, User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { Sidebar } from "../src/components/Sidebar.js";
import { ConversationMenu } from "../src/components/ConversationHeader.js";
import { ToastProvider } from "../src/components/Toast.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Starred conversations (UX-20): a star kept per account by the server, a
 * Starred section above Channels that holds them, and Star or Unstar in the
 * row's More menu and the conversation's `⋯` menu.
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
const sam = person("U_SAM", "Sam");
const maya = person("U_MAYA", "Maya");
const room = (id: string, name: string): Channel => ({
  id,
  type: "public",
  name,
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
});
const general = room("C_GENERAL", "general");
const design = room("C_DESIGN", "design");
const zeta = room("C_ZETA", "zeta");
const dm: Channel = { ...room("C_DM", ""), type: "dm", memberIds: [sam.id, maya.id] };

const plain: ChannelPrefs = { notifyLevel: "mentions", muted: false, starred: false };

const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  localStorage.clear();
});

/**
 * A client that never connects, whose preference requests the test answers:
 * the workspace takes them, or refuses one when told to.
 */
function workspace(options: { stars?: boolean; prefs?: Record<string, ChannelPrefs> } = {}) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  const prefs = options.prefs ?? {
    [general.id]: plain,
    [design.id]: plain,
    [zeta.id]: plain,
    [dm.id]: plain,
  };
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [maya.id]: maya },
    channels: { [general.id]: general, [design.id]: design, [zeta.id]: zeta, [dm.id]: dm },
    memberships: { [general.id]: 0, [design.id]: 0, [zeta.id]: 0, [dm.id]: 0 },
    prefs,
    stars: options.stars ?? true,
    status: "online",
    workspaceName: "Rocket Team",
  });
  const refuse = { next: false };
  const sent = vi.spyOn(client.api, "setChannelPrefs").mockImplementation(async (id, body) => {
    if (refuse.next) {
      refuse.next = false;
      throw new Error("offline");
    }
    return { prefs: { ...plain, ...client.state.prefs[id], ...body } as ChannelPrefs };
  });
  return { client, sent, refuse, user: userEvent.setup() };
}

function renderSidebar(client: WorkspaceClient, activeChannelId: string | null = general.id) {
  render(
    <ToastProvider>
      <ClientContext.Provider value={client}>
        <Sidebar
          activeChannelId={activeChannelId}
          onSelect={vi.fn()}
          onBrowseChannels={vi.fn()}
          onNewChannel={vi.fn()}
          onNewDm={vi.fn()}
          onFriends={vi.fn()}
          onSearch={vi.fn()}
          onSaved={vi.fn()}
          onActivity={vi.fn()}
          onThreads={vi.fn()}
          onEditProfile={vi.fn()}
          onInvite={vi.fn()}
          onSwitchWorkspace={vi.fn()}
          onAccountSettings={vi.fn()}
          connectionLabel={null}
        />
      </ClientContext.Provider>
    </ToastProvider>,
  );
}

const nav = () => screen.getByRole("navigation", { name: "Workspace navigation" });

/** The names of the rows under a section's header, or null when there is no such section. */
function section(name: string): string[] | null {
  // A string name matches the whole name, so "Channels" is not "Browse channels".
  const toggle = within(nav()).queryByRole("button", { name });
  if (!toggle) return null;
  const list = toggle.parentElement!.nextElementSibling!;
  return [...list.querySelectorAll<HTMLElement>(".channel-row")].map((row) =>
    // The row's own words, without its marks' labels.
    row.querySelector(".truncate")!.textContent!.trim(),
  );
}

async function rowMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: `More options for ${name}` }));
  return screen.getByRole("menu", { name: `Options for ${name}` });
}

describe("starring from a row's More menu", () => {
  it("moves the conversation into Starred, above Channels, and back again", async () => {
    const { client, sent, user } = workspace();
    renderSidebar(client);
    expect(section("Starred")).toBeNull();
    expect(section("Channels")).toEqual(["design", "general", "zeta"]);

    const menu = await rowMenu(user, "design");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Star channel", "Mute channel"]);
    expect(await accessibilityProblems(menu)).toEqual([]);
    await user.click(within(menu).getByRole("menuitem", { name: "Star channel" }));

    expect(sent).toHaveBeenLastCalledWith(design.id, { starred: true });
    expect(section("Starred")).toEqual(["design"]);
    expect(section("Channels")).toEqual(["general", "zeta"]);
    // It sits above Channels.
    const toggles = within(nav())
      .getAllByRole("button", { expanded: true })
      .map((b) => b.textContent);
    expect(toggles.indexOf("Starred")).toBeLessThan(toggles.indexOf("Channels"));
    // Focus followed the row to its new place.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "More options for design" }),
      ),
    );
    expect(await accessibilityProblems(nav())).toEqual([]);

    const again = await rowMenu(user, "design");
    await user.click(within(again).getByRole("menuitem", { name: "Unstar channel" }));
    expect(sent).toHaveBeenLastCalledWith(design.id, { starred: false });
    // With nothing starred, the section goes.
    expect(section("Starred")).toBeNull();
    expect(section("Channels")).toEqual(["design", "general", "zeta"]);
  });

  it("is reached from the keyboard, and right-click opens the same menu", async () => {
    const { client, user } = workspace();
    renderSidebar(client);
    // Tab onto the row, then along its buttons to More.
    const zetaRow = screen.getByRole("button", { name: /^#\s*zeta$/ });
    zetaRow.focus();
    await user.tab();
    expect(document.activeElement).toBe(
      within(zetaRow.closest("li")!).getByRole("button", { name: "Invite people" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "More options for zeta" }),
    );
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "Star channel" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(section("Starred")).toEqual(["zeta"]);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "More options for zeta" }),
      ),
    );

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("button", { name: /^#\s*design$/ }),
    });
    expect(screen.getByRole("menu", { name: "Options for design" })).toBeInTheDocument();
  });

  it("stars a direct message, which leaves Direct messages, and orders Starred by name", async () => {
    const { client, user } = workspace();
    renderSidebar(client);
    expect(section("Direct messages")).toEqual(["Maya"]);
    const menu = await rowMenu(user, "Maya");
    await user.click(within(menu).getByRole("menuitem", { name: "Star conversation" }));
    await user.click(
      within(await rowMenu(user, "zeta")).getByRole("menuitem", { name: "Star channel" }),
    );
    await user.click(
      within(await rowMenu(user, "design")).getByRole("menuitem", { name: "Star channel" }),
    );
    // Channels and people together, by name, as they read.
    expect(section("Starred")).toEqual(["design", "Maya", "zeta"]);
    expect(section("Direct messages")).toEqual([]);
    // Someone with a starred conversation is not asked to start their first.
    expect(screen.queryByRole("button", { name: "Send someone a message" })).toBeNull();
    expect(section("Channels")).toEqual(["general"]);
  });

  it("puts the row back and says so when the workspace refuses, with a way to try again", async () => {
    const { client, refuse, sent, user } = workspace();
    renderSidebar(client);
    refuse.next = true;
    await user.click(
      within(await rowMenu(user, "design")).getByRole("menuitem", { name: "Star channel" }),
    );
    await waitFor(() => expect(section("Starred")).toBeNull());
    expect(section("Channels")).toEqual(["design", "general", "zeta"]);
    const alert = await screen.findByText("Could not star that channel.");
    await user.click(
      within(alert.closest("[role=alert], [role=status]") ?? document.body).getByRole("button", {
        name: "Try again",
      }),
    );
    await waitFor(() => expect(section("Starred")).toEqual(["design"]));
    expect(sent).toHaveBeenCalledTimes(2);
  });
});

describe("the Starred section", () => {
  const starred = (over: Partial<ChannelPrefs> = {}) => ({ ...plain, starred: true, ...over });

  it("keeps the marks of what is in it: unread, mentions and muted", () => {
    const { client } = workspace({
      prefs: {
        [general.id]: plain,
        [design.id]: starred({ muted: true }),
        [zeta.id]: starred(),
        [dm.id]: plain,
      },
    });
    client.store.setState({
      channelLastSeq: { [zeta.id]: 5, [design.id]: 3 },
      mentionCounts: { [zeta.id]: 2 },
    });
    renderSidebar(client);
    expect(section("Starred")).toEqual(["design", "zeta"]);
    const designRow = screen.getByRole("button", { name: /^#\s*design/ });
    expect(within(designRow).getByRole("img", { name: "Muted" })).toBeInTheDocument();
    const zetaRow = screen.getByRole("button", { name: /^#\s*zeta/ });
    expect(zetaRow).toHaveClass("font-semibold");
    expect(within(zetaRow).getByLabelText("2 unread mentions in zeta")).toBeInTheDocument();
  });

  it("folds away like the others, keeping what is open or waiting, and remembers it", async () => {
    const { client, user } = workspace({
      prefs: {
        [general.id]: starred(),
        [design.id]: starred(),
        [zeta.id]: starred(),
        [dm.id]: plain,
      },
    });
    client.store.setState({ channelLastSeq: { [zeta.id]: 5 } });
    renderSidebar(client, general.id);
    const toggle = within(nav()).getByRole("button", { name: "Starred" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The open one and the unread one stay in view.
    expect(section("Starred")).toEqual(["general", "zeta"]);
    expect(JSON.parse(localStorage.getItem("tandem:collapsed-sections")!)).toContain("starred");

    // Drawn again, as after a reload, it is still folded.
    cleanup();
    renderSidebar(client, general.id);
    expect(within(nav()).getByRole("button", { name: "Starred" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("sends focus to the folded section's header when a row goes into it out of sight", async () => {
    const { client, user } = workspace({
      prefs: { [general.id]: starred(), [design.id]: plain, [zeta.id]: plain, [dm.id]: plain },
    });
    renderSidebar(client, general.id);
    await user.click(within(nav()).getByRole("button", { name: "Starred" }));
    await user.click(
      within(await rowMenu(user, "zeta")).getByRole("menuitem", { name: "Star channel" }),
    );
    expect(section("Starred")).toEqual(["general"]);
    await waitFor(() =>
      expect(document.activeElement).toBe(within(nav()).getByRole("button", { name: "Starred" })),
    );
  });

  it("leaves an archived channel out, star and all", () => {
    const { client } = workspace({
      prefs: { [general.id]: plain, [design.id]: starred(), [zeta.id]: plain, [dm.id]: plain },
    });
    client.store.setState({
      channels: { ...client.state.channels, [design.id]: { ...design, archived: true } },
    });
    renderSidebar(client);
    expect(section("Starred")).toBeNull();
    expect(section("Channels")).toEqual(["general", "zeta"]);
  });
});

describe("a server from before stars", () => {
  it("offers no Star, and its preferences without the flag read as unstarred", async () => {
    const { client, user } = workspace({
      stars: false,
      prefs: {
        [general.id]: { notifyLevel: "mentions", muted: false },
        [design.id]: { notifyLevel: "all", muted: true },
        [zeta.id]: { notifyLevel: "mentions", muted: false },
        [dm.id]: { notifyLevel: "all", muted: false },
      },
    });
    renderSidebar(client);
    expect(section("Starred")).toBeNull();
    expect(section("Channels")).toEqual(["design", "general", "zeta"]);
    const menu = await rowMenu(user, "design");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Unmute channel"]);
  });
});

describe("Mute in a row's More menu", () => {
  it("is named by what it does now", async () => {
    const { client, sent, user } = workspace();
    renderSidebar(client);
    await user.click(
      within(await rowMenu(user, "zeta")).getByRole("menuitem", { name: "Mute channel" }),
    );
    expect(sent).toHaveBeenLastCalledWith(zeta.id, { muted: true });
    const row = screen.getByRole("button", { name: /^#\s*zeta/ });
    expect(within(row).getByRole("img", { name: "Muted" })).toBeInTheDocument();
    expect(
      within(await rowMenu(user, "zeta")).getByRole("menuitem", { name: "Unmute channel" }),
    ).toBeInTheDocument();
  });
});

describe("the conversation's ⋯ menu", () => {
  function menu(client: WorkspaceClient, channelId: string, isRoom: boolean) {
    render(
      <ClientContext.Provider value={client}>
        <ConversationMenu
          channelId={channelId}
          isRoom={isRoom}
          onPins={vi.fn()}
          onNotifications={vi.fn()}
          onDetails={vi.fn()}
        />
      </ClientContext.Provider>,
    );
  }
  const items = () => screen.getAllByRole("menuitem").map((item) => item.textContent);

  it("offers Star, then Unstar, for a channel", async () => {
    const { client, sent, user } = workspace();
    menu(client, design.id, true);
    await user.click(screen.getByRole("button", { name: "Conversation options" }));
    expect(items()).toEqual([
      "Pinned messages",
      "Star channel",
      "Notification settings",
      "Channel details",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Star channel" }));
    expect(sent).toHaveBeenLastCalledWith(design.id, { starred: true });
    await user.click(screen.getByRole("button", { name: "Conversation options" }));
    await user.click(screen.getByRole("menuitem", { name: "Unstar channel" }));
    expect(sent).toHaveBeenLastCalledWith(design.id, { starred: false });
  });

  it("calls it a conversation in a direct message", async () => {
    const { client, user } = workspace();
    menu(client, dm.id, false);
    await user.click(screen.getByRole("button", { name: "Conversation options" }));
    expect(screen.getByRole("menuitem", { name: "Star conversation" })).toBeInTheDocument();
  });

  it("offers no Star in a channel only looked into, or on a server that keeps none", async () => {
    const { client, user } = workspace();
    const lobby = room("C_LOBBY", "lobby");
    client.store.setState({ channels: { ...client.state.channels, [lobby.id]: lobby } });
    menu(client, lobby.id, true);
    await user.click(screen.getByRole("button", { name: "Conversation options" }));
    expect(items()).not.toContain("Star channel");
    await user.keyboard("{Escape}");
    cleanup();

    const older = workspace({ stars: false });
    menu(older.client, design.id, true);
    await older.user.click(screen.getByRole("button", { name: "Conversation options" }));
    expect(items()).not.toContain("Star channel");
  });
});
