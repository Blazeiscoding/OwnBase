import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, ChannelPrefs, User } from "@ownbase/protocol";
import { Sidebar } from "../src/components/Sidebar.js";
import { KEY_BINDINGS } from "../src/lib/actions.js";
import { neighbourConversation, sidebarFilter, UNREAD_ONLY_KEY } from "../src/lib/sidebarLayout.js";
import { renderPart } from "./workspaceParts.js";
import { accessibilityProblems } from "./accessibility.js";

/** The sidebar's Unread only filter (K07), as Slack's "Show unreads only". */
const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.toLowerCase(),
  displayName,
  role: "member",
  canInvite: true,
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
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
});
const general = room("C_GENERAL", "general");
const design = room("C_DESIGN", "design");
const random = room("C_RANDOM", "random");
const dm: Channel = { ...room("C_DM", ""), type: "dm", memberIds: [sam.id, maya.id] };
const plain: ChannelPrefs = {
  notifyLevel: "mentions",
  notifyChosen: true,
  muted: false,
  starred: false,
  sectionId: null,
  hiddenSeq: null,
};

const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  localStorage.clear();
  sidebarFilter.setState({ unreadOnly: false });
});

/** #design has two new messages; everything else is read. */
function workspace() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [maya.id]: maya },
    channels: { [general.id]: general, [design.id]: design, [random.id]: random, [dm.id]: dm },
    memberships: { [general.id]: 5, [design.id]: 3, [random.id]: 2, [dm.id]: 4 },
    channelLastSeq: { [general.id]: 5, [design.id]: 5, [random.id]: 2, [dm.id]: 4 },
    prefs: { [general.id]: plain, [design.id]: plain, [random.id]: plain, [dm.id]: plain },
    status: "online",
    workspaceName: "Rocket Team",
  });
  return client;
}

const nav = () => screen.getByRole("navigation", { name: "Workspace navigation" });
const rows = () =>
  [...nav().querySelectorAll<HTMLElement>(".channel-row")].map((row) =>
    row.querySelector(".truncate")!.textContent!.trim(),
  );
const filter = () => within(nav()).getByRole("button", { name: "Unread only" });

describe("the sidebar's Unread only", () => {
  it("shows what waits and the open conversation, hides empty sections, and comes back", async () => {
    const client = workspace();
    renderPart(client, <Sidebar />, { channelId: general.id });
    expect(rows()).toEqual(["design", "general", "random", "Maya"]);
    expect(filter()).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(filter());
    expect(filter()).toHaveAttribute("aria-pressed", "true");
    // #general is open, so it stays; nothing in Direct messages waits.
    expect(rows()).toEqual(["design", "general"]);
    expect(within(nav()).queryByRole("button", { name: "Direct messages" })).toBeNull();
    expect(within(nav()).getByText("Showing unread only.")).toBeInTheDocument();
    expect(localStorage.getItem(UNREAD_ONLY_KEY)).toBe("1");
    expect(await accessibilityProblems(nav())).toEqual([]);

    // A new message brings a row in.
    act(() =>
      client.store.setState({ channelLastSeq: { ...client.state.channelLastSeq, [dm.id]: 6 } }),
    );
    expect(rows()).toEqual(["design", "general", "Maya"]);

    await userEvent.click(within(nav()).getByRole("button", { name: "Show all" }));
    expect(rows()).toEqual(["design", "general", "random", "Maya"]);
    expect(localStorage.getItem(UNREAD_ONLY_KEY)).toBeNull();
  });

  it("keeps the open conversation as it is read, until the reader leaves it", () => {
    sidebarFilter.setState({ unreadOnly: true });
    const client = workspace();
    const { navigation } = renderPart(client, <Sidebar />, { channelId: design.id });
    expect(rows()).toEqual(["design"]);
    // Read while open: still there, so the row does not vanish under the reader.
    act(() =>
      client.store.setState({ memberships: { ...client.state.memberships, [design.id]: 5 } }),
    );
    expect(rows()).toEqual(["design"]);
    expect(within(nav()).getByText("All caught up.")).toBeInTheDocument();
    act(() => navigation.navigate({ to: "conversation", channelId: general.id }));
    expect(rows()).toEqual(["general"]);
  });

  it("toggles with Ctrl+Shift+A, and Alt+Down walks only what it shows", () => {
    const client = workspace();
    renderPart(client, <Sidebar />, { channelId: general.id });
    const key = KEY_BINDINGS.find((b) => b.id === "unread-only")!;
    const press = new KeyboardEvent("keydown", { key: "A", ctrlKey: true, shiftKey: true });
    expect(key.match(press, {} as never)).toBe(true);
    act(() => void key.run({} as never, press));
    expect(filter()).toHaveAttribute("aria-pressed", "true");
    // From #general, the next row shown is not #random but nothing: #design is above.
    expect(neighbourConversation(client.state, new Set(), general.id, 1, false, true)).toBeNull();
    expect(neighbourConversation(client.state, new Set(), general.id, -1, false, true)).toBe(
      design.id,
    );
    expect(neighbourConversation(client.state, new Set(), general.id, 1, false)).toBe(random.id);
    fireEvent.click(filter());
    expect(filter()).toHaveAttribute("aria-pressed", "false");
  });
});
