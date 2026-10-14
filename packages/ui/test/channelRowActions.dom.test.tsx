import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { Sidebar } from "../src/components/Sidebar.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Discord's two buttons at the end of a channel's row: invite, and the
 * channel's settings. Inviting to a public channel is inviting to the
 * workspace, since everyone in it is in every public channel; a private one
 * is joined by being added, from its Members tab.
 */
const person = (role: User["role"], canInvite?: boolean): User => ({
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
  ...(canInvite === undefined ? {} : { canInvite }),
});
const channel = (id: string, name: string, type: Channel["type"] = "public"): Channel => ({
  id,
  type,
  name,
  topic: "",
  description: "",
  creatorId: "U_OWNER",
  archived: false,
  createdAt: 0,
});
const general = channel("C_GENERAL", "general");
const design = channel("C_DESIGN", "design");
const leads = channel("C_LEADS", "leads", "private");
const dm = { ...channel("C_DM", "", "dm"), memberIds: ["U_SAM", "U_MAYA"] };

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function sidebar(self: User) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self,
    users: { [self.id]: self },
    channels: { [general.id]: general, [leads.id]: leads, [dm.id]: dm },
    memberships: { [general.id]: 0, [leads.id]: 0, [dm.id]: 0 },
    status: "online",
    workspaceName: "Rocket Team",
  });
  const onInvite = vi.fn();
  const onChannelDetails = vi.fn();
  render(
    <ClientContext.Provider value={client}>
      <Sidebar
        activeChannelId={general.id}
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
        onInvite={onInvite}
        onChannelDetails={onChannelDetails}
        onSwitchWorkspace={vi.fn()}
        onAccountSettings={vi.fn()}
        connectionLabel={null}
      />
    </ClientContext.Provider>,
  );
  /** The buttons in the row of the channel or conversation named. */
  const row = (name: RegExp) =>
    within(screen.getByRole("button", { name }).closest("li")!)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
  return { onInvite, onChannelDetails, row, user: userEvent.setup() };
}

describe("a channel's row in the sidebar", () => {
  it("ends with invite and settings, which do what they say", async () => {
    const { onInvite, onChannelDetails, row, user } = sidebar(person("member"));
    expect(row(/^#\s*general$/).slice(1)).toEqual([
      "Invite people",
      "Channel settings for general",
    ]);
    expect(row(/^Private channel\s*leads$/).slice(1)).toEqual([
      "Add people to leads",
      "Channel settings for leads",
    ]);
    // A direct message has neither.
    const dmRow = [...document.querySelectorAll<HTMLElement>("li.channel-item")].at(-1)!;
    expect(within(dmRow).getAllByRole("button")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Invite people" }));
    expect(onInvite).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Channel settings for general" }));
    expect(onChannelDetails).toHaveBeenLastCalledWith(general.id);
    await user.click(screen.getByRole("button", { name: "Add people to leads" }));
    expect(onChannelDetails).toHaveBeenLastCalledWith(leads.id, "members");
  });

  it("offers inviting only to someone who may invite", () => {
    const { row } = sidebar(person("member", false));
    expect(row(/^#\s*general$/).slice(1)).toEqual(["Channel settings for general"]);
    // Adding to a private channel is the channel's to allow, not the workspace's.
    expect(row(/^Private channel\s*leads$/).slice(1)).toEqual([
      "Add people to leads",
      "Channel settings for leads",
    ]);
  });

  it("offers a guest the settings only", () => {
    const { row } = sidebar(person("guest"));
    expect(row(/^#\s*general$/).slice(1)).toEqual(["Channel settings for general"]);
  });

  it("keeps the buttons beside the row's own, not inside it", async () => {
    sidebar(person("member"));
    const general = screen.getByRole("button", { name: /^#\s*general$/ });
    expect(within(general).queryAllByRole("button")).toEqual([]);
    expect(await accessibilityProblems(general.closest("ul")!)).toEqual([]);
  });
});

describe("the stylesheet", () => {
  it("shows a row's buttons only while it is pointed at, holds focus, or is open", () => {
    const css = readFileSync(join(process.cwd(), "src/theme.css"), "utf8");
    expect(css).toMatch(/\.channel-actions \{\s*display: none;\s*\}/);
    expect(css).toContain(
      ".channel-item:is(:hover, :focus-within, [data-active]) .channel-actions {\n  display: flex;",
    );
  });
});

describe("the gear on a channel's row", () => {
  function workspace() {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("min-width"),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const owner = { ...person("owner"), id: "U_OWNER" };
    const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-test-token");
    clients.push(client);
    client.store.setState({
      self: owner,
      users: { [owner.id]: owner },
      workspaceId: "W_ROWS",
      channels: { [general.id]: general, [design.id]: design, [leads.id]: leads },
      memberships: { [general.id]: 0, [design.id]: 0, [leads.id]: 0 },
      status: "online",
    });
    writeRoute(client.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
    vi.spyOn(client, "loadTimeline").mockResolvedValue();
    vi.spyOn(client, "loadCommands").mockResolvedValue();
    vi.spyOn(client.api, "channelMembers").mockResolvedValue({ memberIds: [owner.id] } as never);
    const platform: Platform = {
      kind: "web",
      storage: { get: async () => null, set: async () => {} },
      notify: () => {},
    };
    render(
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
    return { user: userEvent.setup() };
  }

  it("opens that channel, then its settings", async () => {
    const { user } = workspace();
    await user.click(
      await screen.findByRole(
        "button",
        { name: "Channel settings for design" },
        { timeout: 3_000 },
      ),
    );
    const details = await screen.findByRole("dialog", { name: "#design" }, { timeout: 3_000 });
    expect(within(details).getByRole("tab", { selected: true })).toHaveTextContent("About");
    // The conversation behind it is #design now, not #general.
    expect(document.querySelector(".channel-header h2")).toHaveTextContent(/#\s*design/);
  });

  it("opens a private channel's Members tab, to add someone", async () => {
    const { user } = workspace();
    await user.click(
      await screen.findByRole("button", { name: "Add people to leads" }, { timeout: 3_000 }),
    );
    const details = await screen.findByRole("dialog", { name: "#leads" }, { timeout: 3_000 });
    expect(within(details).getByRole("tab", { selected: true })).toHaveTextContent("Members");
  });
});
