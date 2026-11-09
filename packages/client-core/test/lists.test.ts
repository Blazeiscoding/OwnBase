import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, ScheduledMessage, ThreadFollow } from "@ownbase/protocol";
import { ApiError, WorkspaceClient } from "../src/index.js";

/**
 * The lists beside the conversations read themselves while open and read
 * themselves again when an event says what they show may have changed, so
 * whoever shows one only opens it (U6, UX-08).
 */
const message = (id: string, channelId = "C1", extra: Partial<Message> = {}) =>
  ({ id, channelId, text: id, threadRootId: null, pinned: false, ...extra }) as Message;

function workspace() {
  return new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
}

/** Lets reads answer and the refresh delay pass. */
const settle = () => vi.advanceTimersByTimeAsync(300);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Saved", () => {
  it("reads itself while open, again when something is saved or unsaved, and not once closed", async () => {
    const client = workspace();
    const read = vi
      .spyOn(client.api, "listSaved")
      .mockResolvedValue({ messages: [message("M1")], nextCursor: null } as never);
    const list = client.lists.saved();
    const close = list.open();
    await settle();
    expect(list.current.items?.map((m) => m.id)).toEqual(["M1"]);
    expect(read).toHaveBeenCalledTimes(1);

    client.store.setState({ saved: { M1: true, M2: true } });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);

    // A change elsewhere says nothing about this list.
    client.store.setState({ lastSeq: 9 });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);

    close();
    client.store.setState({ saved: {} });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads itself again when a listed message's conversation changed, and only then", async () => {
    const client = workspace();
    const read = vi
      .spyOn(client.api, "listSaved")
      .mockResolvedValue({ messages: [message("M1", "C1")], nextCursor: null } as never);
    const list = client.lists.saved();
    list.open();
    await settle();
    client.store.setState({ changedContent: { C2: 1 } });
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    client.store.setState({ changedContent: { C2: 1, C1: 1 } });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("a channel's pins", () => {
  it("read again when a pin in the loaded history changes, or the channel's content does", async () => {
    const client = workspace();
    const read = vi
      .spyOn(client.api, "listPins")
      .mockResolvedValue({ messages: [], nextCursor: null, total: 0 } as never);
    client.lists.pins("C1").open();
    await settle();
    client.store.setState({
      messages: { M1: message("M1", "C1", { pinned: true }) },
      timelines: {
        C1: { ids: ["M1"], hasMoreOlder: false, hasMoreNewer: false, loading: false },
      },
    } as never);
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    client.store.setState({ changedContent: { C1: 1 } });
    await settle();
    expect(read).toHaveBeenCalledTimes(3);
    client.store.setState({ changedContent: { C1: 1, C9: 1 } });
    await settle();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("give a header the count and the newest", async () => {
    const client = workspace();
    const read = vi
      .spyOn(client.api, "listPins")
      .mockResolvedValue({ messages: [message("M3")], nextCursor: "M3", total: 4 } as never);
    expect(await client.lists.pinSummary("C1")).toEqual({ total: 4, newest: message("M3") });
    expect(read).toHaveBeenCalledWith("C1", undefined, undefined, 1);
  });
});

describe("followed threads", () => {
  it("keep what the server said of each thread, and read again when a follow changes", async () => {
    const client = workspace();
    const root = message("R1");
    const reply = message("M2", "C1", { threadRootId: "R1" });
    const read = vi.spyOn(client.api, "listFollowedThreads").mockResolvedValue({
      threads: [{ root, unreadCount: 2, latestReply: reply }],
      nextCursor: null,
    } as never);
    const list = client.lists.followedThreads(true);
    list.open();
    await settle();
    expect(read).toHaveBeenCalledWith({ cursor: undefined, unreadOnly: true }, expect.anything());
    expect(list.detail("R1")).toEqual({ unreadCount: 2, latestReply: reply });

    const follow = { rootId: "R1", following: true, lastReadSeq: 3, lastSeq: 5 } as ThreadFollow;
    client.store.setState({ threadFollows: { R1: follow } });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("Activity", () => {
  it("reads Unread again for a new message in a conversation joined, but Mentions only for mention counts", async () => {
    const client = workspace();
    client.store.setState({ memberships: { C1: 0 } });
    const read = vi
      .spyOn(client.api, "activity")
      .mockResolvedValue({ messages: [], nextCursor: null } as never);
    client.lists.activity("unread").open();
    client.lists.activity("mentions").open();
    await settle();
    expect(read).toHaveBeenCalledTimes(2);

    client.store.setState({ channelLastSeq: { C1: 4 } });
    await settle();
    expect(read.mock.calls.slice(2).map(([ask]) => ask)).toEqual(["unread"]);

    client.store.setState({ mentionCounts: { C1: 1 } });
    await settle();
    expect(
      read.mock.calls
        .slice(3)
        .map(([ask]) => ask)
        .sort(),
    ).toEqual(["mentions", "unread"]);
  });
});

describe("the scheduled queue", () => {
  const queued = (id: string, sendAt: number, text = id) =>
    ({ id, channelId: "C1", text, sendAt, fileIds: [] }) as unknown as ScheduledMessage;

  it("reads itself again when the server says it changed", async () => {
    const client = workspace();
    const read = vi
      .spyOn(client.api, "listScheduled")
      .mockResolvedValue({ scheduled: [queued("S1", 10)] } as never);
    const list = client.lists.scheduled();
    list.open();
    await settle();
    expect(list.current.items?.map((s) => s.id)).toEqual(["S1"]);
    client.store.setState({ scheduledChanges: 1 });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps the server's answer to a change here, in order, over a read still out", async () => {
    const client = workspace();
    let answer: (value: unknown) => void = () => {};
    vi.spyOn(client.api, "listScheduled")
      .mockResolvedValueOnce({ scheduled: [queued("S1", 10), queued("S2", 20)] } as never)
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)) as never);
    vi.spyOn(client.api, "rescheduleMessage").mockResolvedValue({
      scheduled: queued("S1", 30),
    } as never);
    const list = client.lists.scheduled();
    list.open();
    await settle();
    void list.reload();
    await list.reschedule("S1", 30);
    answer({ scheduled: [queued("S1", 10), queued("S2", 20)] });
    await settle();
    expect(list.current.items?.map((s) => [s.id, s.sendAt])).toEqual([
      ["S2", 20],
      ["S1", 30],
    ]);
    expect(list.current.loading).toBe(false);
  });

  it("leaves the list as it was when the server refuses a change", async () => {
    const client = workspace();
    vi.spyOn(client.api, "listScheduled").mockResolvedValue({
      scheduled: [queued("S1", 10, "hi")],
    } as never);
    vi.spyOn(client.api, "editScheduledMessage").mockRejectedValue(
      new ApiError(409, "scheduled_changed"),
    );
    const list = client.lists.scheduled();
    list.open();
    await settle();
    await expect(list.edit("S1", { text: "hello", expectedText: "hi" })).rejects.toMatchObject({
      code: "scheduled_changed",
    });
    expect(list.current.items?.map((s) => s.text)).toEqual(["hi"]);
  });
});
