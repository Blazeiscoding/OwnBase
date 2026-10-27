import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import type { Message, ServerToClient } from "@ownbase/protocol";
import { Api, WorkspaceClient } from "../src/index.js";

let server: WorkspaceServer;
let client: WorkspaceClient;
let owner: Api;
let channelId: string;
let memberId: string;
const releases: (() => void)[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

/** Capture the real server snapshot, then delay only its delivery to the client. */
function holdPage<Args extends unknown[], Page>(read: (...args: Args) => Promise<Page>) {
  const captured = deferred<Page>();
  const released = deferred<void>();
  const release = () => released.resolve();
  releases.push(release);
  return {
    captured: captured.promise,
    release,
    read: async (...args: Args) => {
      const page = await read(...args);
      captured.resolve(page);
      await released.promise;
      return page;
    },
  };
}

async function caughtUp() {
  const seq = server.store.currentSeq();
  await expect.poll(() => client.state.lastSeq).toBe(seq);
}

/** Delay real socket frames without delaying the HTTP snapshot that already includes them. */
function holdSocketEvents() {
  const connection = client as unknown as { handleServerMessage(message: ServerToClient): void };
  const handle = connection.handleServerMessage.bind(connection);
  const events: ServerToClient[] = [];
  const spy = vi.spyOn(connection, "handleServerMessage").mockImplementation((message) => {
    if (message.type === "event") events.push(message);
    else handle(message);
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    spy.mockRestore();
    for (const message of events) handle(message);
  };
  releases.push(release);
  return { events, release };
}

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base);
  const a = await api.register({ handle: "owner", displayName: "Owner", password: "password123" });
  const b = await api.register({
    handle: "member",
    displayName: "Member",
    password: "password123",
  });
  owner = new Api(base, a.token);
  memberId = b.user.id;
  client = new WorkspaceClient(base, b.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find((c) => c.name === "general")!.id;
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  client?.destroy();
  await server?.stop();
  vi.restoreAllMocks();
});

describe("timeline snapshot reconciliation", () => {
  it.each(["initial", "latest", "around", "older", "newer"] as const)(
    "preserves concurrent creates, edits, deletes, reactions, pins and replies through %s paging",
    async (kind) => {
      const messages: Message[] = [];
      for (let i = 0; i < 60; i++)
        messages.push((await owner.sendMessage(channelId, { text: `message ${i}` })).message);
      await caughtUp();
      const root = messages[kind === "around" || kind === "older" ? 0 : 58]!;
      const gone = messages[kind === "around" || kind === "older" ? 1 : 59]!;
      if (kind === "latest" || kind === "older") await client.loadTimeline(channelId);
      if (kind === "newer") {
        await client.jumpToMessage(channelId, messages[0]!.id);
        expect(client.state.timelines[channelId]?.hasMoreNewer).toBe(true);
      }
      const incoming = vi.fn();
      client.onIncomingMessage = incoming;
      let captured: Promise<unknown>;
      let release: () => void;
      let loading: Promise<unknown>;
      if (kind === "around") {
        const hold = holdPage(client.api.listMessagesAround.bind(client.api));
        vi.spyOn(client.api, "listMessagesAround").mockImplementation(hold.read);
        ({ captured, release } = hold);
        loading = client.jumpToMessage(channelId, root.id);
      } else if (kind === "newer") {
        const hold = holdPage(client.api.listMessagesAfter.bind(client.api));
        vi.spyOn(client.api, "listMessagesAfter").mockImplementation(hold.read);
        ({ captured, release } = hold);
        loading = client.loadNewer(channelId);
      } else {
        const hold = holdPage(client.api.listMessages.bind(client.api));
        vi.spyOn(client.api, "listMessages").mockImplementation(hold.read);
        ({ captured, release } = hold);
        loading = client.loadTimeline(channelId, {
          latest: kind === "latest",
          older: kind === "older",
        });
      }
      await captured;
      await owner.editMessage(root.id, "edited while history was on its way");
      await owner.deleteMessage(gone.id);
      await owner.addReaction(root.id, "yes");
      await owner.pinMessage(root.id);
      await owner.sendMessage(channelId, { text: "quiet reply", threadRootId: root.id });
      const live = (await owner.sendMessage(channelId, { text: "live arrival" })).message;
      await caughtUp();
      release();
      await loading;

      const timeline = client.state.timelines[channelId]!;
      expect(timeline.items.find((m) => m.id === root.id)).toMatchObject({
        text: "edited while history was on its way",
        pinned: true,
        replyCount: 1,
        reactions: [{ emoji: "yes", userIds: [root.userId] }],
      });
      expect(timeline.items.some((m) => m.id === gone.id)).toBe(false);
      expect(timeline.items.some((m) => m.id === live.id) || timeline.hasMoreNewer).toBe(true);
      expect(new Set(timeline.items.map((m) => m.id)).size).toBe(timeline.items.length);
      expect(timeline.items.map((m) => m.id)).toEqual(timeline.items.map((m) => m.id).sort());
      expect(incoming).toHaveBeenCalledTimes(2);
      if (kind !== "around") {
        expect(timeline.hasMoreNewer).toBe(false);
        expect(timeline.items.at(-1)?.id).toBe(live.id);
        expect(timeline.readThroughSeq).toBe(live.seq);
      }
    },
  );

  it("does not repeat events already represented by the response watermark", async () => {
    const root = (await owner.sendMessage(channelId, { text: "root" })).message;
    await caughtUp();
    const read = client.api.listMessages.bind(client.api);
    const beginRead = deferred<void>();
    releases.push(() => beginRead.resolve());
    vi.spyOn(client.api, "listMessages").mockImplementation(async (...args) => {
      await beginRead.promise;
      return read(...args);
    });
    const loading = client.loadTimeline(channelId);
    await owner.sendMessage(channelId, { text: "already in the snapshot", threadRootId: root.id });
    await caughtUp();
    beginRead.resolve();
    await loading;
    expect(client.state.timelines[channelId]?.items.find((m) => m.id === root.id)?.replyCount).toBe(
      1,
    );
  });

  it("keeps snapshot rows current when older socket frames arrive after the page", async () => {
    await caughtUp();
    const socket = holdSocketEvents();
    const root = (await owner.sendMessage(channelId, { text: "original root" })).message;
    await owner.editMessage(root.id, "snapshot text");
    await owner.sendMessage(channelId, { text: "quiet reply", threadRootId: root.id });
    await owner.addReaction(root.id, "yes");
    await owner.removeReaction(root.id, "yes");
    await owner.pinMessage(root.id);
    await owner.unpinMessage(root.id);
    await expect.poll(() => socket.events.length).toBe(7);
    await client.loadTimeline(channelId);
    const expected = { text: "snapshot text", replyCount: 1, reactions: [], pinned: false };
    expect(client.state.timelines[channelId]?.items[0]).toMatchObject(expected);
    socket.release();
    await caughtUp();
    expect(client.state.timelines[channelId]?.items).toHaveLength(1);
    expect(client.state.timelines[channelId]?.items[0]).toMatchObject(expected);
  });

  it("preserves different row watermarks when an older page arrives ahead of socket events", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 60; i++)
      messages.push((await owner.sendMessage(channelId, { text: `message ${i}` })).message);
    await caughtUp();
    await client.loadTimeline(channelId);
    const socket = holdSocketEvents();
    const olderRoot = messages[0]!;
    const currentRoot = messages.at(-1)!;
    await owner.sendMessage(channelId, { text: "older reply", threadRootId: olderRoot.id });
    await owner.sendMessage(channelId, { text: "current reply", threadRootId: currentRoot.id });
    const arrival = (await owner.sendMessage(channelId, { text: "delayed live arrival" })).message;
    await expect.poll(() => socket.events.length).toBe(3);
    await client.loadTimeline(channelId, { older: true });
    let timeline = client.state.timelines[channelId]!;
    expect(timeline.items.find((m) => m.id === olderRoot.id)?.replyCount).toBe(1);
    expect(timeline.items.find((m) => m.id === currentRoot.id)?.replyCount).toBe(0);
    socket.release();
    await caughtUp();
    timeline = client.state.timelines[channelId]!;
    expect(timeline.items.find((m) => m.id === olderRoot.id)?.replyCount).toBe(1);
    expect(timeline.items.find((m) => m.id === currentRoot.id)?.replyCount).toBe(1);
    expect(timeline.items.at(-1)?.id).toBe(arrival.id);
    expect(timeline.readThroughSeq).toBe(arrival.seq);
  });

  it("reconciles reaction/pin removals, a deleted reply and a broadcast reply", async () => {
    const root = (await owner.sendMessage(channelId, { text: "root" })).message;
    const reply = (await owner.sendMessage(channelId, { text: "reply", threadRootId: root.id }))
      .message;
    await owner.pinMessage(root.id);
    await owner.addReaction(root.id, "yes");
    await caughtUp();
    const hold = holdPage(client.api.listMessages.bind(client.api));
    vi.spyOn(client.api, "listMessages").mockImplementationOnce(hold.read);
    const loading = client.loadTimeline(channelId);
    await hold.captured;
    await owner.unpinMessage(root.id);
    await owner.removeReaction(root.id, "yes");
    await owner.deleteMessage(reply.id);
    const broadcast = (
      await owner.sendMessage(channelId, {
        text: "also in the channel",
        threadRootId: root.id,
        alsoSendToChannel: true,
      })
    ).message;
    await caughtUp();
    hold.release();
    await loading;
    expect(client.state.timelines[channelId]?.items.find((m) => m.id === root.id)).toMatchObject({
      replyCount: 1,
      pinned: false,
      reactions: [],
    });
    expect(client.state.timelines[channelId]?.items.at(-1)?.id).toBe(broadcast.id);
    expect(client.state.timelines[channelId]?.readThroughSeq).toBe(broadcast.seq);
  });

  it("preserves a pending pin choice when an older snapshot refreshes the window", async () => {
    const root = (await owner.sendMessage(channelId, { text: "root" })).message;
    await caughtUp();
    await client.loadTimeline(channelId);
    const history = holdPage(client.api.listMessages.bind(client.api));
    vi.spyOn(client.api, "listMessages").mockImplementationOnce(history.read);
    const loading = client.loadTimeline(channelId, { latest: true });
    await history.captured;
    const pinRelease = deferred<void>();
    releases.push(() => pinRelease.resolve());
    const pin = client.api.pinMessage.bind(client.api);
    vi.spyOn(client.api, "pinMessage").mockImplementation(async (...args) => {
      await pinRelease.promise;
      return pin(...args);
    });
    const pinning = client.togglePin(client.state.timelines[channelId]!.items[0]!);
    expect(client.state.timelines[channelId]?.items[0]?.pinned).toBe(true);
    history.release();
    await loading;
    expect(client.state.timelines[channelId]?.items[0]?.pinned).toBe(true);
    pinRelease.resolve();
    expect(await pinning).toBe(true);
    await caughtUp();
    expect(client.state.timelines[channelId]?.items[0]?.pinned).toBe(true);
  });

  it("keeps older-page continuity when live arrivals trim the captured window", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 330; i++)
      messages.push((await owner.sendMessage(channelId, { text: `message ${i}` })).message);
    await caughtUp();
    await client.loadTimeline(channelId);
    for (let i = 0; i < 5; i++) await client.loadTimeline(channelId, { older: true });
    expect(client.state.timelines[channelId]?.items).toHaveLength(300);
    const hold = holdPage(client.api.listMessages.bind(client.api));
    vi.spyOn(client.api, "listMessages").mockImplementationOnce(hold.read);
    const loading = client.loadTimeline(channelId, { older: true });
    await hold.captured;
    await owner.sendMessage(channelId, { text: "trim one" });
    await owner.sendMessage(channelId, { text: "trim two" });
    await caughtUp();
    expect(client.state.timelines[channelId]?.items[0]?.id).toBe(messages[32]?.id);
    hold.release();
    await loading;
    expect(client.state.timelines[channelId]?.items.map((m) => m.id)).toEqual(
      messages.slice(0, 300).map((m) => m.id),
    );
    expect(client.state.timelines[channelId]?.hasMoreNewer).toBe(true);
  });

  it("opens a thread at its newest replies when the reply to open at is gone (IMP-02)", async () => {
    const root = (await owner.sendMessage(channelId, { text: "root" })).message;
    const first = (await owner.sendMessage(channelId, { text: "first", threadRootId: root.id }))
      .message;
    await owner.sendMessage(channelId, { text: "second", threadRootId: root.id });
    await owner.deleteMessage(first.id);
    await caughtUp();
    await client.loadThread(root.id, channelId, "latest", first.id);
    expect(client.state.threadPages[root.id]).toMatchObject({ loaded: true, error: null });
    expect(client.state.threadPages[root.id]?.root?.id).toBe(root.id);
    expect(client.state.threads[root.id]?.map((m) => m.text)).toEqual(["second"]);
  });

  it("drops a deleted thread when a deletion frame could not go out, and takes later messages (REV-10)", async () => {
    const root = (await owner.sendMessage(channelId, { text: "root" })).message;
    for (const text of ["one", "two", "three"])
      await owner.sendMessage(channelId, { text, threadRootId: root.id });
    await caughtUp();
    await client.loadTimeline(channelId);
    await client.loadThread(root.id, channelId);
    expect(client.state.threads[root.id]).toHaveLength(3);
    (client as unknown as { reconnectDelay: number }).reconnectDelay = 10;
    // The second deletion cannot be fanned out; the server closes the socket.
    const publish = server.gateway.publish.bind(server.gateway);
    let calls = 0;
    vi.spyOn(server.gateway, "publish").mockImplementation((envelope, channel) => {
      if (++calls === 2) throw new Error("could not serialize");
      publish(envelope, channel);
    });
    await owner.deleteMessage(root.id);
    vi.mocked(server.gateway.publish).mockRestore();
    // A later message must not carry the client past the deletions it missed.
    const later = (await owner.sendMessage(channelId, { text: "later" })).message;

    await expect.poll(() => client.state.status).toBe("online");
    await caughtUp();
    const timeline = client.state.timelines[channelId]?.items.map((m) => m.id) ?? [];
    expect(timeline).not.toContain(root.id);
    expect(timeline).toContain(later.id);
    expect(client.state.threads[root.id] ?? []).toEqual([]);
  });

  it("keeps an HTTP-acknowledged reply exactly once when its socket echo follows the page", async () => {
    const root = (await owner.sendMessage(channelId, { text: "root" })).message;
    await client.loadTimeline(channelId);
    await client.loadThread(root.id, channelId);
    const hold = holdPage(client.api.listMessages.bind(client.api));
    vi.spyOn(client.api, "listMessages").mockImplementation(hold.read);
    const loading = client.loadTimeline(channelId, { latest: true });
    await hold.captured;
    const connection = client as unknown as { ws: WebSocket; reconnectDelay: number };
    connection.reconnectDelay = 60_000;
    connection.ws.close();
    await expect.poll(() => client.state.status).toBe("reconnecting");
    expect(client.send(channelId, "HTTP reply", { threadRootId: root.id })).toBe(true);
    await expect.poll(() => client.state.pending.length).toBe(0);
    hold.release();
    await loading;
    expect(client.state.timelines[channelId]?.items.find((m) => m.id === root.id)?.replyCount).toBe(
      1,
    );
    client.connect();
    await expect.poll(() => client.state.status).toBe("online");
    await caughtUp();
    expect(client.state.timelines[channelId]?.items.find((m) => m.id === root.id)?.replyCount).toBe(
      1,
    );
    expect(client.state.threadPages[root.id]?.root?.replyCount).toBe(1);
    expect(client.state.threads[root.id]).toHaveLength(1);
  });

  it("does not cancel an older page or retain an event buffer for a message already on screen", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 60; i++)
      messages.push((await owner.sendMessage(channelId, { text: `message ${i}` })).message);
    await caughtUp();
    await client.loadTimeline(channelId);
    const hold = holdPage(client.api.listMessages.bind(client.api));
    vi.spyOn(client.api, "listMessages").mockImplementation(hold.read);
    const loading = client.loadTimeline(channelId, { older: true });
    await hold.captured;
    expect(await client.jumpToMessage(channelId, messages.at(-1)!.id)).toBeNull();
    hold.release();
    await loading;
    expect(client.state.timelines[channelId]?.items).toHaveLength(60);
    const holds = (client as unknown as { timelineHolds: Map<string, unknown> }).timelineHolds;
    expect(holds.size).toBe(0);
  });

  it("accepts only the newest of overlapping jumps", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 60; i++)
      messages.push((await owner.sendMessage(channelId, { text: `message ${i}` })).message);
    await caughtUp();
    const hold = holdPage(client.api.listMessagesAround.bind(client.api));
    vi.spyOn(client.api, "listMessagesAround").mockImplementationOnce(hold.read);
    const first = client.jumpToMessage(channelId, messages[0]!.id);
    await hold.captured;
    await client.jumpToMessage(channelId, messages.at(-1)!.id);
    const newestWindow = client.state.timelines[channelId];
    hold.release();
    expect(await first).toBeUndefined();
    expect(client.state.timelines[channelId]).toBe(newestWindow);
    expect(newestWindow?.items.at(-1)?.id).toBe(messages.at(-1)?.id);
  });

  it("keeps the current window recoverable when the event buffer overflows", async () => {
    const root = (await owner.sendMessage(channelId, { text: "root" })).message;
    await caughtUp();
    await client.loadTimeline(channelId);
    const hold = holdPage(client.api.listMessages.bind(client.api));
    vi.spyOn(client.api, "listMessages").mockImplementationOnce(hold.read);
    const loading = client.loadTimeline(channelId, { latest: true });
    await hold.captured;
    const connection = client as unknown as { handleServerMessage(message: ServerToClient): void };
    const start = client.state.lastSeq;
    for (let i = 1; i <= 2001; i++)
      connection.handleServerMessage({
        type: "event",
        envelope: {
          seq: start + i,
          event: { type: "message.updated", message: { ...root, text: `edit ${i}` } },
        },
      });
    hold.release();
    await expect(loading).rejects.toMatchObject({ code: "history_changed" });
    expect(client.state.timelines[channelId]?.items[0]?.text).toBe("edit 2001");
    const holds = (client as unknown as { timelineHolds: Map<string, unknown> }).timelineHolds;
    expect(holds.size).toBe(0);
    await client.loadTimeline(channelId, { latest: true });
    expect(client.state.timelines[channelId]?.items[0]?.text).toBe("root");
  });

  it("loads quiet legacy pages and refuses an ambiguous legacy response after live changes", async () => {
    const root = (await owner.sendMessage(channelId, { text: "root" })).message;
    await caughtUp();
    const read = client.api.listMessages.bind(client.api);
    const legacy = async (...args: Parameters<Api["listMessages"]>) => {
      const { seq: _seq, ...page } = await read(...args);
      return page;
    };
    const spy = vi.spyOn(client.api, "listMessages").mockImplementation(legacy);
    await client.loadTimeline(channelId);
    expect(client.state.timelines[channelId]?.items[0]?.id).toBe(root.id);
    const hold = holdPage(legacy);
    spy.mockImplementationOnce(hold.read);
    const loading = client.loadTimeline(channelId, { latest: true });
    await hold.captured;
    await owner.editMessage(root.id, "latest text");
    await caughtUp();
    hold.release();
    await expect(loading).rejects.toMatchObject({ code: "history_changed" });
    expect(client.state.timelines[channelId]?.items[0]?.text).toBe("latest text");
    await client.loadTimeline(channelId, { latest: true });
    expect(client.state.timelines[channelId]?.items[0]?.text).toBe("latest text");
  });

  it("applies retention invalidation to a captured page before it can reinstall purged history", async () => {
    const root = (await owner.sendMessage(channelId, { text: "root" })).message;
    await caughtUp();
    const hold = holdPage(client.api.listMessages.bind(client.api));
    vi.spyOn(client.api, "listMessages").mockImplementationOnce(hold.read);
    const loading = client.loadTimeline(channelId);
    await hold.captured;
    const connection = client as unknown as { handleServerMessage(message: ServerToClient): void };
    connection.handleServerMessage({
      type: "event",
      envelope: {
        seq: client.state.lastSeq + 1,
        event: { type: "history.removed", channelId, rootIds: [root.id] },
      },
    });
    hold.release();
    await loading;
    expect(client.state.timelines[channelId]?.items).toEqual([]);
  });
});

describe("scoped history invalidation", () => {
  async function privateRoom() {
    const { channel } = await owner.createChannel({ type: "private", name: "private-room" });
    await owner.inviteMember(channel.id, memberId);
    await expect.poll(() => !!client.state.channels[channel.id]).toBe(true);
    return channel.id;
  }

  it("finishes both timeline and thread loading when access to another channel is removed", async () => {
    const otherId = await privateRoom();
    const root = (await owner.sendMessage(channelId, { text: "root" })).message;
    await caughtUp();
    const timeline = holdPage(client.api.listMessages.bind(client.api));
    const thread = holdPage(client.api.threadHistory.bind(client.api));
    vi.spyOn(client.api, "listMessages").mockImplementationOnce(timeline.read);
    vi.spyOn(client.api, "threadHistory").mockImplementationOnce(thread.read);
    const loadingTimeline = client.loadTimeline(channelId);
    const loadingThread = client.loadThread(root.id, channelId);
    await Promise.all([timeline.captured, thread.captured]);
    await owner.removeChannelMember(otherId, memberId);
    await expect.poll(() => client.state.channels[otherId]).toBeUndefined();
    timeline.release();
    thread.release();
    await Promise.all([loadingTimeline, loadingThread]);
    expect(client.state.timelines[channelId]?.items[0]?.id).toBe(root.id);
    expect(client.state.threadPages[root.id]).toMatchObject({ loaded: true, loading: false });
  });

  it("cannot reinstall a revoked channel from late timeline or thread responses", async () => {
    const privateId = await privateRoom();
    const root = (await owner.sendMessage(privateId, { text: "private root" })).message;
    await caughtUp();
    const timeline = holdPage(client.api.listMessages.bind(client.api));
    const thread = holdPage(client.api.threadHistory.bind(client.api));
    vi.spyOn(client.api, "listMessages").mockImplementationOnce(timeline.read);
    vi.spyOn(client.api, "threadHistory").mockImplementationOnce(thread.read);
    const loadingTimeline = client.loadTimeline(privateId);
    const loadingThread = client.loadThread(root.id, privateId);
    await Promise.all([timeline.captured, thread.captured]);
    await owner.removeChannelMember(privateId, memberId);
    await expect.poll(() => client.state.channels[privateId]).toBeUndefined();
    timeline.release();
    thread.release();
    await Promise.all([loadingTimeline, loadingThread]);
    expect(client.state.timelines[privateId]).toBeUndefined();
    expect(client.state.threadPages[root.id]).toBeUndefined();
    expect(client.state.threads[root.id]).toBeUndefined();
  });

  it("restarts initial timeline and thread loads on a full reconnect resync", async () => {
    const root = (await owner.sendMessage(channelId, { text: "root" })).message;
    await caughtUp();
    const timeline = holdPage(client.api.listMessages.bind(client.api));
    const thread = holdPage(client.api.threadHistory.bind(client.api));
    vi.spyOn(client.api, "listMessages").mockImplementationOnce(timeline.read);
    vi.spyOn(client.api, "threadHistory").mockImplementationOnce(thread.read);
    const loadingTimeline = client.loadTimeline(channelId);
    const loadingThread = client.loadThread(root.id, channelId);
    await Promise.all([timeline.captured, thread.captured]);
    const connection = client as unknown as { handleServerMessage(message: ServerToClient): void };
    connection.handleServerMessage({ type: "resync" });
    await expect.poll(() => client.state.status).toBe("online");
    await expect.poll(() => client.state.timelines[channelId]?.loaded).toBe(true);
    await expect.poll(() => client.state.threadPages[root.id]?.loading).toBe(false);
    const replacementTimeline = client.state.timelines[channelId];
    const replacementThread = client.state.threadPages[root.id];
    timeline.release();
    thread.release();
    await Promise.all([loadingTimeline, loadingThread]);
    expect(client.state.timelines[channelId]).toBe(replacementTimeline);
    expect(client.state.threadPages[root.id]).toBe(replacementThread);
  });

  it("settles loading on logout and ignores both late responses", async () => {
    const root = (await owner.sendMessage(channelId, { text: "root" })).message;
    await caughtUp();
    const timeline = holdPage(client.api.listMessages.bind(client.api));
    const thread = holdPage(client.api.threadHistory.bind(client.api));
    vi.spyOn(client.api, "listMessages").mockImplementationOnce(timeline.read);
    vi.spyOn(client.api, "threadHistory").mockImplementationOnce(thread.read);
    const loadingTimeline = client.loadTimeline(channelId);
    const loadingThread = client.loadThread(root.id, channelId);
    await Promise.all([timeline.captured, thread.captured]);
    client.destroy();
    expect(client.state.status).toBe("closed");
    expect(client.state.threadPages[root.id]?.loading).toBe(false);
    timeline.release();
    thread.release();
    await Promise.all([loadingTimeline, loadingThread]);
    expect(client.state.timelines[channelId]).toBeUndefined();
    expect(client.state.threadPages[root.id]?.loaded).toBe(false);
  });
});

describe("paging forward (F14)", () => {
  it("shares one transfer between identical newer-page requests, and both settle", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 120; i++)
      messages.push((await owner.sendMessage(channelId, { text: `forward ${i}` })).message);
    await caughtUp();
    await client.jumpToMessage(channelId, messages[0]!.id);
    expect(client.state.timelines[channelId]?.hasMoreNewer).toBe(true);
    const after = vi.spyOn(client.api, "listMessagesAfter");

    await Promise.all([client.loadNewer(channelId), client.loadNewer(channelId)]);
    expect(after).toHaveBeenCalledTimes(1);
    const ids = client.state.timelines[channelId]!.items.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const order = messages.map((m) => m.id).filter((id) => ids.includes(id));
    expect(ids.filter((id) => order.includes(id))).toEqual(order);

    // A different window is a different request, and replaces it.
    await client.loadNewer(channelId);
    expect(after).toHaveBeenCalledTimes(2);
  });
});
