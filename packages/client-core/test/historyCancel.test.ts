import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, Message } from "@ownbase/protocol";
import { ApiError, WorkspaceClient } from "../src/index.js";

/**
 * History transfers stop once nothing will use them, and an identical request
 * joins the one already on its way (REV-05). A transfer stopped on purpose is
 * not an error: whoever asked hears nothing went wrong.
 */
const channel = (id: string): Channel => ({
  id,
  type: "public",
  name: id.toLowerCase(),
  topic: "",
  description: "",
  creatorId: "U1",
  archived: false,
  createdAt: 0,
});

const message = (id: string, channelId = "C1", seq = 1): Message => ({
  id,
  channelId,
  userId: "U1",
  text: `message ${id}`,
  threadRootId: null,
  broadcast: false,
  seq,
  createdAt: 0,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
});

/** Requests that wait to be answered, and fail as fetch does when their signal stops them. */
function held<T>() {
  const calls: { signal?: AbortSignal; answer: (value: T) => void; fail: (e: unknown) => void }[] =
    [];
  const start = (signal?: AbortSignal) =>
    new Promise<T>((answer, fail) => {
      signal?.addEventListener("abort", () =>
        fail(new DOMException("The operation was aborted.", "AbortError")),
      );
      calls.push({ signal, answer, fail });
    });
  return { calls, start };
}

const clients: WorkspaceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
});

function client(channelIds = ["C1"]) {
  const c = new WorkspaceClient("http://127.0.0.1:9", "token");
  clients.push(c);
  c.store.setState({
    status: "online",
    lastSeq: 1,
    channels: Object.fromEntries(channelIds.map((id) => [id, channel(id)])),
    memberships: Object.fromEntries(channelIds.map((id) => [id, 0])),
  });
  return c;
}

type Page = { messages: Message[]; readThroughSeq?: number; seq?: number };

describe("history requests (REV-05)", () => {
  it("shares one request between identical first loads of a conversation", async () => {
    const c = client();
    const pages = held<Page>();
    const list = vi
      .spyOn(c.api, "listMessages")
      .mockImplementation((_id, opts) => pages.start(opts?.signal));
    const first = c.loadTimeline("C1");
    const second = c.loadTimeline("C1");
    expect(list).toHaveBeenCalledTimes(1);
    pages.calls[0]!.answer({ messages: [message("M1")], seq: 1 });
    await Promise.all([first, second]);
    expect(c.state.timelines.C1?.items.map((m) => m.id)).toEqual(["M1"]);
  });

  it("stops the transfer a jump replaces, and the replaced load settles without an error", async () => {
    const c = client();
    const pages = held<Page>();
    vi.spyOn(c.api, "listMessages").mockImplementation((_id, opts) => pages.start(opts?.signal));
    vi.spyOn(c.api, "listMessagesAround").mockResolvedValue({
      messages: [message("M5", "C1", 5)],
      hasMoreOlder: true,
      hasMoreNewer: true,
      seq: 1,
    });
    const tail = c.loadTimeline("C1");
    await c.jumpToMessage("C1", "M5");
    expect(pages.calls[0]!.signal?.aborted).toBe(true);
    await expect(tail).resolves.toBeUndefined();
    expect(c.state.timelines.C1?.items.map((m) => m.id)).toEqual(["M5"]);
  });

  it("stops a conversation's transfer when this person loses it", async () => {
    const c = client();
    const pages = held<Page>();
    vi.spyOn(c.api, "listMessages").mockImplementation((_id, opts) => pages.start(opts?.signal));
    const load = c.loadTimeline("C1");
    (c as unknown as { removeChannel(id: string): void }).removeChannel("C1");
    expect(pages.calls[0]!.signal?.aborted).toBe(true);
    await expect(load).resolves.toBeUndefined();
  });

  it("stops an older page of a conversation pushed out of the history cache", async () => {
    const ids = Array.from({ length: 22 }, (_, i) => `C${i + 1}`);
    const c = client(ids);
    const older = held<Page>();
    vi.spyOn(c.api, "listMessages").mockImplementation((id, opts) =>
      opts?.before
        ? older.start(opts.signal)
        : Promise.resolve({
            messages: Array.from({ length: 50 }, (_, i) => message(`${id}-M${i}`, id, i + 1)),
            seq: 1,
          }),
    );
    await c.loadTimeline("C1");
    const paging = c.loadTimeline("C1", { older: true });
    expect(older.calls).toHaveLength(1);
    for (const id of ids.slice(1)) await c.loadTimeline(id);
    expect(c.state.timelines.C1).toBeUndefined();
    expect(older.calls[0]!.signal?.aborted).toBe(true);
    await expect(paging).resolves.toBeUndefined();
  });

  it("stops every transfer when the client is destroyed", async () => {
    const c = client();
    const pages = held<Page>();
    const replies = held<{
      root: Message;
      messages: Message[];
      hasMoreOlder: boolean;
      hasMoreNewer: boolean;
      seq: number;
    }>();
    vi.spyOn(c.api, "listMessages").mockImplementation((_id, opts) => pages.start(opts?.signal));
    vi.spyOn(c.api, "threadHistory").mockImplementation((_c, _r, opts) =>
      replies.start(opts?.signal),
    );
    const timeline = c.loadTimeline("C1");
    const thread = c.loadThread("R1", "C1");
    c.destroy();
    expect(pages.calls[0]!.signal?.aborted).toBe(true);
    expect(replies.calls[0]!.signal?.aborted).toBe(true);
    await expect(timeline).resolves.toBeUndefined();
    await expect(thread).resolves.toBeUndefined();
  });

  it("still reports a failure that was nobody's choice", async () => {
    const c = client();
    vi.spyOn(c.api, "listMessages").mockRejectedValue(new ApiError(500, "http_error"));
    await expect(c.loadTimeline("C1")).rejects.toMatchObject({ status: 500 });
  });
});

describe("thread requests (REV-05)", () => {
  type Replies = {
    root: Message;
    messages: Message[];
    hasMoreOlder: boolean;
    hasMoreNewer: boolean;
    seq: number;
  };
  const root = { ...message("R1"), replyCount: 1 };
  const reply = (id: string): Message => ({ ...message(id), threadRootId: "R1" });

  it("shares one request between identical loads of a thread's newest replies", async () => {
    const c = client();
    const replies = held<Replies>();
    const history = vi
      .spyOn(c.api, "threadHistory")
      .mockImplementation((_c, _r, opts) => replies.start(opts?.signal));
    const first = c.loadThread("R1", "C1");
    const second = c.loadThread("R1", "C1");
    expect(history).toHaveBeenCalledTimes(1);
    replies.calls[0]!.answer({
      root,
      messages: [reply("M2")],
      hasMoreOlder: false,
      hasMoreNewer: false,
      seq: 1,
    });
    await Promise.all([first, second]);
    expect(c.state.threads.R1?.map((m) => m.id)).toEqual(["M2"]);
  });

  it("stops a thread page another replaces, without an error on the page", async () => {
    const c = client();
    const replies = held<Replies>();
    vi.spyOn(c.api, "threadHistory").mockImplementation((_c, _r, opts) =>
      replies.start(opts?.signal),
    );
    const newest = c.loadThread("R1", "C1");
    const atReply = c.loadThread("R1", "C1", "latest", "M7");
    expect(replies.calls[0]!.signal?.aborted).toBe(true);
    await expect(newest).resolves.toBeUndefined();
    replies.calls[1]!.answer({
      root,
      messages: [reply("M7")],
      hasMoreOlder: true,
      hasMoreNewer: true,
      seq: 1,
    });
    await atReply;
    expect(c.state.threadPages.R1).toMatchObject({ error: null, loading: false, loaded: true });
    expect(c.state.threads.R1?.map((m) => m.id)).toEqual(["M7"]);
  });
});
