import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, ChannelPrefs, SidebarSection, User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { Sidebar } from "../src/components/Sidebar.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Sidebar sections (E8): an account's own, between Starred and Channels, each
 * holding the conversations moved into it from their menu or by dragging;
 * made, renamed, moved up and down, folded and deleted, its conversations
 * going back when it goes.
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
const launch = room("C_LAUNCH", "launch");
const dm: Channel = { ...room("C_DM", ""), type: "dm", memberIds: [sam.id, maya.id] };
const work: SidebarSection = { id: "S_WORK", name: "Work" };
const reading: SidebarSection = { id: "S_READING", name: "Reading" };
const plain: ChannelPrefs = {
  notifyLevel: "mentions",
  muted: false,
  starred: false,
  sectionId: null,
};

const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** A client that never connects; the test answers its requests as the workspace would. */
function workspace(
  options: {
    sections?: SidebarSection[] | null;
    prefs?: Record<string, Partial<ChannelPrefs>>;
  } = {},
) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  const prefs: Record<string, ChannelPrefs> = {};
  for (const ch of [general, design, launch, dm])
    prefs[ch.id] = { ...plain, ...options.prefs?.[ch.id] };
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [maya.id]: maya },
    channels: { [general.id]: general, [design.id]: design, [launch.id]: launch, [dm.id]: dm },
    memberships: { [general.id]: 0, [design.id]: 0, [launch.id]: 0, [dm.id]: 0 },
    prefs,
    stars: true,
    sidebarSections: options.sections === undefined ? [work, reading] : options.sections,
    status: "online",
    workspaceName: "Rocket Team",
  });
  const sent = vi.spyOn(client.api, "setChannelPrefs").mockImplementation(async (id, body) => ({
    prefs: { ...plain, ...client.state.prefs[id], ...body } as ChannelPrefs,
  }));
  const keep = (sections: SidebarSection[]) => ({ sections });
  const created = vi.spyOn(client.api, "createSidebarSection").mockImplementation(async (name) => {
    const section = { id: `S_${name.toUpperCase()}`, name };
    return { section, ...keep([...client.state.sidebarSections!, section]) };
  });
  const renamed = vi
    .spyOn(client.api, "renameSidebarSection")
    .mockImplementation(async (id, name) =>
      keep(client.state.sidebarSections!.map((s) => (s.id === id ? { ...s, name } : s))),
    );
  const deleted = vi
    .spyOn(client.api, "deleteSidebarSection")
    .mockImplementation(async (id) =>
      keep(client.state.sidebarSections!.filter((s) => s.id !== id)),
    );
  const ordered = vi
    .spyOn(client.api, "orderSidebarSections")
    .mockImplementation(async (ids) =>
      keep(ids.map((id) => client.state.sidebarSections!.find((s) => s.id === id)!)),
    );
  render(
    <ToastProvider>
      <ConfirmProvider>
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
            onInvite={vi.fn()}
            onSwitchWorkspace={vi.fn()}
            onAccountSettings={vi.fn()}
            connectionLabel={null}
          />
        </ClientContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );
  return { client, sent, created, renamed, deleted, ordered, user: userEvent.setup() };
}

const nav = () => screen.getByRole("navigation", { name: "Workspace navigation" });
/** The places in the sidebar, top to bottom, by their headers' names. */
const places = () =>
  [...nav().querySelectorAll<HTMLElement>("[data-drop-place]")].map(
    (zone) => zone.querySelector("[data-section-toggle]")?.textContent ?? zone.dataset.dropPlace,
  );
/** The rows a place holds, by name, or null when it is not there. */
function rows(name: string): string[] | null {
  const toggle = within(nav()).queryByRole("button", { name });
  if (!toggle) return null;
  const zone = toggle.closest<HTMLElement>("[data-drop-place]")!;
  return [...zone.querySelectorAll<HTMLElement>(".channel-row")].map((row) =>
    row.querySelector(".truncate")!.textContent!.trim(),
  );
}
const zone = (name: string) =>
  within(nav()).getByRole("button", { name }).closest<HTMLElement>("[data-drop-place]")!;

async function rowMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: `More options for ${name}` }));
  return screen.getByRole("menu", { name: `Options for ${name}` });
}
async function sectionMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: `Options for section ${name}` }));
  return screen.getByRole("menu", { name: `Options for ${name}` });
}

describe("sections in the sidebar", () => {
  it("sit between Starred and Channels, in the account's order, each with its own", async () => {
    workspace({
      prefs: {
        [design.id]: { sectionId: work.id },
        [dm.id]: { sectionId: work.id },
        [launch.id]: { starred: true },
        // A section the account no longer has is none.
        [general.id]: { sectionId: "S_GONE" },
      },
    });
    expect(places()).toEqual(["Starred", "Work", "Reading", "Channels", "Direct messages"]);
    // Channels and people together, by name, as in Starred.
    expect(rows("Work")).toEqual(["design", "Maya"]);
    expect(rows("Reading")).toEqual([]);
    expect(within(zone("Reading")).getByText(/Move conversations here/)).toBeVisible();
    expect(rows("Channels")).toEqual(["general"]);
    expect(rows("Starred")).toEqual(["launch"]);
    expect(await accessibilityProblems(nav())).toEqual([]);
  });

  it("are offered nowhere on a server that keeps none", async () => {
    const { user } = workspace({ sections: null });
    expect(places()).not.toContain("Work");
    const menu = await rowMenu(user, "design");
    expect(within(menu).queryByRole("menuitem", { name: /Move to|New section/ })).toBeNull();
  });

  it("fold away, keeping in sight what is open or waiting", async () => {
    const { user } = workspace({ prefs: { [design.id]: { sectionId: work.id } } });
    await user.click(within(nav()).getByRole("button", { name: "Work" }));
    expect(within(nav()).getByRole("button", { name: "Work" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(rows("Work")).toEqual([]);
    await user.click(within(nav()).getByRole("button", { name: "Work" }));
    expect(rows("Work")).toEqual(["design"]);
  });
});

describe("moving a conversation", () => {
  it("goes into a section from its menu, out of Starred, and back out again", async () => {
    const { sent, user } = workspace({ prefs: { [launch.id]: { starred: true } } });
    const menu = await rowMenu(user, "launch");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.getAttribute("aria-label") ?? item.textContent),
    ).toEqual([
      "Unstar channel",
      "Move to Work",
      "Move to Reading",
      "New section…",
      "Mute channel",
    ]);
    expect(await accessibilityProblems(menu)).toEqual([]);
    await user.click(within(menu).getByRole("menuitem", { name: "Move to Work" }));
    expect(sent).toHaveBeenLastCalledWith(launch.id, { sectionId: work.id, starred: false });
    expect(rows("Work")).toEqual(["launch"]);
    expect(rows("Starred")).toBeNull();

    const inWork = await rowMenu(user, "launch");
    expect(within(inWork).queryByRole("menuitem", { name: "Move to Work" })).toBeNull();
    await user.click(within(inWork).getByRole("menuitem", { name: "Remove from Work" }));
    expect(sent).toHaveBeenLastCalledWith(launch.id, { sectionId: null, starred: false });
    expect(rows("Channels")).toEqual(["design", "general", "launch"]);
  });

  it("goes into a new section made from its menu", async () => {
    const { client, sent, created, user } = workspace();
    const menu = await rowMenu(user, "design");
    await user.click(within(menu).getByRole("menuitem", { name: "New section…" }));
    const dialog = await screen.findByRole("dialog", { name: "New section" });
    await user.click(within(dialog).getByRole("button", { name: "Create section" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Give the section a name.");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Clients");
    expect(await accessibilityProblems(dialog)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Create section" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(created).toHaveBeenCalledWith("Clients");
    expect(client.state.sidebarSections!.map((s) => s.name)).toEqual([
      "Work",
      "Reading",
      "Clients",
    ]);
    expect(sent).toHaveBeenLastCalledWith(design.id, { sectionId: "S_CLIENTS", starred: false });
    expect(rows("Clients")).toEqual(["design"]);
  });

  it("says why when a new section is refused, and keeps the window open", async () => {
    const { created, user } = workspace();
    created.mockRejectedValueOnce(new Error("offline"));
    await user.click(
      within(await rowMenu(user, "design")).getByRole("menuitem", { name: "New section…" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "New section" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Clients");
    await user.click(within(dialog).getByRole("button", { name: "Create section" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /Could not create the section/,
    );
    expect(rows("Channels")).toContain("design");
  });

  it("is dragged onto a section, Starred, or back to Channels", async () => {
    const { sent } = workspace({ prefs: { [launch.id]: { starred: true } } });
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
      effectAllowed: "",
      dropEffect: "",
      types: [] as string[],
    };
    const drag = (id: string, to: string) => {
      const button = nav().querySelector<HTMLElement>(`[data-conversation="${id}"] .channel-row`)!;
      fireEvent.dragStart(button, { dataTransfer });
      fireEvent.dragOver(zone(to), { dataTransfer });
      fireEvent.drop(zone(to), { dataTransfer });
      fireEvent.dragEnd(button, { dataTransfer });
    };

    drag(design.id, "Reading");
    expect(sent).toHaveBeenLastCalledWith(design.id, { sectionId: reading.id, starred: false });
    expect(rows("Reading")).toEqual(["design"]);
    // Dropped again where it already is, it asks nothing.
    const asked = sent.mock.calls.length;
    drag(design.id, "Reading");
    await new Promise((settled) => setTimeout(settled, 50));
    expect(sent.mock.calls.length).toBe(asked);

    drag(design.id, "Starred");
    // Sent once the move before it is answered: one request about a conversation at a time.
    await waitFor(() => expect(sent).toHaveBeenLastCalledWith(design.id, { starred: true }));
    await waitFor(() => expect(rows("Starred")).toEqual(["design", "launch"]));

    drag(launch.id, "Channels");
    await waitFor(() =>
      expect(sent).toHaveBeenLastCalledWith(launch.id, { sectionId: null, starred: false }),
    );
    expect(rows("Channels")).toContain("launch");

    // Somewhere it already is, or a channel dropped among direct messages, does nothing.
    const calls = sent.mock.calls.length;
    drag(general.id, "Channels");
    drag(general.id, "Direct messages");
    expect(sent.mock.calls.length).toBe(calls);
  });
});

describe("a section's own menu", () => {
  it("renames it", async () => {
    const { renamed, user } = workspace();
    await user.click(
      within(await sectionMenu(user, "Work")).getByRole("menuitem", { name: "Rename section…" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Rename section" });
    const field = within(dialog).getByRole("textbox", { name: "Name" });
    expect(field).toHaveValue("Work");
    await user.clear(field);
    await user.type(field, "Projects");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(renamed).toHaveBeenCalledWith(work.id, "Projects");
    expect(places()).toContain("Projects");
  });

  it("moves it up and down, offering only what it can do", async () => {
    const { ordered, user } = workspace();
    const first = await sectionMenu(user, "Work");
    expect(within(first).queryByRole("menuitem", { name: "Move up" })).toBeNull();
    await user.click(within(first).getByRole("menuitem", { name: "Move down" }));
    expect(ordered).toHaveBeenLastCalledWith([reading.id, work.id]);
    expect(places().slice(0, 2)).toEqual(["Reading", "Work"]);

    const last = await sectionMenu(user, "Work");
    expect(within(last).queryByRole("menuitem", { name: "Move down" })).toBeNull();
    await user.click(within(last).getByRole("menuitem", { name: "Move up" }));
    expect(ordered).toHaveBeenLastCalledWith([work.id, reading.id]);
  });

  it("deletes it after asking, and its conversations go back", async () => {
    const { deleted, user } = workspace({
      prefs: { [design.id]: { sectionId: work.id }, [dm.id]: { sectionId: work.id } },
    });
    await user.click(
      within(await sectionMenu(user, "Work")).getByRole("menuitem", { name: "Delete section…" }),
    );
    const asked = await screen.findByRole("dialog", { name: "Delete Work?" });
    expect(asked).toHaveTextContent("Its 2 conversations go back to Channels and Direct messages.");
    await user.click(within(asked).getByRole("button", { name: "Cancel" }));
    expect(deleted).not.toHaveBeenCalled();

    await user.click(
      within(await sectionMenu(user, "Work")).getByRole("menuitem", { name: "Delete section…" }),
    );
    await user.click(
      within(await screen.findByRole("dialog", { name: "Delete Work?" })).getByRole("button", {
        name: "Delete section",
      }),
    );
    await waitFor(() => expect(places()).not.toContain("Work"));
    expect(deleted).toHaveBeenCalledWith(work.id);
    expect(rows("Channels")).toContain("design");
    expect(rows("Direct messages")).toContain("Maya");
  });
});
