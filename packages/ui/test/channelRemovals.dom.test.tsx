import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, ChannelRemoval, Message, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { ActivityPanel, withRemovals } from "../src/components/ActivityPanel.js";
import { ToastProvider } from "../src/components/Toast.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { WorkspaceScreen } from "../src/screens/WorkspaceScreen.js";
import { writeRoute } from "../src/lib/route.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Removed from a channel by someone else: a note in Activity's All, among the
 * messages by when it came, counted on Activity's badge until it is read.
 */
const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.split(" ")[0]!.toLowerCase(),
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
const sam = person("U_SAM", "Sam Rivera");
const alex = person("U_ALEX", "Alex Kim");

const room = (id: string, name: string, type: "public" | "private" = "public"): Channel => ({
  id,
  type,
  name,
  topic: "",
  description: "",
  creatorId: alex.id,
  archived: false,
  createdAt: 0,
});
const general = room("C_GENERAL", "general");
const ops = room("C_OPS", "ops");
const design = room("C_DESIGN", "design");

const NOW = Date.now();
const message = (
  id: string,
  channelId: string,
  text: string,
  seq: number,
  createdAt: number,
): Message => ({
  id,
  channelId,
  userId: alex.id,
  text,
  threadRootId: null,
  broadcast: false,
  seq,
  createdAt,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
});
const removal = (
  id: string,
  channel: Pick<Channel, "id" | "name">,
  createdAt: number,
  channelType: "public" | "private" = "public",
): ChannelRemoval => ({
  id,
  channelId: channel.id,
  channelName: channel.name!,
  channelType,
  removedBy: alex.id,
  createdAt,
});
const fromDesign = removal("RM_DESIGN", design, NOW - 2 * 60_000);
// Private, and so no longer in this account's list of channels.
const fromPlans = removal(
  "RM_PLANS",
  { id: "C_PLANS", name: "plans" },
  NOW - 9 * 60_000,
  "private",
);
const newer = message("M_NEW", general.id, "Deploy is done", 9, NOW - 60_000);
const older = message("M_OLD", ops.id, "Standup moved", 4, NOW - 5 * 60_000);

const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function workspace(removals: ChannelRemoval[]) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [alex.id]: alex },
    // Design is public: it stays listed for a non-member.
    channels: { [general.id]: general, [ops.id]: ops, [design.id]: design },
    memberships: { [general.id]: 7, [ops.id]: 3 },
    channelLastSeq: { [general.id]: 9, [ops.id]: 4 },
    status: "online",
    channelRemovals: Object.fromEntries(removals.map((r) => [r.id, r])),
  });
  vi.spyOn(client.api, "activity").mockImplementation(async (mode) => ({
    messages:
      mode === "unread"
        ? [newer, older].filter((m) => m.seq > client.state.memberships[m.channelId]!)
        : [],
    nextCursor: null,
  }));
  vi.spyOn(client.api, "markRead").mockImplementation(async (_channelId, seq) => ({
    ok: true,
    seq,
  }));
  const read = vi
    .spyOn(client.api, "readChannelRemovals")
    .mockImplementation(async (ids) => ({ ids }));
  return { client, read };
}

function activity(removals: ChannelRemoval[] = [fromDesign, fromPlans]) {
  const setup = workspace(removals);
  const onOpenChannel = vi.fn();
  const onJump = vi.fn();
  render(
    <PlatformContext.Provider value={platform}>
      <ToastProvider>
        <ClientContext.Provider value={setup.client}>
          <ActivityPanel onClose={() => {}} onJump={onJump} onOpenChannel={onOpenChannel} />
        </ClientContext.Provider>
      </ToastProvider>
    </PlatformContext.Provider>,
  );
  const panel = screen.getByRole("complementary", { name: "Activity" });
  return { ...setup, onOpenChannel, onJump, panel, user: userEvent.setup() };
}

/** Activity's rows in order, by what each says first. */
const rows = (panel: HTMLElement) =>
  [...panel.querySelectorAll("[data-activity-row]")].map((row) =>
    row.textContent!.replace(/\s+/g, " "),
  );

describe("a note of a removal in Activity", () => {
  it("says who removed you from which channel, among the messages by when it came", async () => {
    const { panel } = activity();
    await within(panel).findByText("Deploy is done");
    expect(rows(panel)).toEqual([
      expect.stringContaining("Deploy is done"),
      expect.stringContaining("Alex Kim removed you from #design"),
      expect.stringContaining("Standup moved"),
      expect.stringContaining("Alex Kim removed you from #plans"),
    ]);
    const note = within(panel).getByRole("button", { name: /removed you from #design/ });
    expect(note).toHaveAccessibleName(expect.stringContaining(", unread"));
    expect(note).toHaveTextContent("Open it to read or join again");
    expect(
      within(panel).getByRole("button", { name: /removed you from #plans/ }),
    ).toHaveTextContent("Private: only someone in it can add you back");
    expect(await accessibilityProblems(panel)).toEqual([]);
  });

  it("opens a public channel's preview, from which one can join again, and is read", async () => {
    const { panel, user, read, onOpenChannel, client } = activity();
    await user.click(
      await within(panel).findByRole("button", { name: /removed you from #design/ }),
    );
    expect(onOpenChannel).toHaveBeenCalledExactlyOnceWith(design.id);
    expect(read).toHaveBeenCalledExactlyOnceWith([fromDesign.id]);
    expect(client.state.channelRemovals).toEqual({ [fromPlans.id]: fromPlans });
    expect(within(panel).queryByRole("button", { name: /removed you from #design/ })).toBeNull();
  });

  it("says a private channel cannot be opened, and is read", async () => {
    const { panel, user, read, onOpenChannel } = activity();
    await user.click(await within(panel).findByRole("button", { name: /removed you from #plans/ }));
    expect(onOpenChannel).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledExactlyOnceWith([fromPlans.id]);
    expect(
      await screen.findByText("#plans is private. Only someone in it can add you back."),
    ).toBeVisible();
  });

  it("is cleared by Mark read, which hands focus to the next row", async () => {
    const { panel, user, read } = activity();
    const note = await within(panel).findByRole("button", { name: /removed you from #design/ });
    await user.hover(note);
    await user.click(within(note.closest("li")!).getByRole("button", { name: "Mark read" }));
    expect(read).toHaveBeenCalledExactlyOnceWith([fromDesign.id]);
    await waitFor(() =>
      expect(document.activeElement).toHaveAccessibleName(expect.stringContaining("Standup moved")),
    );
  });

  it("comes back, and says so, when the server could not be told", async () => {
    const { panel, user, read } = activity([fromDesign]);
    read.mockRejectedValueOnce(new Error("offline"));
    const note = await within(panel).findByRole("button", { name: /removed you from #design/ });
    await user.click(within(note.closest("li")!).getByRole("button", { name: "Mark read" }));
    expect(
      await screen.findByText("Could not mark that read. Check your connection and try again."),
    ).toBeVisible();
    expect(within(panel).getByRole("button", { name: /removed you from #design/ })).toBeVisible();
  });

  it("is read with everything else by Mark all read, which a note alone offers", async () => {
    const { panel, user, read, client } = activity([fromDesign]);
    act(() => client.store.setState({ memberships: { [general.id]: 9, [ops.id]: 4 } }));
    await within(panel).findByRole("button", { name: /removed you from #design/ });
    await user.click(within(panel).getByRole("button", { name: "Mark all read" }));
    expect(read).toHaveBeenCalledExactlyOnceWith([fromDesign.id]);
    expect(await within(panel).findByText("You're caught up.")).toBeVisible();
    expect(within(panel).queryByRole("button", { name: "Mark all read" })).toBeNull();
  });

  it("shows up as it arrives, and only in All", async () => {
    const { panel, user, client } = activity([]);
    await within(panel).findByText("Deploy is done");
    act(() => client.store.setState({ channelRemovals: { [fromDesign.id]: fromDesign } }));
    expect(
      await within(panel).findByRole("button", { name: /removed you from #design/ }),
    ).toBeVisible();
    await user.click(within(panel).getByRole("tab", { name: "Mentions" }));
    await within(panel).findByText("No mentions yet.");
    expect(within(panel).queryByRole("button", { name: /removed you from/ })).toBeNull();
  });
});

describe("withRemovals", () => {
  const group = { key: general.id, channelId: general.id, threadRootId: null, messages: [newer] };
  it("keeps a note older than every message shown for when older messages load", () => {
    expect(withRemovals([group], [fromPlans], newer.createdAt).map((e) => e.kind)).toEqual([
      "group",
    ]);
    expect(withRemovals([group], [fromPlans], null).map((e) => e.kind)).toEqual([
      "group",
      "removal",
    ]);
  });
});

describe("Activity's badge", () => {
  function screenWith(phone: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: phone && query.includes("max-width"),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const setup = workspace([]);
    // Nothing unread in the open conversation, so only the note counts.
    setup.client.store.setState({ memberships: { [general.id]: 9, [ops.id]: 4 } });
    writeRoute(setup.client.baseUrl, { channelId: general.id, threadRootId: null }, "replace");
    vi.spyOn(setup.client, "loadTimeline").mockResolvedValue();
    vi.spyOn(setup.client, "loadCommands").mockResolvedValue();
    render(
      <PlatformContext.Provider value={platform}>
        <ToastProvider>
          <ConfirmProvider>
            <ClientContext.Provider value={setup.client}>
              <WorkspaceScreen
                client={setup.client}
                platform={platform}
                onLeaveWorkspace={() => {}}
                onSignedOut={() => {}}
              />
            </ClientContext.Provider>
          </ConfirmProvider>
        </ToastProvider>
      </PlatformContext.Provider>,
    );
    return setup;
  }

  it("counts a note until it is read, in the sidebar and in the phone's bar", async () => {
    const { client, read } = screenWith(false);
    await screen.findByRole("button", { name: /Activity/ });
    expect(screen.queryByRole("img", { name: "Channels you were removed from" })).toBeNull();
    act(() => client.store.setState({ channelRemovals: { [fromDesign.id]: fromDesign } }));
    expect(
      await screen.findByRole("img", { name: "Channels you were removed from" }),
    ).toHaveTextContent("1");

    // Opened from Activity, it is read, and the channel's preview opens.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Activity/ }));
    const panel = await screen.findByRole("complementary", { name: "Activity" });
    await user.click(
      await within(panel).findByRole("button", { name: /removed you from #design/ }),
    );
    expect(read).toHaveBeenCalledExactlyOnceWith([fromDesign.id]);
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "Channels you were removed from" })).toBeNull(),
    );
    await waitFor(() => expect(window.location.hash).toContain(design.id));
    cleanup();

    const phone = screenWith(true);
    act(() => phone.client.store.setState({ channelRemovals: { [fromDesign.id]: fromDesign } }));
    const bar = await screen.findByRole("navigation", { name: "Main navigation" });
    await waitFor(() =>
      expect(within(bar).getByRole("button", { name: "Activity" })).toHaveAccessibleDescription(
        "1 channel you were removed from",
      ),
    );
  });
});
