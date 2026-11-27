import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, ReactionActivity, User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { ActivityPanel } from "../src/components/ActivityPanel.js";
import { reactorsText } from "../src/components/ReactionsList.js";
import { ToastProvider } from "../src/components/Toast.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Activity's Reactions tab (K13): who reacted to your messages with what,
 * one entry per message and emoji, new until seen, and a click opens the
 * message.
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
const maya = person("U_MAYA", "Maya Chen");
const sam = person("U_SAM", "Sam Rivera");
const priya = person("U_PRIYA", "Priya Shah");
const alex = person("U_ALEX", "Alex Kim");

const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: maya.id,
  archived: false,
  createdAt: 0,
};

const NOW = Date.now();
const SEEN = NOW - 10 * 60_000;
const mine = (id: string, text: string, seq: number): Message => ({
  id,
  channelId: design.id,
  userId: maya.id,
  text,
  threadRootId: null,
  broadcast: false,
  seq,
  createdAt: NOW - 60 * 60_000,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  previews: [],
  actions: [],
});
const launch = mine("M_LAUNCH", "The launch notes are ready for review", 3);
const logo = mine("M_LOGO", "New logo options", 2);
const party: ReactionActivity = {
  message: launch,
  emoji: "🎉",
  userIds: [sam.id, priya.id, alex.id],
  count: 3,
  at: NOW - 60_000,
};
const eyes: ReactionActivity = {
  message: launch,
  emoji: "👀",
  userIds: [priya.id, sam.id],
  count: 2,
  at: NOW - 5 * 60_000,
};
// From before the mark: seen already.
const thumbs: ReactionActivity = {
  message: logo,
  emoji: "👍",
  userIds: [sam.id],
  count: 1,
  at: NOW - 30 * 60_000,
};

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
});

function activity(entries: ReactionActivity[] = [party, eyes, thumbs], unseen = 2) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  client.store.setState({
    self: maya,
    users: { [maya.id]: maya, [sam.id]: sam, [priya.id]: priya, [alex.id]: alex },
    channels: { [design.id]: design },
    memberships: { [design.id]: 3 },
    channelLastSeq: { [design.id]: 3 },
    status: "online",
    reactionActivity: { seenAt: SEEN, unseen, revision: 0 },
  });
  let shown = entries;
  const page = vi.spyOn(client.api, "reactionActivity").mockImplementation(async () => ({
    reactions: shown,
    nextCursor: null,
    seenAt: client.state.reactionActivity.seenAt,
    unseen: client.state.reactionActivity.unseen,
  }));
  const see = vi.spyOn(client.api, "seeReactions").mockImplementation(async (upTo) => ({
    seenAt: upTo ?? Date.now(),
    unseen: 0,
  }));
  vi.spyOn(client.api, "activity").mockResolvedValue({ messages: [], nextCursor: null });
  const onJump = vi.fn();
  render(
    <PlatformContext.Provider value={platform}>
      <ToastProvider>
        <ClientContext.Provider value={client}>
          <ActivityPanel onClose={() => {}} onJump={onJump} onOpenChannel={() => {}} />
        </ClientContext.Provider>
      </ToastProvider>
    </PlatformContext.Provider>,
  );
  const panel = screen.getByRole("complementary", { name: "Activity" });
  return {
    client,
    page,
    see,
    onJump,
    panel,
    user: userEvent.setup(),
    show: (next: ReactionActivity[]) => (shown = next),
  };
}

const rows = (panel: HTMLElement) =>
  [...panel.querySelectorAll("[data-activity-row]")].map((row) =>
    row.textContent!.replace(/\s+/g, " ").trim(),
  );

describe("Activity's Reactions tab", () => {
  it("counts new entries on its tab, and lists who reacted with what to which message", async () => {
    const { panel, user, page } = activity();
    const tab = within(panel).getByRole("tab", { name: /^Reactions ?2 ?new$/ });
    expect(page).not.toHaveBeenCalled();
    await user.click(tab);
    await within(panel).findByText(/Sam Rivera and 2 others/);
    expect(rows(panel)).toEqual([
      expect.stringMatching(/^Sam Rivera and 2 others reacted 🎉 to:.*The launch notes are ready/),
      expect.stringMatching(
        /^Priya Shah and Sam Rivera reacted 👀 to:.*The launch notes are ready/,
      ),
      expect.stringMatching(/^Sam Rivera reacted 👍 to:.*New logo options/),
    ]);
    const buttons = within(panel).getAllByRole("button", { name: /reacted/ });
    expect(buttons.map((b) => b.textContent!.includes(", new"))).toEqual([true, true, false]);
    expect(await accessibilityProblems(panel)).toEqual([]);
  });

  it("opens the message an entry is about", async () => {
    const { panel, user, onJump } = activity();
    await user.click(within(panel).getByRole("tab", { name: /Reactions/ }));
    await user.click(await within(panel).findByRole("button", { name: /reacted 👍/ }));
    expect(onJump).toHaveBeenCalledExactlyOnceWith(design.id, logo.id);
  });

  it("sees them on opening, so the tab stops counting, while their dots stay until it closes", async () => {
    const { panel, user, see, client } = activity();
    await user.click(within(panel).getByRole("tab", { name: /^Reactions ?2 ?new$/ }));
    await waitFor(() => expect(see).toHaveBeenCalledExactlyOnceWith(party.at));
    await waitFor(() =>
      expect(client.state.reactionActivity).toMatchObject({ seenAt: party.at, unseen: 0 }),
    );
    expect(within(panel).getByRole("tab", { name: "Reactions" })).toBeVisible();
    expect(within(panel).getByRole("button", { name: /reacted 🎉/ })).toHaveTextContent(", new");

    // Back later, nothing is new.
    await user.click(within(panel).getByRole("tab", { name: "All" }));
    await user.click(within(panel).getByRole("tab", { name: "Reactions" }));
    await within(panel).findByRole("button", { name: /reacted 🎉/ });
    expect(within(panel).getByRole("button", { name: /reacted 🎉/ })).not.toHaveTextContent(
      ", new",
    );
    expect(see).toHaveBeenCalledOnce();
  });

  it("shows a reaction as it comes, and drops one taken back", async () => {
    const { panel, user, client, show, see } = activity([thumbs], 0);
    await user.click(within(panel).getByRole("tab", { name: "Reactions" }));
    await within(panel).findByRole("button", { name: /reacted 👍/ });
    expect(see).not.toHaveBeenCalled();

    show([party, thumbs]);
    act(() =>
      client.store.setState((s) => ({
        reactionActivity: {
          ...s.reactionActivity,
          unseen: 1,
          revision: s.reactionActivity.revision + 1,
        },
      })),
    );
    const arrived = await within(panel).findByRole("button", { name: /reacted 🎉/ });
    expect(arrived).toHaveTextContent(", new");
    await waitFor(() => expect(see).toHaveBeenCalledExactlyOnceWith(party.at));

    show([party]);
    act(() =>
      client.store.setState((s) => ({
        reactionActivity: { ...s.reactionActivity, revision: s.reactionActivity.revision + 1 },
      })),
    );
    await waitFor(() =>
      expect(within(panel).queryByRole("button", { name: /reacted 👍/ })).toBeNull(),
    );
  });

  it("says when there are none", async () => {
    const { panel, user } = activity([], 0);
    await user.click(within(panel).getByRole("tab", { name: "Reactions" }));
    expect(await within(panel).findByText("No reactions to your messages yet.")).toBeVisible();
  });

  it("is seen by Mark all read, which new reactions alone offer", async () => {
    const { panel, user, see, client } = activity();
    await user.click(within(panel).getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(see).toHaveBeenCalledExactlyOnceWith(undefined));
    await waitFor(() => expect(client.state.reactionActivity.unseen).toBe(0));
    expect(within(panel).queryByRole("button", { name: "Mark all read" })).toBeNull();
    expect(within(panel).getByRole("tab", { name: "Reactions" })).toBeVisible();
  });
});

describe("reactorsText", () => {
  const users = { [sam.id]: sam, [priya.id]: priya };
  it("names one, two, or the newest and how many others", () => {
    expect(reactorsText({ userIds: [sam.id], count: 1 }, users)).toBe("Sam Rivera");
    expect(reactorsText({ userIds: [sam.id, priya.id], count: 2 }, users)).toBe(
      "Sam Rivera and Priya Shah",
    );
    expect(reactorsText({ userIds: [sam.id, priya.id, "U_X"], count: 3 }, users)).toBe(
      "Sam Rivera and 2 others",
    );
    expect(reactorsText({ userIds: ["U_GONE"], count: 1 }, users)).toBe("Someone");
  });
});
