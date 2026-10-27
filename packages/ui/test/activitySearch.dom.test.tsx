import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { Channel, Message, User } from "@ownbase/protocol";
import { describe, expect, it, vi } from "vitest";
import { ActivityPanel } from "../src/components/ActivityPanel.js";
import { SearchDialog } from "../src/components/SearchDialog.js";
import { localDay } from "../src/lib/searchFilters.js";
import type { ComponentProps } from "react";
import type { RecentSearch } from "../src/lib/recentSearches.js";
import { workspaceStorageKey } from "../src/lib/workspaceStorage.js";
import { accessibilityProblems } from "./accessibility.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";

/**
 * Activity and search over the network: a first load, a failure and Retry,
 * an empty answer said as such, the next page, and an answer that arrives
 * after a newer question was asked.
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
const priya: User = { ...sam, id: "U_PRIYA", handle: "priya", displayName: "Priya Shah" };

const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id, priya.id],
};
const hidden: Channel = { ...design, id: "C_HIDDEN", name: "hidden" };

const message = (id: string, text: string, seq: number, channelId = design.id): Message =>
  ({
    id,
    channelId,
    userId: priya.id,
    text,
    seq,
    createdAt: Date.UTC(2026, 8, 20, 10, 0),
    editedAt: null,
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    reactions: [],
    files: [],
    pinned: false,
  }) as unknown as Message;

function workspace() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    workspaceId: "W1",
    users: { [sam.id]: sam, [priya.id]: priya },
    channels: { [design.id]: design, [hidden.id]: hidden },
    // Read through seq 1 of #design; not a member of #hidden.
    memberships: { [design.id]: 1 },
    status: "online",
  });
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };
  return { client, platform };
}

describe("the Activity panel", () => {
  function renderActivity(
    activity: (
      mode: string,
      opts: { cursor?: string },
    ) => Promise<{ messages: Message[]; nextCursor: string | null }>,
  ) {
    const { client, platform } = workspace();
    const spy = vi
      .spyOn(client.api, "activity")
      .mockImplementation((mode, opts) => activity(mode, opts ?? {}));
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <ActivityPanel onClose={() => {}} onJump={() => {}} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    return { client, spy, panel: screen.getByRole("complementary", { name: "Activity" }) };
  }

  it("refreshes an open Mentions filter when an edit adds or removes a mention", async () => {
    const user = userEvent.setup();
    let messages: Message[] = [];
    const { client, panel, spy } = renderActivity(async () => ({ messages, nextCursor: null }));
    await within(panel).findByText("You're caught up.");
    await user.click(within(panel).getByRole("tab", { name: "Mentions" }));
    await within(panel).findByText("No mentions yet.");
    expect(spy).toHaveBeenCalledTimes(2);

    messages = [message("M2", "Please review this", 2)];
    act(() => client.store.setState({ mentionCounts: { [design.id]: 1 } }));
    expect(await within(panel).findByText("Please review this")).toBeVisible();
    expect(spy).toHaveBeenLastCalledWith(
      "mentions",
      expect.objectContaining({ cursor: undefined }),
    );

    // A new durable event without a mention refresh does not fetch this list.
    await act(async () => client.store.setState({ lastSeq: 30 }));
    expect(spy).toHaveBeenCalledTimes(3);

    messages = [];
    act(() => client.store.setState({ mentionCounts: {} }));
    expect(await within(panel).findByText("No mentions yet.")).toBeVisible();
    expect(within(panel).queryByText("Please review this")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("refreshes edited text when mention counts stay equal, preserving its filter and cursor", async () => {
    const user = userEvent.setup();
    let text = "Earlier mention text";
    const { client, panel, spy } = renderActivity(async (_mode, { cursor }) =>
      cursor
        ? { messages: [message("M2", text, 2)], nextCursor: null }
        : { messages: [message("M5", "Newer mention", 5)], nextCursor: "M5" },
    );
    await within(panel).findByText("Newer mention");
    await user.click(within(panel).getByRole("tab", { name: "Mentions" }));
    await within(panel).findByText("Newer mention");
    act(() => client.store.setState({ mentionCounts: { [design.id]: 1 } }));
    await user.click(await within(panel).findByRole("button", { name: "Show more" }));
    await within(panel).findByText("Earlier mention text");
    const requests = spy.mock.calls.length;

    text = "Updated mention text";
    act(() => client.store.setState({ mentionCounts: { [design.id]: 1 } }));
    expect(await within(panel).findByText("Updated mention text")).toBeVisible();
    expect(within(panel).queryByText("Earlier mention text")).toBeNull();
    // Read again from the top, as far as it had been read: both pages, in place.
    expect(spy).toHaveBeenCalledTimes(requests + 2);
    expect(spy).toHaveBeenLastCalledWith("mentions", expect.objectContaining({ cursor: "M5" }));
    expect(within(panel).getByText("Newer mention")).toBeVisible();
    expect(within(panel).getByRole("tab", { name: "Mentions" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("lets a running load finish when mentions change, then loads once more, never older over newer", async () => {
    let release!: (page: { messages: Message[]; nextCursor: null }) => void;
    let requests = 0;
    const { client, panel, spy } = renderActivity(() => {
      if (requests++ === 0) return new Promise((resolve) => (release = resolve));
      return Promise.resolve({ messages: [message("M2", "Current mention", 2)], nextCursor: null });
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const firstSignal = spy.mock.calls[0]![1]?.signal;
    act(() => client.store.setState({ mentionCounts: { [design.id]: 1 } }));
    expect(firstSignal?.aborted).toBe(false);

    await act(async () =>
      release({ messages: [message("M2", "Captured old text", 2)], nextCursor: null }),
    );
    expect(await within(panel).findByText("Current mention")).toBeVisible();
    expect(within(panel).queryByText("Captured old text")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("drops a running load for another filter, and ignores its late answer", async () => {
    const user = userEvent.setup();
    let release!: (page: { messages: Message[]; nextCursor: null }) => void;
    const { panel, spy } = renderActivity((mode) =>
      mode === "unread"
        ? new Promise((resolve) => (release = resolve))
        : Promise.resolve({ messages: [message("M2", "A mention", 2)], nextCursor: null }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await user.click(within(panel).getByRole("tab", { name: "Mentions" }));
    expect(spy.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(await within(panel).findByText("A mention")).toBeVisible();
    await act(async () =>
      release({ messages: [message("M3", "Late unread page", 3)], nextCursor: null }),
    );
    expect(within(panel).queryByText("Late unread page")).toBeNull();
    expect(within(panel).getByText("A mention")).toBeVisible();
  });

  it("keeps what it shows through a burst of mention changes, and asks at most twice", async () => {
    let n = 0;
    const { client, panel, spy } = renderActivity(async () => ({
      messages: [message("M2", `Mention, version ${n}`, 2)],
      nextCursor: null,
    }));
    expect(await within(panel).findByText("Mention, version 0")).toBeVisible();
    const before = spy.mock.calls.length;
    const blank: number[] = [];
    for (let i = 1; i <= 10; i++) {
      n = i;
      await act(async () => client.store.setState({ mentionCounts: { [design.id]: i % 2 } }));
      if (!within(panel).queryByText(/^Mention, version/)) blank.push(i);
    }
    expect(await within(panel).findByText("Mention, version 10")).toBeVisible();
    expect(spy.mock.calls.length - before).toBeLessThanOrEqual(2);
    expect(blank).toEqual([]);
    expect(spy.mock.calls.every(([, opts]) => !opts?.signal?.aborted)).toBe(true);
  });

  it("loads its page again when retention takes threads from a conversation it shows", async () => {
    const { client, platform } = workspace();
    let answer = [message("M_OLD", "an old mention", 5), message("M_NEW", "a newer one", 6)];
    const spy = vi
      .spyOn(client.api, "activity")
      .mockImplementation(async () => ({ messages: answer, nextCursor: null }));
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <ActivityPanel onClose={() => {}} onJump={() => {}} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const panel = screen.getByRole("complementary", { name: "Activity" });
    await within(panel).findByText("an old mention");
    expect(spy).toHaveBeenCalledTimes(1);

    // Another conversation's removal is nothing to this page.
    act(() => client.store.setState({ removedHistory: { [hidden.id]: 20 } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spy).toHaveBeenCalledTimes(1);

    answer = [message("M_NEW", "a newer one", 6)];
    act(() => client.store.setState({ removedHistory: { [hidden.id]: 20, [design.id]: 21 } }));
    await waitFor(() => expect(within(panel).queryByText("an old mention")).toBeNull());
    expect(within(panel).getByText("a newer one")).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("says a load failed, and Retry loads it", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { panel, spy } = renderActivity(async () => {
      if (fail) throw new TypeError("Failed to fetch");
      return { messages: [message("M2", "Can you look at the mockups?", 2)], nextCursor: null };
    });
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent(
      "Could not load activity. Check your connection and try again.",
    );
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await within(panel).findByText("Can you look at the mockups?")).toBeVisible();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("says when there is nothing, in the words for each filter", async () => {
    const user = userEvent.setup();
    const { panel } = renderActivity(async () => ({ messages: [], nextCursor: null }));
    expect(await within(panel).findByText("You're caught up.")).toBeVisible();
    await user.click(within(panel).getByRole("tab", { name: "Mentions" }));
    expect(await within(panel).findByText("No mentions yet.")).toBeVisible();
  });

  it("leaves out what is already read, and conversations it is not in", async () => {
    const { panel } = renderActivity(async () => ({
      messages: [
        message("M3", "New in design", 3),
        message("M1", "Already read", 1),
        message("M9", "From a room it left", 9, hidden.id),
      ],
      nextCursor: null,
    }));
    expect(await within(panel).findByText("New in design")).toBeVisible();
    expect(within(panel).queryByText("Already read")).toBeNull();
    expect(within(panel).queryByText("From a room it left")).toBeNull();
  });

  it("keeps a reply the channel was read past, until its thread is read", async () => {
    const reply = {
      ...message("M5", "A reply only in its thread", 5),
      threadRootId: "M0",
      broadcast: false,
    } as Message;
    const { client, platform } = workspace();
    // The channel is read past the reply; replies before seq 2 count as read.
    client.store.setState({ memberships: { [design.id]: 9 }, repliesRead: { [design.id]: 2 } });
    vi.spyOn(client.api, "activity").mockResolvedValue({ messages: [reply], nextCursor: null });
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <ActivityPanel onClose={() => {}} onJump={() => {}} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const panel = screen.getByRole("complementary", { name: "Activity" });
    expect(await within(panel).findByText("A reply only in its thread")).toBeVisible();

    client.store.setState({
      threadFollows: {
        M0: {
          rootId: "M0",
          channelId: design.id,
          following: false,
          lastReadSeq: 5,
          lastSeq: 5,
          revision: 1,
        },
      },
    });
    await waitFor(() => expect(within(panel).queryByText("A reply only in its thread")).toBeNull());
  });

  it("shows more after what it has, by the next page's cursor (UX-08)", async () => {
    const user = userEvent.setup();
    const { panel, spy } = renderActivity(async (_mode, { cursor }) =>
      cursor
        ? { messages: [message("M2", "Older", 2)], nextCursor: null }
        : { messages: [message("M5", "Newer", 5)], nextCursor: "M5" },
    );
    await within(panel).findByText("Newer");
    expect(within(panel).queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Previous page" })).toBeNull();
    const more = within(panel).getByRole("button", { name: "Show more" });
    more.focus();
    await user.keyboard("{Enter}");
    expect(await within(panel).findByText("Older")).toBeVisible();
    expect(within(panel).getByText("Newer")).toBeVisible();
    expect(spy).toHaveBeenLastCalledWith("unread", expect.objectContaining({ cursor: "M5" }));
    // The end of the list: the button goes, and focus stays in the panel.
    expect(within(panel).queryByRole("button", { name: "Show more" })).toBeNull();
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it("says when more could not load, and Try again reads it", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { panel } = renderActivity(async (_mode, { cursor }) => {
      if (!cursor) return { messages: [message("M5", "Newer", 5)], nextCursor: "M5" };
      if (fail) throw new TypeError("Failed to fetch");
      return { messages: [message("M2", "Older", 2)], nextCursor: null };
    });
    await user.click(await within(panel).findByRole("button", { name: "Show more" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Could not load more.");
    expect(within(panel).getByText("Newer")).toBeVisible();
    fail = false;
    await user.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(await within(panel).findByText("Older")).toBeVisible();
    expect(within(panel).queryByRole("alert")).toBeNull();
  });

  it("brings in a new unread message without a mention, and a new reply in a followed thread", async () => {
    let messages = [message("M2", "First unread", 2)];
    const { client, panel, spy } = renderActivity(async () => ({ messages, nextCursor: null }));
    await within(panel).findByText("First unread");
    const before = spy.mock.calls.length;

    messages = [message("M3", "Plain new message", 3), ...messages];
    act(() => client.store.setState({ channelLastSeq: { [design.id]: 3 } }));
    expect(await within(panel).findByText("Plain new message")).toBeVisible();
    expect(spy.mock.calls.length).toBe(before + 1);

    const reply = {
      ...message("M4", "A reply in a followed thread", 4),
      threadRootId: "M0",
      broadcast: false,
    } as Message;
    messages = [reply, ...messages];
    act(() =>
      client.store.setState({
        threadFollows: {
          M0: {
            rootId: "M0",
            channelId: design.id,
            following: true,
            lastReadSeq: 0,
            lastSeq: 4,
            revision: 1,
          },
        },
      }),
    );
    expect(await within(panel).findByText("A reply in a followed thread")).toBeVisible();
    expect(within(panel).getByText("Plain new message")).toBeVisible();
  });
});

describe("the search dialog", () => {
  type Found = { messages: Message[]; nextCursor: string | null };
  type Typist = ReturnType<typeof userEvent.setup>;

  /** A device's storage that keeps what is put in it, so recent searches stay. */
  function keptStorage(initial: Record<string, unknown>): Platform {
    const values = new Map<string, unknown>(Object.entries(initial));
    return {
      kind: "web",
      storage: {
        get: async <T,>(name: string) => (values.get(name) ?? null) as T | null,
        set: async (name: string, value: unknown) => {
          values.set(name, value);
        },
      },
      notify: () => {},
    };
  }

  function renderSearch(
    search: (q: string, opts: { cursor?: string; channelId?: string }) => Promise<Found>,
    props: Partial<ComponentProps<typeof SearchDialog>> = {},
    recent: RecentSearch[] = [],
  ) {
    const { client } = workspace();
    const key = workspaceStorageKey(client.baseUrl, "W1", sam.id, "recent-searches")!.key;
    const platform = keptStorage(recent.length ? { [key]: { version: 1, value: recent } } : {});
    const spy = vi
      .spyOn(client.api, "search")
      .mockImplementation((q, _limit, opts) => search(q, opts ?? {}));
    const onJump = vi.fn();
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <SearchDialog onClose={() => {}} onJump={onJump} {...props} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Search messages" });
    const box = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Search messages" });
    const scroller = dialog.querySelector<HTMLElement>(".dialog-scroll")!;
    return { client, spy, dialog, box, scroller, onJump };
  }

  const ready =
    (text = "The mockups are ready") =>
    async (): Promise<Found> => ({ messages: [message("M5", text, 5)], nextCursor: null });
  const pause = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** The filters in force, as their chips say them. */
  const chips = (dialog: HTMLElement) =>
    within(dialog)
      .queryAllByRole("button", { name: /^Remove filter: / })
      .map((button) => button.getAttribute("aria-label")!.replace("Remove filter: ", ""));
  const removeChip = (dialog: HTMLElement, label: string) =>
    within(dialog).getByRole("button", { name: `Remove filter: ${label}` });
  /** The results, which say whether they are being read. */
  const resultList = (dialog: HTMLElement) =>
    within(dialog).getByRole("tabpanel").querySelector<HTMLElement>("ul[aria-busy]")!;
  /** The line that says how many results there are, once there is an answer. */
  const summary = (dialog: HTMLElement) =>
    within(dialog)
      .getAllByRole("status")
      .find((status) => status.tagName === "P");
  const day = (year: number, month: number, date: number) =>
    new Date(Date.UTC(year, month - 1, date)).toLocaleDateString(undefined, { timeZone: "UTC" });

  async function pick(
    user: Typist,
    dialog: HTMLElement,
    menu: "From" | "In" | "Has",
    item: string | RegExp,
  ) {
    await user.click(within(dialog).getByRole("button", { name: menu }));
    const list = await screen.findByRole("menu", { name: menu });
    await user.click(
      within(list).getByRole(menu === "In" ? "menuitemradio" : "menuitemcheckbox", { name: item }),
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  }

  describe("its results", () => {
    it("asks for them again when a conversation in them changes, dropping what was deleted (Q07)", async () => {
      const user = userEvent.setup();
      let answer = [
        message("M_GONE", "notes since deleted about launch", 5),
        message("M_KEPT", "roadmap for the launch", 4),
      ];
      const { client, dialog, box, spy } = renderSearch(async () => ({
        messages: answer,
        nextCursor: null,
      }));
      await user.type(box, "launch{Enter}");
      await within(dialog).findByText(/notes since deleted/);
      const asked = spy.mock.calls.length;

      // A change in a conversation none of the results come from is nothing to them.
      act(() => client.store.setState({ changedContent: { [hidden.id]: 20 } }));
      await pause(400);
      expect(spy).toHaveBeenCalledTimes(asked);

      answer = [message("M_KEPT", "roadmap for the launch", 4)];
      act(() => client.store.setState({ changedContent: { [hidden.id]: 20, [design.id]: 21 } }));
      await waitFor(() => expect(within(dialog).queryByText(/notes since deleted/)).toBeNull());
      expect(within(dialog).getByText(/roadmap for the/)).toBeVisible();
      expect(spy).toHaveBeenCalledTimes(asked + 1);
      expect(spy).toHaveBeenLastCalledWith(
        "launch",
        30,
        expect.objectContaining({ cursor: undefined }),
      );
      expect(dialog).toHaveTextContent("1 result · Newest first · “launch”");

      // Asked once for that change, not again and again.
      await pause(400);
      expect(spy).toHaveBeenCalledTimes(asked + 1);
    });

    it("reads them again from the top as far as they were read, in place, where they were scrolled to", async () => {
      const user = userEvent.setup();
      const { client, dialog, box, spy, scroller } = renderSearch(async (_q, { cursor }) =>
        cursor
          ? { messages: [message("M1", "Older mockups", 1)], nextCursor: null }
          : { messages: [message("M5", "Newer mockups", 5)], nextCursor: "M5" },
      );
      await user.type(box, "mockups{Enter}");
      await within(dialog).findByText(/Newer/);
      await user.click(within(dialog).getByRole("button", { name: "Show more" }));
      await within(dialog).findByText(/Older/);
      scroller.scrollTop = 200;
      const asked = spy.mock.calls.length;

      act(() => client.store.setState({ changedContent: { [design.id]: 21 } }));
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(asked + 2));
      expect(spy.mock.calls.slice(asked).map(([q, , opts]) => [q, opts?.cursor])).toEqual([
        ["mockups", undefined],
        ["mockups", "M5"],
      ]);
      await waitFor(() => expect(resultList(dialog)).toHaveAttribute("aria-busy", "false"));
      expect(within(dialog).getByText(/Newer/)).toBeVisible();
      expect(within(dialog).getByText(/Older/)).toBeVisible();
      expect(dialog).toHaveTextContent("2 results · Newest first · “mockups”");
      expect(scroller.scrollTop).toBe(200);
    });

    it("lets a newer question finish when a change arrives meanwhile, showing the last answer, then asks it once more", async () => {
      const user = userEvent.setup();
      let release = () => {};
      let narrower = 0;
      const { client, dialog, box, spy } = renderSearch((q) => {
        if (q !== "launch roadmap")
          return Promise.resolve({ messages: [message("M1", "the launch", 1)], nextCursor: null });
        narrower += 1;
        const found = {
          messages: [message("M2", `launch roadmap, answer ${narrower}`, 2)],
          nextCursor: null,
        };
        // The first answer to the newer question is slow; the one asked after it is not.
        return narrower === 1
          ? new Promise<Found>((resolve) => (release = () => resolve(found)))
          : Promise.resolve(found);
      });
      await user.type(box, "launch{Enter}");
      await within(dialog).findByText(/^the/);

      await user.type(box, " roadmap{Enter}");
      await waitFor(() => expect(narrower).toBe(1));
      const asked = spy.mock.calls.length;
      const out = spy.mock.calls[asked - 1]![2]!.signal!;
      // The last answer stays on show, nothing blanks, and it says it is searching.
      expect(within(dialog).getByText(/^the/)).toBeVisible();
      expect(within(dialog).getByText("Searching…")).toBeVisible();
      expect(resultList(dialog)).toHaveAttribute("aria-busy", "true");

      // A change is heard in a conversation those results come from. The
      // question that is out is not cut short to ask the old one again.
      act(() => client.store.setState({ changedContent: { [design.id]: 30 } }));
      await pause(400);
      expect(spy).toHaveBeenCalledTimes(asked);
      expect(out.aborted).toBe(false);

      // Its answer was asked for before the change, so it is asked for once more.
      await act(async () => release());
      await within(dialog).findByText(/answer 2/);
      expect(within(dialog).queryByText(/^the/)).toBeNull();
      expect(within(dialog).queryByText("Searching…")).toBeNull();
      expect(spy).toHaveBeenCalledTimes(asked + 1);
      expect(spy).toHaveBeenLastCalledWith(
        "launch roadmap",
        30,
        expect.objectContaining({ cursor: undefined }),
      );
    });

    it("describes the answer on show while the next question is out, not the question", async () => {
      const user = userEvent.setup();
      const { dialog, box } = renderSearch((q) =>
        q === "launch"
          ? Promise.resolve({ messages: [message("M1", "the launch", 1)], nextCursor: null })
          : new Promise<Found>(() => {}),
      );
      await user.type(box, "launch{Enter}");
      await within(dialog).findByText(/^the/);
      expect(summary(dialog)).toHaveTextContent("1 result · Newest first · “launch”");

      await user.type(box, " roadmap{Enter}");
      expect(within(dialog).getByText(/^the/)).toBeVisible();
      // The words are the ones the results on show were found for.
      expect(summary(dialog)).toHaveTextContent("1 result · Newest first · “launch”");
      expect(summary(dialog)).not.toHaveTextContent("roadmap");
    });

    it("keeps the field over them, their place as more comes, and shows a new question's answer from its top", async () => {
      const user = userEvent.setup();
      const { dialog, box, scroller } = renderSearch(async (q, { cursor }) =>
        q !== "mockups"
          ? { messages: [message("M9", "Rollout plan for mockups launch", 9)], nextCursor: null }
          : cursor
            ? { messages: [message("M1", "Older mockups", 1)], nextCursor: null }
            : { messages: [message("M5", "Newer mockups", 5)], nextCursor: "M5" },
      );
      expect(scroller).not.toContainElement(box);
      await user.type(box, "mockups{Enter}");
      expect(scroller).toContainElement(await within(dialog).findByText(/Newer/));

      scroller.scrollTop = 300;
      await user.click(within(dialog).getByRole("button", { name: "Show more" }));
      await within(dialog).findByText(/Older/);
      expect(scroller.scrollTop).toBe(300);

      await user.type(box, " launch{Enter}");
      await within(dialog).findByText(/Rollout plan/);
      expect(scroller.scrollTop).toBe(0);
    });

    it("shows more by the next page's cursor, and says how many so far", async () => {
      const user = userEvent.setup();
      const { dialog, box, spy } = renderSearch(async (_q, { cursor }) =>
        cursor
          ? { messages: [message("M1", "Older mockups", 1)], nextCursor: null }
          : { messages: [message("M5", "Newer mockups", 5)], nextCursor: "M5" },
      );
      await user.type(box, "mockups{Enter}");
      await within(dialog).findByText(/Newer/);
      expect(dialog).toHaveTextContent("1 result so far · Newest first · “mockups”");
      expect(within(dialog).queryByRole("button", { name: "Next page" })).toBeNull();
      expect(within(dialog).queryByRole("button", { name: "Previous page" })).toBeNull();

      await user.click(within(dialog).getByRole("button", { name: "Show more" }));
      await within(dialog).findByText(/Older/);
      expect(within(dialog).getByText(/Newer/)).toBeVisible();
      expect(spy).toHaveBeenLastCalledWith(
        "mockups",
        30,
        expect.objectContaining({ cursor: "M5" }),
      );
      expect(dialog).toHaveTextContent("2 results · Newest first · “mockups”");
      // The end of the list: nothing more to show.
      expect(within(dialog).queryByRole("button", { name: "Show more" })).toBeNull();
    });

    it("says it is searching, and does not ask again until it has an answer", async () => {
      const user = userEvent.setup();
      let answer!: (value: Found) => void;
      const { dialog, box, spy } = renderSearch(() => new Promise((resolve) => (answer = resolve)));
      await user.type(box, "mockups{Enter}");
      expect(within(dialog).getByText("Searching…")).toBeInTheDocument();
      await user.type(box, "{Enter}");
      expect(spy).toHaveBeenCalledOnce();

      await act(async () =>
        answer({ messages: [message("M2", "The mockups are ready", 2)], nextCursor: null }),
      );
      await within(dialog).findByText(/are ready/);
      expect(within(dialog).queryByText("Searching…")).toBeNull();
      expect(spy).toHaveBeenCalledOnce();
    });

    it("says a search failed, and Retry asks the same question again", async () => {
      const user = userEvent.setup();
      let fail = true;
      const { dialog, box, spy } = renderSearch(async () => {
        if (fail) throw new TypeError("Failed to fetch");
        return { messages: [message("M2", "The mockups are ready", 2)], nextCursor: null };
      });
      await user.type(box, "mockups{Enter}");
      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent(
        "Could not search this workspace. Check your connection and try again.",
      );
      fail = false;
      await user.click(within(alert).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
      expect(dialog).toHaveTextContent("1 result · Newest first · “mockups”");
      expect(spy.mock.calls.map((call) => call[0])).toEqual(["mockups", "mockups"]);
    });

    it("says when nothing matched, on either tab", async () => {
      const user = userEvent.setup();
      const { dialog, box } = renderSearch(async () => ({ messages: [], nextCursor: null }));
      await user.type(box, "zebra{Enter}");
      expect(
        await within(dialog).findByText("Nothing matched. Try different words."),
      ).toBeVisible();
      expect(dialog).toHaveTextContent("0 results · Newest first · “zebra”");
      await user.click(within(dialog).getByRole("tab", { name: "Files" }));
      expect(
        await within(dialog).findByText("No files matched. Try different words."),
      ).toBeVisible();
      expect(dialog).toHaveTextContent("0 files · Newest first · “zebra”");
    });

    it("searches as it is typed, and keeps only what Enter settles on", async () => {
      const user = userEvent.setup();
      const { dialog, box, spy } = renderSearch(ready());
      await user.type(box, "mo");
      await waitFor(() => expect(dialog).toHaveTextContent("1 result · Newest first · “mo”"));
      expect(within(dialog).queryByRole("list", { name: "Recent searches" })).toBeNull();
      await user.type(box, "ck");
      await waitFor(() => expect(dialog).toHaveTextContent("1 result · Newest first · “mock”"));
      expect(spy.mock.calls.map((call) => call[0])).toEqual(["mo", "mock"]);

      // Enter keeps the search it already has, without asking again.
      await user.keyboard("{Enter}");
      expect(spy).toHaveBeenCalledTimes(2);

      // Emptying the field puts the recent searches back in place of the results.
      await user.clear(box);
      const recent = await within(dialog).findByRole("list", { name: "Recent searches" });
      expect(within(recent).getAllByRole("listitem")).toHaveLength(1);
      expect(recent).toHaveTextContent("mock");
      expect(within(dialog).queryByRole("tab", { name: "Messages" })).toBeNull();
    });

    it("searches at once on Enter, even while what was typed before is still out", async () => {
      const user = userEvent.setup();
      const { dialog, box, spy } = renderSearch((q) =>
        q === "mock"
          ? new Promise(() => {})
          : Promise.resolve({
              messages: [message("M5", "The mockups are ready", 5)],
              nextCursor: null,
            }),
      );
      await user.type(box, "mock");
      await waitFor(() => expect(spy).toHaveBeenCalledOnce());
      await user.type(box, "ups{Enter}");
      expect(spy).toHaveBeenLastCalledWith("mockups", 30, expect.anything());
      await within(dialog).findByText(/are ready/);
      await user.clear(box);
      expect(
        await within(dialog).findByRole("list", { name: "Recent searches" }),
      ).toHaveTextContent("mockups");
    });

    it("makes a day it can read a chip, and says which words are not dates", async () => {
      const user = userEvent.setup();
      const { dialog, box, spy } = renderSearch(async () => {
        throw new ApiError(
          400,
          "invalid_search_date",
          "Not a date: after:2026-02-31. Write dates as YYYY-MM-DD.",
        );
      });
      await user.type(box, "before:2026-03-08 after:2026-02-31");
      // The day that was named, in the reader's style.
      expect(chips(dialog)).toEqual([`Before ${day(2026, 3, 8)}`]);
      expect(box).toHaveValue("after:2026-02-31");
      expect(within(dialog).getByText("not a date: after:2026-02-31")).toBeVisible();

      await user.keyboard("{Enter}");
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "Not a date: after:2026-02-31. Write dates as YYYY-MM-DD.",
      );
      expect(spy).toHaveBeenLastCalledWith(
        "after:2026-02-31 before:2026-03-08",
        30,
        expect.anything(),
      );
      // Enter leaves what is not a date where the hint points at it.
      expect(chips(dialog)).toEqual([`Before ${day(2026, 3, 8)}`]);
      expect(box).toHaveValue("after:2026-02-31");
    });

    it("leaves a date being written alone until Enter", async () => {
      const user = userEvent.setup();
      const { dialog, box, spy } = renderSearch(async () => ({ messages: [], nextCursor: null }));
      await user.type(box, "before:2026-0");
      expect(within(dialog).getByText("not a date: before:2026-0")).toBeVisible();
      await pause(400);
      expect(spy).not.toHaveBeenCalled();
      await user.keyboard("{Enter}");
      expect(spy).toHaveBeenCalledWith("before:2026-0", 30, expect.anything());
    });
  });

  describe("its filters, as chips", () => {
    it("makes a typed modifier a chip once a space follows it, and leaves one still being written", async () => {
      const user = userEvent.setup();
      const { dialog, box, spy } = renderSearch(ready());
      await user.type(box, "from:@pri");
      expect(chips(dialog)).toEqual([]);
      expect(box).toHaveValue("from:@pri");
      await user.type(box, "ya ");
      expect(chips(dialog)).toEqual(["From Priya Shah"]);
      expect(box).toHaveValue("");

      // The words come first, then the filters.
      await user.type(box, "launch{Enter}");
      await within(dialog).findByText(/are ready/);
      expect(spy).toHaveBeenLastCalledWith(
        "launch from:priya",
        30,
        expect.objectContaining({ channelId: undefined }),
      );
      expect(dialog).toHaveTextContent("1 result · Newest first · “launch”");
    });

    it("takes every modifier left in the field on Enter, finished or not", async () => {
      const user = userEvent.setup();
      const { dialog, box, spy } = renderSearch(ready());
      await user.type(box, "launch in:#design has:link");
      expect(chips(dialog)).toEqual(["In #design"]);
      expect(box).toHaveValue("launch has:link");

      await user.keyboard("{Enter}");
      expect(chips(dialog)).toEqual(["In #design", "Has a link"]);
      expect(box.value.trim()).toBe("launch");
      await waitFor(() =>
        expect(spy).toHaveBeenLastCalledWith("launch in:design has:link", 30, expect.anything()),
      );
    });

    it("puts the caret back where it was once a modifier leaves the field", async () => {
      const user = userEvent.setup();
      const { dialog, box } = renderSearch(ready());
      await user.type(box, "launch");
      await user.type(box, "from:@priya ", { initialSelectionStart: 0, initialSelectionEnd: 0 });
      expect(chips(dialog)).toEqual(["From Priya Shah"]);
      expect(box).toHaveValue("launch");
      expect(box.selectionStart).toBe(0);
      await user.keyboard("big ");
      expect(box).toHaveValue("big launch");
    });

    it("takes a filter away in one click, and asks without it", async () => {
      const user = userEvent.setup();
      const { dialog, box, spy } = renderSearch(ready());
      await user.type(box, "launch from:@priya{Enter}");
      await waitFor(() =>
        expect(spy).toHaveBeenLastCalledWith("launch from:priya", 30, expect.anything()),
      );
      // One filter is not enough to need Clear all.
      expect(within(dialog).queryByRole("button", { name: "Clear all" })).toBeNull();

      await user.click(removeChip(dialog, "From Priya Shah"));
      expect(chips(dialog)).toEqual([]);
      expect(box).toHaveFocus();
      await waitFor(() => expect(spy).toHaveBeenLastCalledWith("launch", 30, expect.anything()));
    });

    it("offers Clear all once two filters are in force, and it clears them all", async () => {
      const user = userEvent.setup();
      const { dialog, box } = renderSearch(ready());
      await user.type(box, "from:@priya ");
      expect(within(dialog).queryByRole("button", { name: "Clear all" })).toBeNull();
      await user.type(box, "in:#design ");
      expect(chips(dialog)).toEqual(["From Priya Shah", "In #design"]);

      await user.click(within(dialog).getByRole("button", { name: "Clear all" }));
      expect(chips(dialog)).toEqual([]);
      expect(within(dialog).queryByRole("button", { name: "Clear all" })).toBeNull();
      expect(box).toHaveFocus();
      // Nothing is asked any more, so it is back to before anything was.
      expect(await within(dialog).findByText(/Add a filter above/)).toBeVisible();
      expect(within(dialog).queryByRole("tab", { name: "Messages" })).toBeNull();
    });

    it("chooses people, conversations and kinds from menus, ticking what is chosen", async () => {
      const user = userEvent.setup();
      const { dialog, spy } = renderSearch(ready());
      await user.click(within(dialog).getByRole("button", { name: "From" }));
      let menu = await screen.findByRole("menu", { name: "From" });
      expect(
        within(menu)
          .getAllByRole("menuitemcheckbox")
          .map((item) => item.textContent),
      ).toEqual(["Priya Shah@priya", "Sam Rivera@sam"]);
      await user.click(within(menu).getByRole("menuitemcheckbox", { name: /^Priya Shah/ }));
      expect(chips(dialog)).toEqual(["From Priya Shah"]);
      await waitFor(() =>
        expect(spy).toHaveBeenLastCalledWith(
          "from:priya",
          30,
          expect.objectContaining({ channelId: undefined }),
        ),
      );

      await pick(user, dialog, "In", "#design");
      expect(chips(dialog)).toEqual(["In #design", "From Priya Shah"]);
      await waitFor(() =>
        expect(spy).toHaveBeenLastCalledWith(
          "from:priya",
          30,
          expect.objectContaining({ channelId: design.id }),
        ),
      );

      await pick(user, dialog, "Has", "PDFs");
      expect(chips(dialog)).toEqual(["In #design", "From Priya Shah", "PDFs"]);
      await waitFor(() =>
        expect(spy).toHaveBeenLastCalledWith(
          "from:priya type:pdf",
          30,
          expect.objectContaining({ channelId: design.id }),
        ),
      );

      // Each menu ticks what is chosen, and choosing it again takes it away.
      await user.click(within(dialog).getByRole("button", { name: "From" }));
      menu = await screen.findByRole("menu", { name: "From" });
      expect(within(menu).getByRole("menuitemcheckbox", { name: /^Priya Shah/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(within(menu).getByRole("menuitemcheckbox", { name: /^Sam Rivera/ })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await user.click(within(menu).getByRole("menuitemcheckbox", { name: /^Priya Shah/ }));
      expect(chips(dialog)).toEqual(["In #design", "PDFs"]);

      await user.click(within(dialog).getByRole("button", { name: "In" }));
      menu = await screen.findByRole("menu", { name: "In" });
      expect(within(menu).getByRole("menuitemradio", { name: "#design" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await user.click(within(menu).getByRole("menuitemradio", { name: "#design" }));
      expect(chips(dialog)).toEqual(["PDFs"]);
    });

    it("chooses a span of days, or a day on either side, from Date", async () => {
      const user = userEvent.setup();
      const { dialog, spy } = renderSearch(ready());
      const date = within(dialog).getByRole("button", { name: "Date" });
      await user.click(date);
      let panel = await screen.findByRole("dialog", { name: "Date" });
      expect(date).toHaveAttribute("aria-expanded", "true");
      await user.click(within(panel).getByRole("button", { name: "Last 7 days" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Date" })).toBeNull());
      expect(chips(dialog)).toEqual(["Last 7 days"]);
      await waitFor(() =>
        expect(spy).toHaveBeenLastCalledWith(`after:${localDay(-7)}`, 30, expect.anything()),
      );

      // Another span replaces it.
      await user.click(date);
      panel = await screen.findByRole("dialog", { name: "Date" });
      await user.click(within(panel).getByRole("button", { name: "Today" }));
      expect(chips(dialog)).toEqual(["Today"]);

      // Or a day on either side, which the fields show as chosen.
      await user.click(date);
      panel = await screen.findByRole("dialog", { name: "Date" });
      expect(within(panel).getByLabelText("After")).toHaveValue(localDay(-1));
      expect(within(panel).getByLabelText("Before")).toHaveValue("");
      fireEvent.change(within(panel).getByLabelText("Before"), {
        target: { value: "2026-03-08" },
      });
      fireEvent.change(within(panel).getByLabelText("After"), { target: { value: "2026-03-01" } });
      expect(chips(dialog)).toEqual([`Before ${day(2026, 3, 8)}`, `After ${day(2026, 3, 1)}`]);
      // An emptied field takes its day away.
      fireEvent.change(within(panel).getByLabelText("Before"), { target: { value: "" } });
      expect(chips(dialog)).toEqual([`After ${day(2026, 3, 1)}`]);
      // The day already counts, so Enter in its field only puts the choices away.
      within(panel).getByLabelText("After").focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Date" })).toBeNull());
      expect(date).toHaveAttribute("aria-expanded", "false");
      await waitFor(() =>
        expect(spy).toHaveBeenLastCalledWith("after:2026-03-01", 30, expect.anything()),
      );
    });

    it("shows the modifiers it reads behind the ? button", async () => {
      const user = userEvent.setup();
      const { dialog } = renderSearch(ready());
      const help = within(dialog).getByRole("button", { name: "Search syntax" });
      const list = document.getElementById(help.getAttribute("aria-controls")!)!;
      expect(help).toHaveAttribute("aria-expanded", "false");
      expect(list).not.toBeVisible();

      await user.click(help);
      expect(help).toHaveAttribute("aria-expanded", "true");
      expect(list).toBeVisible();
      for (const token of [
        "from:@name",
        "in:#channel",
        "has:link",
        "has:file",
        "type:pdf",
        "after:2026-01-01",
        "before:2026-02-01",
      ])
        expect(within(list).getByText(token)).toBeVisible();
      expect(within(list).getByText("by one person")).toBeVisible();

      await user.click(help);
      expect(help).toHaveAttribute("aria-expanded", "false");
      expect(list).not.toBeVisible();
    });

    it("opened from a conversation, searches it at once and says so in a chip", async () => {
      const user = userEvent.setup();
      const { dialog, box, spy } = renderSearch(ready("Design notes are ready"), {
        inConversation: true,
        channelId: design.id,
      });
      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(
        "",
        30,
        expect.objectContaining({ channelId: design.id, cursor: undefined }),
      );
      expect(chips(dialog)).toEqual(["In #design"]);
      expect(box).toHaveValue("");
      expect(await within(dialog).findByText("Design notes are ready")).toBeVisible();

      // The In menu has it first, as this conversation, ticked.
      await user.click(within(dialog).getByRole("button", { name: "In" }));
      const menu = await screen.findByRole("menu", { name: "In" });
      const places = within(menu).getAllByRole("menuitemradio");
      expect(places.map((item) => item.textContent)).toEqual([
        "#designThis conversation",
        "#hidden",
      ]);
      expect(places[0]).toHaveAttribute("aria-checked", "true");
      await user.click(places[1]!);
      expect(chips(dialog)).toEqual(["In #hidden"]);
      await waitFor(() =>
        expect(spy).toHaveBeenLastCalledWith(
          "",
          30,
          expect.objectContaining({ channelId: hidden.id }),
        ),
      );

      // Without it nothing is asked, and the results go.
      await user.click(removeChip(dialog, "In #hidden"));
      expect(chips(dialog)).toEqual([]);
      await waitFor(() =>
        expect(within(dialog).queryByRole("tab", { name: "Messages" })).toBeNull(),
      );
    });

    it("opened with words from the palette, makes their modifiers chips and searches at once", async () => {
      const { dialog, box, spy } = renderSearch(ready(), { initialQuery: "launch from:@priya" });
      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(
        "launch from:priya",
        30,
        expect.objectContaining({ channelId: undefined }),
      );
      expect(chips(dialog)).toEqual(["From Priya Shah"]);
      expect(box.value.trim()).toBe("launch");
    });

    it("has nothing an automated check finds wrong, with chips and results showing", async () => {
      const user = userEvent.setup();
      const { dialog, box } = renderSearch(ready());
      await user.type(box, "from:@priya in:#design mockups{Enter}");
      await within(dialog).findByText(/are ready/);
      await user.click(within(dialog).getByRole("button", { name: "Search syntax" }));
      expect(chips(dialog)).toEqual(["From Priya Shah", "In #design"]);
      expect(await accessibilityProblems(dialog)).toEqual([]);
    });
  });

  describe("recent searches", () => {
    it("shows them before anything is asked, and repeats one with its modifiers as chips", async () => {
      const user = userEvent.setup();
      const { dialog, box, spy } = renderSearch(ready("Launch notes are ready"), {}, [
        { query: "launch from:priya" },
        { query: "", channelId: design.id },
      ]);
      const recent = await within(dialog).findByRole("list", { name: "Recent searches" });
      expect(within(recent).getAllByRole("listitem")).toHaveLength(2);
      expect(spy).not.toHaveBeenCalled();

      await user.click(within(recent).getByRole("button", { name: /^launch from:priya/ }));
      expect(spy).toHaveBeenLastCalledWith(
        "launch from:priya",
        30,
        expect.objectContaining({ channelId: undefined }),
      );
      expect(chips(dialog)).toEqual(["From Priya Shah"]);
      expect(box.value.trim()).toBe("launch");
      // Its answer takes the recent searches' place.
      await within(dialog).findByText(/notes are ready/);
      expect(within(dialog).queryByRole("list", { name: "Recent searches" })).toBeNull();

      // Back to nothing asked, and a search in one conversation.
      await user.click(removeChip(dialog, "From Priya Shah"));
      await user.clear(box);
      const again = await within(dialog).findByRole("list", { name: "Recent searches" });
      await user.click(within(again).getByRole("button", { name: /^All messages/ }));
      expect(spy).toHaveBeenLastCalledWith(
        "",
        30,
        expect.objectContaining({ channelId: design.id }),
      );
      expect(chips(dialog)).toEqual(["In #design"]);
      expect(box).toHaveValue("");
    });
  });

  describe("finding files (IMP-02)", () => {
    const file = (id: string, name: string, mime: string, size = 2048) => ({
      id,
      name,
      mime,
      size,
      width: null,
      height: null,
    });
    const pdf = file("F1", "Q3 Budget.pdf", "application/pdf");
    const sheet = file(
      "F2",
      "budget.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      4096,
    );
    const withFiles = (...files: ReturnType<typeof file>[]) =>
      ({ ...message("M3", "Numbers for the quarter", 3), threadRootId: "M1", files }) as Message;

    it("shows the names of a result's files, marking the words searched for", async () => {
      const user = userEvent.setup();
      const { dialog, box } = renderSearch(async () => ({
        messages: [withFiles(pdf)],
        nextCursor: null,
      }));
      await user.type(box, "budget{Enter}");
      const files = await within(dialog).findByRole("list", { name: "Attachments" });
      expect(files).toHaveTextContent("Q3 Budget.pdf");
      expect(files).toHaveTextContent("2.0 KB");
      expect(within(files).getByText("Budget").tagName).toBe("MARK");
      // Where it was said, so it can be opened there.
      expect(dialog).toHaveTextContent("Thread reply");
    });

    it("asks for one kind of file from Has, and says so in a chip", async () => {
      const user = userEvent.setup();
      const { dialog, box, spy } = renderSearch(async () => ({
        messages: [withFiles(pdf)],
        nextCursor: null,
      }));
      await pick(user, dialog, "Has", "PDFs");
      expect(chips(dialog)).toEqual(["PDFs"]);
      await user.type(box, "budget{Enter}");
      await within(dialog).findByRole("list", { name: "Attachments" });
      expect(spy).toHaveBeenLastCalledWith("budget type:pdf", 30, expect.anything());

      await user.click(within(dialog).getByRole("button", { name: "Has" }));
      const menu = await screen.findByRole("menu", { name: "Has" });
      expect(within(menu).getByRole("menuitemcheckbox", { name: "PDFs" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(within(menu).getByRole("menuitemcheckbox", { name: "Images" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      await user.click(removeChip(dialog, "PDFs"));
      expect(chips(dialog)).toEqual([]);
      await waitFor(() => expect(spy).toHaveBeenLastCalledWith("budget", 30, expect.anything()));
    });

    it("lists one row per file on the Files tab, asking only for messages with files", async () => {
      const user = userEvent.setup();
      const { dialog, box, spy, onJump } = renderSearch(async () => ({
        messages: [withFiles(pdf, sheet)],
        nextCursor: null,
      }));
      await user.type(box, "budget{Enter}");
      await within(dialog).findByRole("list", { name: "Attachments" });
      expect(dialog).toHaveTextContent("1 result · Newest first · “budget”");

      const tab = within(dialog).getByRole("tab", { name: "Files" });
      await user.click(tab);
      expect(tab).toHaveAttribute("aria-selected", "true");
      // Another tab is another question, asked at once.
      expect(spy).toHaveBeenLastCalledWith(
        "budget has:file",
        30,
        expect.objectContaining({ cursor: undefined }),
      );
      await waitFor(() => expect(resultList(dialog)).toHaveAttribute("aria-busy", "false"));
      expect(dialog).toHaveTextContent("2 files · Newest first · “budget”");
      const panel = within(dialog).getByRole("tabpanel", { name: "Files" });
      const rows = within(panel).getAllByRole("listitem");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent("Q3 Budget.pdf");
      expect(rows[0]).toHaveTextContent("#design");
      expect(rows[0]).toHaveTextContent("Priya Shah");
      expect(rows[0]).toHaveTextContent("2.0 KB");
      expect(within(rows[0]!).getByText("Budget").tagName).toBe("MARK");
      expect(rows[1]).toHaveTextContent("budget.xlsx");
      expect(rows[1]).toHaveTextContent("4.0 KB");

      // A row opens the message the file came with.
      await user.click(within(rows[1]!).getByRole("button"));
      expect(onJump).toHaveBeenCalledWith(design.id, "M3");

      // A kind of file already asks for files, so nothing is added to it.
      await pick(user, dialog, "Has", "Spreadsheets");
      await waitFor(() =>
        expect(spy).toHaveBeenLastCalledWith("budget type:spreadsheet", 30, expect.anything()),
      );
      // The Messages tab asks the same, so it asks nothing new.
      const asked = spy.mock.calls.length;
      await user.click(within(dialog).getByRole("tab", { name: "Messages" }));
      await pause(400);
      expect(spy).toHaveBeenCalledTimes(asked);
      expect(dialog).toHaveTextContent("1 result · Newest first · “budget”");
    });
  });
});
