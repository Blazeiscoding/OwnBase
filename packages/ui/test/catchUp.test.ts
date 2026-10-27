import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@ownbase/protocol";
import { CatchUpSummary, namesList } from "../src/lib/catchUp.js";
import { catchUpContent } from "../src/lib/notificationPreview.js";

const message = (n: number): Message => ({
  id: `M${n}`,
  channelId: "C1",
  userId: "U1",
  text: `message ${n}`,
  threadRootId: null,
  broadcast: false,
  seq: n,
  createdAt: 0,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
});

describe("a catch-up summary", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function summary(stillNews: (m: Message) => boolean = () => true) {
    const shown: string[][] = [];
    const catchUp = new CatchUpSummary({
      stillNews,
      show: (messages) => shown.push(messages.map((m) => m.id)),
      intervalMs: 60_000,
      quietMs: 1_000,
    });
    return { catchUp, shown };
  }

  it("shows what was held once the replay has been quiet, oldest first", () => {
    const { catchUp, shown } = summary();
    for (const n of [3, 1, 2]) {
      catchUp.hold(message(n));
      vi.advanceTimersByTime(500);
    }
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(shown).toEqual([["M1", "M2", "M3"]]);
  });

  it("shows at most one summary per interval, then what was held meanwhile together", () => {
    const { catchUp, shown } = summary();
    catchUp.hold(message(1));
    vi.advanceTimersByTime(1_000);
    expect(shown).toHaveLength(1);

    // Two more reconnects soon after.
    catchUp.hold(message(2));
    vi.advanceTimersByTime(10_000);
    catchUp.hold(message(3));
    // A minute from the first summary, not from the last reconnect.
    vi.advanceTimersByTime(49_999);
    expect(shown).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual([["M1"], ["M2", "M3"]]);
  });

  it("leaves out what is no longer news and what was dropped", () => {
    const { catchUp, shown } = summary((m) => m.id !== "M2");
    for (const n of [1, 2, 3, 4]) catchUp.hold(message(n));
    catchUp.drop("M4");
    vi.advanceTimersByTime(1_000);
    expect(shown).toEqual([["M1", "M3"]]);
  });

  it("shows nothing when nothing is still news, and does not hold back the next", () => {
    const { catchUp, shown } = summary((m) => m.id !== "M1");
    catchUp.hold(message(1));
    vi.advanceTimersByTime(1_000);
    expect(shown).toEqual([]);
    catchUp.hold(message(2));
    vi.advanceTimersByTime(1_000);
    expect(shown).toEqual([["M2"]]);
  });

  it("shows nothing after it is disposed", () => {
    const { catchUp, shown } = summary();
    catchUp.hold(message(1));
    catchUp.dispose();
    vi.advanceTimersByTime(60_000);
    expect(shown).toEqual([]);
  });
});

describe("what a catch-up summary says", () => {
  it("lists who sent them, briefly", () => {
    expect(namesList(["Sam"])).toBe("Sam");
    expect(namesList(["Sam", "Ana"])).toBe("Sam and Ana");
    expect(namesList(["Sam", "Ana", "Lee"])).toBe("Sam, Ana and Lee");
    expect(namesList(["Sam", "Ana", "Lee", "Kai", "Mo"])).toBe("Sam, Ana and 3 others");
  });

  it("says how many and where, then who", () => {
    const missed = { count: 7, conversations: 1, channelName: "design", senders: "Sam and Ana" };
    expect(catchUpContent("full", missed)).toEqual({
      title: "7 new messages in #design",
      body: "From Sam and Ana",
    });
    expect(catchUpContent("sender", { ...missed, conversations: 3 })).toEqual({
      title: "7 new messages in 3 conversations",
      body: "From Sam and Ana",
    });
    // A direct message has no name of its own; the body says who.
    expect(catchUpContent("full", { ...missed, channelName: "" }).title).toBe("7 new messages");
  });

  it("names nobody and no conversation when the choice is nothing", () => {
    const content = catchUpContent("none", {
      count: 7,
      conversations: 1,
      channelName: "design",
      senders: "Sam and Ana",
    });
    expect(content).toEqual({ title: "7 new messages", body: "Open OwnBase to read them." });
  });
});
