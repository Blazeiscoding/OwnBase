import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, ThreadFollow, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { ActivityPanel, groupActivity } from "../src/components/ActivityPanel.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Activity worth opening (UX-52): All, Mentions and Threads; rows grouped by
 * where they were written; one line each that opens the message; Mark read
 * and Save on each row, and Mark all read.
 */
const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.split(" ")[0]!.toLowerCase(),
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});
const hana = person("U_HANA", "Hana Ito");
const omar = person("U_OMAR", "Omar Haddad");
const priya = person("U_PRIYA", "Priya Shah");

const room = (id: string, name: string): Channel => ({
  id,
  type: "public",
  name,
  topic: "",
  description: "",
  creatorId: hana.id,
  archived: false,
  createdAt: 0,
});
const design = room("C_DESIGN", "design");
const general = room("C_GENERAL", "general");
const dm: Channel = { ...room("D_OMAR", ""), type: "dm", memberIds: [hana.id, omar.id] };

let made = 0;
const message = (
  channelId: string,
  userId: string,
  text: string,
  seq: number,
  extra: Partial<Message> = {},
): Message => ({
  id: `M${String(++made).padStart(3, "0")}`,
  channelId,
  userId,
  text,
  threadRootId: null,
  broadcast: false,
  seq,
  createdAt: Date.now() - 60_000,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
  ...extra,
});

const follow = (rootId: string, channelId: string, lastSeq: number): ThreadFollow => ({
  rootId,
  channelId,
  following: true,
  lastReadSeq: 0,
  lastSeq,
  revision: 1,
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
});

/** Hana's workspace: three new in #design, one in #general, a DM from Omar and a thread reply. */
function hanasActivity(options: { threads?: boolean } = {}) {
  made = 0;
  const designNews = [
    message(design.id, omar.id, "Mockups are up", 7),
    message(design.id, priya.id, `Looks good <@${hana.id}>`, 6),
    message(design.id, omar.id, "Colours next", 5),
  ];
  const fromOmar = message(dm.id, omar.id, "Lunch at one?", 2);
  const reply = message(general.id, priya.id, "Friday works", 9, { threadRootId: "M_ROOT" });
  const generalNews = message(general.id, omar.id, "Build is green", 8);
  // Newest first, as the server sends them.
  const all = [reply, generalNews, designNews[0]!, fromOmar, designNews[1]!, designNews[2]!];

  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: hana,
    users: { [hana.id]: hana, [omar.id]: omar, [priya.id]: priya },
    channels: { [design.id]: design, [general.id]: general, [dm.id]: dm },
    memberships: { [design.id]: 4, [general.id]: 7, [dm.id]: 1 },
    channelLastSeq: { [design.id]: 7, [general.id]: 8, [dm.id]: 2 },
    threadFollows: { M_ROOT: follow("M_ROOT", general.id, 9) },
    repliesRead: {},
    activityThreads: options.threads ?? true,
    status: "online",
  });
  const asked = vi.spyOn(client.api, "activity").mockImplementation(async (mode) => ({
    messages:
      mode === "mentions"
        ? [designNews[1]!]
        : mode === "threads"
          ? [reply]
          : all.filter((m) => !isRead(client, m)),
    nextCursor: null,
  }));
  vi.spyOn(client.api, "markRead").mockResolvedValue({ ok: true });
  vi.spyOn(client.api, "markThreadRead").mockImplementation(async (rootId, seq) => ({
    state: { ...client.state.threadFollows[rootId]!, lastReadSeq: seq, revision: 2 },
  }));
  vi.spyOn(client.api, "saveMessage").mockResolvedValue({ ok: true });
  const onJump = vi.fn();
  render(
    <ClientContext.Provider value={client}>
      <ActivityPanel onClose={() => {}} onJump={onJump} />
    </ClientContext.Provider>,
  );
  const panel = screen.getByRole("complementary", { name: "Activity" });
  return { client, asked, onJump, panel, designNews, fromOmar, reply, generalNews };
}

function isRead(client: WorkspaceClient, m: Message) {
  const s = client.state;
  if (m.threadRootId) return m.seq <= (s.threadFollows[m.threadRootId]?.lastReadSeq ?? 0);
  return m.seq <= (s.memberships[m.channelId] ?? 0);
}

const groupNamed = (panel: HTMLElement, name: string) =>
  within(panel).getByRole("region", { name: new RegExp(`^${name}`) });

describe("Activity's groups", () => {
  it("puts a conversation's messages under one heading that says how many are new", async () => {
    const { panel, onJump, designNews } = hanasActivity();
    const designGroup = await within(panel).findByRole("region", { name: "#design, 3 new" });
    expect(
      within(designGroup)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Mockups are up"),
      // Mentions read as names.
      expect.stringContaining("Looks good @Hana Ito"),
      expect.stringContaining("Colours next"),
    ]);
    // In the order the newest of each came.
    expect(
      within(panel)
        .getAllByRole("region")
        .map((group) => group.querySelector("h3")?.getAttribute("aria-label")),
    ).toEqual(["#general, 2 new", "#design, 3 new", "Direct message, 1 new"]);
    // A direct message is named by its author, once.
    const direct = groupNamed(panel, "Direct message");
    expect(within(direct).getAllByText("Omar Haddad")).toHaveLength(1);
    // A reply in All says it is in a thread.
    expect(within(groupNamed(panel, "#general")).getByText("in a thread")).toBeVisible();

    // The whole row opens the message.
    await userEvent
      .setup()
      .click(within(designGroup).getByRole("button", { name: /Mockups are up/ }));
    expect(onJump).toHaveBeenCalledWith(designNews[0]!.channelId, designNews[0]!.id);
    expect(await accessibilityProblems(panel)).toEqual([]);
  });

  it("groups by thread in Threads, which only a server that answers it offers", async () => {
    const user = userEvent.setup();
    const { panel, asked } = hanasActivity();
    await within(panel).findByRole("region", { name: "#design, 3 new" });
    await user.click(within(panel).getByRole("tab", { name: "Threads" }));
    await waitFor(() => expect(asked).toHaveBeenLastCalledWith("threads", expect.anything()));
    const thread = await within(panel).findByRole("region", { name: "Thread in #general, 1 new" });
    expect(within(thread).getByText("Friday works")).toBeVisible();
    expect(within(thread).queryByText("in a thread")).toBeNull();
    expect(within(panel).getByText("Unread replies in threads you follow.")).toBeVisible();
  });

  it("offers no Threads tab to a server that cannot answer it", async () => {
    const { panel } = hanasActivity({ threads: false });
    const tabs = within(panel).getByRole("tablist", { name: "Activity filter" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["All", "Mentions"]);
  });
});

describe("reading and saving from Activity", () => {
  it("reads a conversation up to a row, which leaves with what it read, and focus goes on", async () => {
    const user = userEvent.setup();
    const { panel, client } = hanasActivity();
    const design = await within(panel).findByRole("region", { name: "#design, 3 new" });
    const rows = within(design).getAllByRole("listitem");
    // Mark read on the second of three reads it and the one before it.
    await user.click(within(rows[1]!).getByRole("button", { name: "Mark read" }));
    expect(client.state.memberships.C_DESIGN).toBe(6);
    const after = await within(panel).findByRole("region", { name: "#design, 1 new" });
    expect(within(after).getByText("Mockups are up")).toBeVisible();
    // Focus moved to the row after the one read, not to the page.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(panel).toContainElement(document.activeElement as HTMLElement);
  });

  it("reads a thread up to a reply, though the thread was never opened here", async () => {
    const user = userEvent.setup();
    const { panel, client, reply } = hanasActivity();
    const general = await within(panel).findByRole("region", { name: "#general, 2 new" });
    const row = within(general).getByText("Friday works").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Mark read" }));
    expect(client.state.threadFollows.M_ROOT!.lastReadSeq).toBe(reply.seq);
    await waitFor(() => expect(within(panel).queryByText("Friday works")).toBeNull());
  });

  it("saves a message, saying it is saved", async () => {
    const user = userEvent.setup();
    const { panel, client, fromOmar } = hanasActivity();
    const direct = await within(panel).findByRole("region", { name: "Direct message, 1 new" });
    const save = within(direct).getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-pressed", "false");
    await user.click(save);
    expect(client.state.saved[fromOmar.id]).toBe(true);
    expect(within(direct).getByRole("button", { name: "Save" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps a mention that was read, and keeps focus on it", async () => {
    const user = userEvent.setup();
    const { panel } = hanasActivity();
    await within(panel).findByRole("region", { name: "#design, 3 new" });
    await user.click(within(panel).getByRole("tab", { name: "Mentions" }));
    const design = await within(panel).findByRole("region", { name: "#design, 1 new" });
    await user.click(within(design).getByRole("button", { name: "Mark read" }));
    // Read, and still there: Mentions lists them read or not.
    await waitFor(() =>
      expect(within(panel).getByRole("region", { name: "#design" })).toBeVisible(),
    );
    expect(within(panel).getByText(/Looks good/)).toBeVisible();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(panel).getByRole("button", { name: /Looks good/ }),
      ),
    );
  });

  it("acts once for a double-click, whatever slid up under its second click", async () => {
    const user = userEvent.setup();
    const { panel, client, onJump, fromOmar } = hanasActivity();
    const design = await within(panel).findByRole("region", { name: "#design, 3 new" });
    const oldest = within(design).getAllByRole("listitem").at(-1)!;
    await user.click(within(oldest).getByRole("button", { name: "Mark read" }));
    expect(client.state.memberships.C_DESIGN).toBe(5);
    // The direct message's row moves up into its place. Chromium counts the
    // click that lands on any of its controls as the second of two.
    const direct = groupNamed(panel, "Direct message");
    for (const name of ["Mark read", "Save", /Lunch at one/])
      fireEvent.click(within(direct).getByRole("button", { name }), { detail: 2 });
    expect(client.state.memberships.D_OMAR).toBe(1);
    expect(client.state.saved[fromOmar.id]).toBeUndefined();
    expect(onJump).not.toHaveBeenCalled();
  });

  it("marks everything read at once, conversations and followed threads", async () => {
    const user = userEvent.setup();
    const { panel, client } = hanasActivity();
    await within(panel).findByRole("region", { name: "#design, 3 new" });
    await user.click(within(panel).getByRole("button", { name: "Mark all read" }));
    expect(client.state.memberships).toEqual({ C_DESIGN: 7, C_GENERAL: 8, D_OMAR: 2 });
    expect(client.state.threadFollows.M_ROOT!.lastReadSeq).toBe(9);
    expect(await within(panel).findByText("You're caught up.")).toBeVisible();
    // Nothing left to read, so nothing to press.
    expect(within(panel).queryByRole("button", { name: "Mark all read" })).toBeNull();
  });
});

describe("groupActivity", () => {
  it("keeps the order each group's newest came in", () => {
    made = 0;
    const a1 = message("A", "U", "a1", 3);
    const b1 = message("B", "U", "b1", 2);
    const a2 = message("A", "U", "a2", 1);
    expect(groupActivity([a1, b1, a2], false).map((g) => [g.key, g.messages.length])).toEqual([
      ["A", 2],
      ["B", 1],
    ]);
  });
});
