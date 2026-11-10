import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, EventEnvelope, Message, ServerToClient } from "@ownbase/protocol";
import { WorkspaceClient, threadReplies, threadRootMessage } from "../src/index.js";

/**
 * A channel's events touch few of its open threads (REV-03). Threads an event
 * does not touch read back as the same replies and root, so nothing showing
 * them renders again; the ones it does touch still change.
 */
const THREADS = 20;
const REPLIES = 300;

const channel: Channel = {
  id: "C1",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: "U1",
  archived: false,
  createdAt: 0,
};

const message = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  channelId: "C1",
  userId: "U1",
  text: `message ${id}`,
  threadRootId: null,
  broadcast: false,
  seq: 1,
  createdAt: 0,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  previews: [],
  actions: [],
  ...over,
});

const rootId = (t: number) => `R${String(t).padStart(2, "0")}`;
const replyId = (t: number, r: number) => `${rootId(t)}-${String(r).padStart(3, "0")}`;

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.destroy();
  vi.restoreAllMocks();
});

/** A client holding twenty open threads of three hundred replies in one channel. */
function cached() {
  const c = new WorkspaceClient("http://127.0.0.1:9", "token");
  clients.push(c);
  const messages: Record<string, Message> = {};
  const threads: Record<string, string[]> = {};
  const threadPages: Record<string, any> = {};
  for (let t = 0; t < THREADS; t++) {
    const replies = Array.from({ length: REPLIES }, (_, r) =>
      message(replyId(t, r), { threadRootId: rootId(t) }),
    );
    for (const reply of replies) messages[reply.id] = reply;
    messages[rootId(t)] = message(rootId(t), { replyCount: REPLIES });
    threads[rootId(t)] = replies.map((reply) => reply.id);
    threadPages[rootId(t)] = {
      channelId: "C1",
      rootGone: false,
      hasMoreOlder: false,
      hasMoreNewer: false,
      loaded: true,
      loading: false,
      error: null,
    };
  }
  c.store.setState({
    status: "online",
    lastSeq: 100,
    channels: { C1: channel },
    memberships: { C1: 100 },
    messages,
    threads,
    threadPages,
  });
  let seq = 100;
  const connection = c as unknown as { handleServerMessage(message: ServerToClient): void };
  const send = (event: EventEnvelope["event"]) =>
    connection.handleServerMessage({ type: "event", envelope: { seq: ++seq, event } });
  /** Which threads read back as other replies or another root after `event`. */
  const changedBy = (event: EventEnvelope["event"]) => {
    const before = c.state;
    const shown = Object.keys(before.threads).map((id) => [
      id,
      threadReplies(before, id),
      threadRootMessage(before, id),
    ]);
    send(event);
    const after = c.state;
    return shown
      .filter(
        ([id, replies, root]) =>
          threadReplies(after, id as string) !== replies ||
          threadRootMessage(after, id as string) !== root,
      )
      .map(([id]) => id);
  };
  return { c, changedBy };
}

describe("open threads and the events of their channel (REV-03)", () => {
  it("keep every thread as it was for events that touch none of them", () => {
    const { c, changedBy } = cached();
    expect(changedBy({ type: "message.created", message: message("M-new") })).toEqual([]);
    expect(
      changedBy({ type: "message.updated", message: message("M-other", { text: "edited" }) }),
    ).toEqual([]);
    expect(
      changedBy({
        type: "reaction.added",
        channelId: "C1",
        messageId: "M-other",
        emoji: "👍",
        userId: "U2",
      }),
    ).toEqual([]);
    expect(
      changedBy({
        type: "message.deleted",
        channelId: "C1",
        messageId: "M-other",
        threadRootId: null,
      }),
    ).toEqual([]);
  });

  it("change only the thread an event belongs to", () => {
    const { c, changedBy } = cached();
    expect(
      changedBy({
        type: "message.created",
        message: message("R03-new", { threadRootId: rootId(3) }),
      }),
    ).toEqual([rootId(3)]);
    expect(c.state.threads[rootId(3)]?.at(-1)).toBe("R03-new");
    expect(
      changedBy({
        type: "message.updated",
        message: message(replyId(5, 7), { threadRootId: rootId(5), text: "edited" }),
      }),
    ).toEqual([rootId(5)]);
    expect(threadReplies(c.state, rootId(5))?.[7]?.text).toBe("edited");
    expect(
      changedBy({
        type: "reaction.added",
        channelId: "C1",
        messageId: replyId(8, 0),
        emoji: "🎉",
        userId: "U2",
      }),
    ).toEqual([rootId(8)]);
    // Deleting a root empties its own thread, and only that one.
    expect(
      changedBy({
        type: "message.deleted",
        channelId: "C1",
        messageId: rootId(9),
        threadRootId: null,
      }),
    ).toEqual([rootId(9)]);
    expect(threadRootMessage(c.state, rootId(9))).toBeNull();
    expect(c.state.threads[rootId(9)]).toEqual([]);
  });

  it("still hears every event while a thread page is loading, for its reconciliation", async () => {
    const { c, changedBy } = cached();
    let answer!: (value: any) => void;
    vi.spyOn(c.api, "threadHistory").mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const loading = c.loadThread(rootId(2), "C1");
    // An event in the channel arrives while that page is on its way.
    changedBy({ type: "message.updated", message: message("M-other", { text: "edited" }) });
    changedBy({
      type: "message.created",
      message: message("R02-live", { threadRootId: rootId(2), seq: 102 }),
    });
    answer({
      root: message(rootId(2), { replyCount: 1 }),
      messages: [message(replyId(2, 0), { threadRootId: rootId(2) })],
      hasMoreOlder: false,
      hasMoreNewer: false,
      seq: 100,
    });
    await loading;
    // The reply that arrived meanwhile is replayed onto the page it loaded.
    expect(c.state.threads[rootId(2)]).toEqual([replyId(2, 0), "R02-live"]);
  });
});
