import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { Channel, Message, User } from "@slackoss/protocol";
import { describe, expect, it, vi } from "vitest";
import { ActivityPanel } from "../src/components/ActivityPanel.js";
import { SearchDialog } from "../src/components/SearchDialog.js";
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
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: "Next page" })).toBeEnabled(),
    );
    await user.click(within(panel).getByRole("button", { name: "Next page" }));
    await within(panel).findByText("Earlier mention text");
    const requests = spy.mock.calls.length;

    text = "Updated mention text";
    act(() => client.store.setState({ mentionCounts: { [design.id]: 1 } }));
    expect(await within(panel).findByText("Updated mention text")).toBeVisible();
    expect(within(panel).queryByText("Earlier mention text")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(requests + 1);
    expect(spy).toHaveBeenLastCalledWith("mentions", expect.objectContaining({ cursor: "M5" }));
    expect(within(panel).getByRole("button", { name: "Previous page" })).toBeEnabled();
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

  it("goes to the next page by its cursor and back again", async () => {
    const user = userEvent.setup();
    const { panel, spy } = renderActivity(async (_mode, { cursor }) =>
      cursor
        ? { messages: [message("M2", "Older", 2)], nextCursor: null }
        : { messages: [message("M5", "Newer", 5)], nextCursor: "M5" },
    );
    await within(panel).findByText("Newer");
    expect(within(panel).getByRole("button", { name: "Previous page" })).toBeDisabled();
    await user.click(within(panel).getByRole("button", { name: "Next page" }));
    expect(await within(panel).findByText("Older")).toBeVisible();
    expect(spy).toHaveBeenLastCalledWith("unread", expect.objectContaining({ cursor: "M5" }));
    expect(within(panel).getByRole("button", { name: "Next page" })).toBeDisabled();
    await user.click(within(panel).getByRole("button", { name: "Previous page" }));
    expect(await within(panel).findByText("Newer")).toBeVisible();
  });
});

describe("the search dialog", () => {
  function renderSearch(
    search: (
      q: string,
      opts: { cursor?: string },
    ) => Promise<{ messages: Message[]; nextCursor: string | null }>,
  ) {
    const { client, platform } = workspace();
    const spy = vi
      .spyOn(client.api, "search")
      .mockImplementation((q, _limit, opts) => search(q, opts ?? {}));
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <SearchDialog onClose={() => {}} onJump={() => {}} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Search messages" });
    const box = within(dialog).getByRole("textbox", { name: "Search messages" });
    return { client, spy, dialog, box };
  }

  it("asks for its page again when a conversation in the results changes, dropping what was deleted (Q07)", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spy).toHaveBeenCalledTimes(asked);

    answer = [message("M_KEPT", "roadmap for the launch", 4)];
    act(() => client.store.setState({ changedContent: { [hidden.id]: 20, [design.id]: 21 } }));
    await waitFor(() => expect(within(dialog).queryByText(/notes since deleted/)).toBeNull());
    expect(within(dialog).getByText(/roadmap for the/)).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(asked + 1);
    expect(spy).toHaveBeenLastCalledWith(
      "launch",
      30,
      expect.objectContaining({ cursor: undefined }),
    );

    // Asked once for that change, not again and again.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spy).toHaveBeenCalledTimes(asked + 1);
  });

  it("asks again for the page it is on, not the first", async () => {
    const user = userEvent.setup();
    const { client, dialog, box, spy } = renderSearch(async (_q, { cursor }) =>
      cursor
        ? { messages: [message("M1", "Older mockups", 1)], nextCursor: null }
        : { messages: [message("M5", "Newer mockups", 5)], nextCursor: "M5" },
    );
    await user.type(box, "mockups{Enter}");
    await within(dialog).findByText(/Newer/);
    await user.click(within(dialog).getByRole("button", { name: "Next page" }));
    await within(dialog).findByText(/Older/);
    const asked = spy.mock.calls.length;

    act(() => client.store.setState({ changedContent: { [design.id]: 21 } }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(asked + 1));
    expect(spy).toHaveBeenLastCalledWith("mockups", 30, expect.objectContaining({ cursor: "M5" }));
    expect(dialog).toHaveTextContent("1 results · Page 2");
  });

  it("lets a newer question finish when a change arrives meanwhile, then asks it once more", async () => {
    const user = userEvent.setup();
    let release = () => {};
    let narrower = 0;
    const { client, dialog, box, spy } = renderSearch((q) => {
      if (q === "launch")
        return Promise.resolve({ messages: [message("M1", "the launch", 1)], nextCursor: null });
      narrower += 1;
      const found = {
        messages: [message("M2", `launch roadmap, answer ${narrower}`, 2)],
        nextCursor: null,
      };
      // The first answer to the newer question is slow; the one asked after it is not.
      return narrower === 1
        ? new Promise<typeof found>((resolve) => (release = () => resolve(found)))
        : Promise.resolve(found);
    });
    await user.type(box, "launch{Enter}");
    await within(dialog).findByText(/^the/);

    // The earlier results stay on show while the narrower question is out.
    await user.type(box, " roadmap{Enter}");
    await waitFor(() => expect(narrower).toBe(1));
    const asked = spy.mock.calls.length;
    const out = spy.mock.calls[asked - 1]![2]!.signal!;

    // A change is heard in a conversation those results come from. The
    // question that is out is not cut short to ask the old one again.
    act(() => client.store.setState({ changedContent: { [design.id]: 30 } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spy).toHaveBeenCalledTimes(asked);
    expect(out.aborted).toBe(false);

    // Its answer was asked for before the change, so it is asked for once more.
    await act(async () => release());
    await within(dialog).findByText(/answer 2/);
    expect(spy).toHaveBeenCalledTimes(asked + 1);
    expect(spy).toHaveBeenLastCalledWith("launch roadmap", 30, expect.anything());
  });

  it("says back the days it was given, and which ones are not dates", async () => {
    const user = userEvent.setup();
    const { dialog, box } = renderSearch(async () => {
      throw new ApiError(
        400,
        "invalid_search_date",
        "Not a date: before:2026-02-31. Write dates as YYYY-MM-DD.",
      );
    });
    await user.type(box, "after:2026-03-08 before:2026-02-31");
    const day = new Date(Date.UTC(2026, 2, 8)).toLocaleDateString(undefined, { timeZone: "UTC" });
    // The day that was named, not the one the bound happens to start on.
    expect(within(dialog).getByText(`after ${day}`)).toBeVisible();
    expect(within(dialog).getByText("not a date: before:2026-02-31")).toBeVisible();

    await user.keyboard("{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Not a date: before:2026-02-31. Write dates as YYYY-MM-DD.",
    );
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
    expect(dialog).toHaveTextContent("1 results · Page 1 · Newest first · “mockups”");
    expect(spy.mock.calls.map((call) => call[0])).toEqual(["mockups", "mockups"]);
  });

  it("says when nothing matched", async () => {
    const user = userEvent.setup();
    const { dialog, box } = renderSearch(async () => ({ messages: [], nextCursor: null }));
    await user.type(box, "zebra{Enter}");
    expect(await within(dialog).findByText("Nothing matched. Try different words.")).toBeVisible();
  });

  it("goes to the next page by its cursor", async () => {
    const user = userEvent.setup();
    const { dialog, box, spy } = renderSearch(async (_q, { cursor }) =>
      cursor
        ? { messages: [message("M1", "Older mockups", 1)], nextCursor: null }
        : { messages: [message("M5", "Newer mockups", 5)], nextCursor: "M5" },
    );
    await user.type(box, "mockups{Enter}");
    await within(dialog).findByText(/Newer/);
    await user.click(within(dialog).getByRole("button", { name: "Next page" }));
    await within(dialog).findByText(/Older/);
    expect(dialog).toHaveTextContent("1 results · Page 2");
    expect(spy).toHaveBeenLastCalledWith("mockups", 30, expect.objectContaining({ cursor: "M5" }));
  });

  it("says it is searching, and does not ask again until it has an answer", async () => {
    const user = userEvent.setup();
    let answer!: (value: { messages: Message[]; nextCursor: null }) => void;
    const { dialog, box, spy } = renderSearch(() => new Promise((resolve) => (answer = resolve)));
    await user.type(box, "mockups{Enter}");
    expect(within(dialog).getByRole("status")).toHaveTextContent("Searching…");
    await user.type(box, "{Enter}");
    expect(spy).toHaveBeenCalledOnce();

    answer({ messages: [message("M2", "The mockups are ready", 2)], nextCursor: null });
    await within(dialog).findByText(/are ready/);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("searches as it is typed, and keeps only what Enter settles on", async () => {
    const user = userEvent.setup();
    const { dialog, box, spy } = renderSearch(async () => ({
      messages: [message("M5", "The mockups are ready", 5)],
      nextCursor: null,
    }));
    await user.type(box, "mock");
    await waitFor(() =>
      expect(dialog).toHaveTextContent("1 results · Page 1 · Newest first · “mock”"),
    );
    expect(spy.mock.calls.map((call) => call[0])).toEqual(["mock"]);
    expect(within(dialog).queryByRole("list", { name: "Recent searches" })).toBeNull();

    // Enter keeps the search it already has, without asking again.
    await user.keyboard("{Enter}");
    const recent = await within(dialog).findByRole("list", { name: "Recent searches" });
    expect(recent).toHaveTextContent("mock");
    expect(spy).toHaveBeenCalledOnce();

    // Emptying the box puts the recent searches back in place of the results.
    await user.clear(box);
    await waitFor(() => expect(dialog).not.toHaveTextContent("1 results"));
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
    expect(await within(dialog).findByRole("list", { name: "Recent searches" })).toHaveTextContent(
      "mockups",
    );
  });

  it("leaves a date being written alone until Enter", async () => {
    const user = userEvent.setup();
    const { box, spy } = renderSearch(async () => ({ messages: [], nextCursor: null }));
    await user.type(box, "before:2026-0");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(spy).not.toHaveBeenCalled();
  });

  describe("finding files (IMP-02)", () => {
    const withFile = (name: string) => ({
      ...message("M3", "Numbers for the quarter", 3),
      threadRootId: "M1",
      files: [{ id: "F1", name, mime: "application/pdf", size: 2048, width: null, height: null }],
    });

    it("shows the names of a result's files, marking the words searched for", async () => {
      const user = userEvent.setup();
      const { dialog, box } = renderSearch(async () => ({
        messages: [withFile("Q3 Budget.pdf")],
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

    it("asks for one kind of file and says so", async () => {
      const user = userEvent.setup();
      const { dialog, box, spy } = renderSearch(async () => ({
        messages: [withFile("Q3 Budget.pdf")],
        nextCursor: null,
      }));
      await user.selectOptions(within(dialog).getByLabelText("Contains"), "PDFs");
      expect(within(dialog).getByText("pdfs")).toBeVisible();
      await user.type(box, "budget{Enter}");
      await within(dialog).findByRole("list", { name: "Attachments" });
      expect(spy).toHaveBeenCalledWith("budget type:pdf", 30, expect.anything());

      await user.click(within(dialog).getByRole("button", { name: "Clear filters" }));
      expect(within(dialog).getByLabelText("Contains")).toHaveValue("");
    });
  });
});
