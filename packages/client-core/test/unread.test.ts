import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient, isMessageRead, unreadThreadCount } from "../src/index.js";

let server: WorkspaceServer;
let client: WorkspaceClient;
let owner: Api;
let member: { token: string; id: string };
let channelId: string;

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
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
  member = { token: b.token, id: b.user.id };
  client = new WorkspaceClient(base, b.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find((c) => c.name === "general")!.id;
  await client.loadTimeline(channelId);
  client.focusConversation(channelId);
});

afterEach(async () => {
  client?.destroy();
  await server?.stop();
  vi.restoreAllMocks();
});

/** Posts as the other account and waits for it to arrive on the socket. */
async function incoming(text: string, threadRootId?: string) {
  const { message } = await owner.sendMessage(channelId, { text, nonce: text, threadRootId });
  await expect
    .poll(() =>
      threadRootId
        ? client.state.threads[threadRootId]?.some((m) => m.id === message.id)
        : client.state.timelines[channelId]?.items.some((m) => m.id === message.id),
    )
    .toBe(true);
  return message;
}

const lastRead = () => client.state.memberships[channelId] ?? 0;

describe("mark unread", () => {
  it("holds a conversation unread against the automatic acknowledgement behind it", async () => {
    const first = await incoming("First");
    const second = await incoming("Second");
    client.markRead(channelId, second.seq);
    await expect.poll(lastRead).toBe(second.seq);

    client.markUnread(channelId, second.seq);
    expect(lastRead()).toBe(second.seq - 1);

    // The timeline keeps acknowledging its visible tail; the hold ignores it.
    client.markRead(channelId, second.seq);
    expect(lastRead()).toBe(second.seq - 1);
    await expect
      .poll(async () => (await owner.listChannels()) && client.state.memberships[channelId])
      .toBe(second.seq - 1);
    expect(first.seq).toBeLessThan(second.seq);
  });

  it("lifts the hold once the conversation is left, so coming back reads it", async () => {
    const message = await incoming("Later");
    client.markRead(channelId, message.seq);
    client.markUnread(channelId, message.seq);
    expect(lastRead()).toBe(message.seq - 1);

    client.focusConversation(null);
    client.focusConversation(channelId);
    client.markRead(channelId, message.seq);
    await expect.poll(lastRead).toBe(message.seq);
  });

  it("lets an explicit read through clear the hold, unlike the timeline's own", async () => {
    const message = await incoming("Read me on purpose");
    client.markUnread(channelId, message.seq);
    await expect.poll(lastRead).toBe(message.seq - 1);

    client.markRead(channelId, message.seq);
    expect(lastRead()).toBe(message.seq - 1);

    client.markRead(channelId, message.seq, { explicit: true });
    await expect.poll(lastRead).toBe(message.seq);
  });

  it("keeps the hold across a resync that discards loaded history", async () => {
    const message = await incoming("Survives resync");
    client.markUnread(channelId, message.seq);
    await expect.poll(lastRead).toBe(message.seq - 1);

    (client as unknown as { resetHistory: () => void }).resetHistory();
    client.markRead(channelId, message.seq);
    expect(lastRead()).toBe(message.seq - 1);
  });

  it("puts the cursor back when the server refuses", async () => {
    const message = await incoming("Rejected");
    client.markRead(channelId, message.seq);
    await expect.poll(lastRead).toBe(message.seq);

    vi.spyOn(client.api, "markUnread").mockRejectedValue(new Error("offline"));
    client.markUnread(channelId, message.seq);
    expect(lastRead()).toBe(message.seq - 1);
    await expect.poll(lastRead).toBe(message.seq);

    // The failed hold was released, so ordinary reading works again.
    client.markRead(channelId, message.seq);
    expect(lastRead()).toBe(message.seq);
  });

  it("keeps a read chosen after marking unread when the mark then fails", async () => {
    const message = await incoming("Changed my mind");
    client.markRead(channelId, message.seq);
    await expect.poll(lastRead).toBe(message.seq);

    let refuse = () => {};
    vi.spyOn(client.api, "markUnread").mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = () => reject(new Error("offline"));
        }),
    );
    client.markUnread(channelId, message.seq);
    expect(lastRead()).toBe(message.seq - 1);

    const later = await incoming("Read this instead");
    const markRead = vi.spyOn(client.api, "markRead");
    client.markRead(channelId, later.seq, { explicit: true });
    await markRead.mock.results[0]!.value;
    expect(lastRead()).toBe(later.seq);

    refuse();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lastRead()).toBe(later.seq);
  });

  /** Answers each mark unread when told to, in whatever order the test chooses. */
  function heldMarks() {
    const answers: { accept: () => void; refuse: () => void }[] = [];
    vi.spyOn(client.api, "markUnread").mockImplementation(
      (_channel, seq) =>
        new Promise((resolve, reject) => {
          answers.push({
            accept: () => resolve({ ok: true, seq }),
            refuse: () => reject(new Error("offline")),
          });
        }),
    );
    return answers;
  }
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("keeps a second mark of the same message when the first then fails (Q10)", async () => {
    const message = await incoming("Marked twice");
    client.markRead(channelId, message.seq);
    await expect.poll(lastRead).toBe(message.seq);

    const answers = heldMarks();
    client.markUnread(channelId, message.seq);
    client.markUnread(channelId, message.seq);
    answers[1]!.accept();
    await settled();
    answers[0]!.refuse();
    await settled();

    expect(lastRead()).toBe(message.seq - 1);
    // Still held unread: looking at it does not read it again.
    client.markRead(channelId, message.seq);
    expect(lastRead()).toBe(message.seq - 1);
  });

  it("goes back to before the first mark when both of the same message fail", async () => {
    const message = await incoming("Refused twice");
    client.markRead(channelId, message.seq);
    await expect.poll(lastRead).toBe(message.seq);

    const answers = heldMarks();
    client.markUnread(channelId, message.seq);
    client.markUnread(channelId, message.seq);
    answers[0]!.refuse();
    await settled();
    // The second is still out, and speaks for the cursor.
    expect(lastRead()).toBe(message.seq - 1);
    answers[1]!.refuse();
    await settled();

    expect(lastRead()).toBe(message.seq);
    client.markRead(channelId, message.seq);
    expect(lastRead()).toBe(message.seq);
  });

  it("goes back to the mark the server took when a later one fails", async () => {
    const first = await incoming("Kept unread from here");
    const second = await incoming("Not from here");
    client.markRead(channelId, second.seq);
    await expect.poll(lastRead).toBe(second.seq);

    const answers = heldMarks();
    client.markUnread(channelId, first.seq);
    client.markUnread(channelId, second.seq);
    expect(lastRead()).toBe(second.seq - 1);
    answers[0]!.accept();
    await settled();
    answers[1]!.refuse();
    await settled();

    expect(lastRead()).toBe(first.seq - 1);
  });

  it("marks a thread unread without touching the channel, and counts it", async () => {
    const root = await incoming("Thread root");
    await client.loadThread(root.id, channelId, "latest");
    const reply = await incoming("A reply", root.id);
    client.focusThread(root.id);
    client.markThreadRead(root.id);
    await expect.poll(() => unreadThreadCount(client.state.threadFollows)).toBe(0);

    const channelCursor = lastRead();
    client.markThreadUnread(root.id, reply.seq);
    await expect.poll(() => unreadThreadCount(client.state.threadFollows)).toBe(1);
    expect(lastRead()).toBe(channelCursor);

    // Reading the thread again is held until the panel is left.
    client.markThreadRead(root.id);
    expect(unreadThreadCount(client.state.threadFollows)).toBe(1);
    client.focusThread(null);
    client.focusThread(root.id);
    client.markThreadRead(root.id);
    await expect.poll(() => unreadThreadCount(client.state.threadFollows)).toBe(0);
  });
});

describe("reading a thread", () => {
  it("reads a thread up to a reply named from elsewhere, such as Activity, though it was never opened", async () => {
    const { message: root } = await owner.sendMessage(channelId, {
      text: "Where to?",
      nonce: "r0",
    });
    const { message: first } = await owner.sendMessage(channelId, {
      text: `North <@${member.id}>`,
      nonce: "r1",
      threadRootId: root.id,
    });
    await owner.sendMessage(channelId, { text: "Or south", nonce: "r2", threadRootId: root.id });
    expect(client.state.threads[root.id]).toBeUndefined();

    const sent = vi.spyOn(client.api, "markThreadRead");
    client.markThreadRead(root.id, { explicit: true, through: first });
    expect(sent).toHaveBeenCalledWith(root.id, first.seq);
    expect(client.state.threadFollows[root.id]).toMatchObject({
      following: false,
      lastReadSeq: first.seq,
    });
  });

  it("moves only the thread's cursor, so an unseen channel mention stays unread", async () => {
    const root = await incoming("Plans for Friday");
    client.markRead(channelId, root.seq);
    await expect.poll(lastRead).toBe(root.seq);
    const mention = await incoming(`can you look <@${member.id}>`);
    await client.loadThread(root.id, channelId, "latest");
    const reply = await incoming(`and this <@${member.id}>`, root.id);
    await expect.poll(() => client.state.mentionCounts[channelId]).toBe(2);
    // The reply lives in its thread; the channel's newest is the mention.
    expect(client.state.channelLastSeq[channelId]).toBe(mention.seq);

    client.focusThread(root.id);
    client.markThreadRead(root.id);
    expect(client.state.threadFollows[root.id]).toMatchObject({
      following: false,
      lastReadSeq: reply.seq,
    });
    await expect.poll(() => client.state.mentionCounts[channelId]).toBe(1);
    expect(lastRead()).toBe(root.seq);
    expect(isMessageRead(reply, client.state)).toBe(true);
    expect(isMessageRead(mention, client.state)).toBe(false);
    expect(unreadThreadCount(client.state.threadFollows)).toBe(0);

    // A fresh connection agrees: nothing about the channel was acknowledged.
    const again = new WorkspaceClient(`http://127.0.0.1:${server.port}`, member.token);
    try {
      again.connect();
      await expect.poll(() => again.state.status).toBe("online");
      expect(again.state.memberships[channelId]).toBe(root.seq);
      expect(again.state.mentionCounts[channelId]).toBe(1);
      expect(again.state.channelLastSeq[channelId]).toBe(mention.seq);
      expect(again.state.threadFollows[root.id]).toMatchObject({
        following: false,
        lastReadSeq: reply.seq,
      });
    } finally {
      again.destroy();
    }
  });

  it("puts back a thread cursor the server refused, including having none", async () => {
    const root = await incoming("Unfollowed");
    await client.loadThread(root.id, channelId, "latest");
    await incoming("A reply", root.id);
    vi.spyOn(client.api, "markThreadRead").mockRejectedValue(new Error("offline"));
    client.markThreadRead(root.id);
    expect(client.state.threadFollows[root.id]?.lastReadSeq).toBeGreaterThan(0);
    await expect.poll(() => client.state.threadFollows[root.id]).toBeUndefined();
  });

  it("keeps a newer read of a thread when an older one fails after it", async () => {
    const root = await incoming("Two replies");
    await client.loadThread(root.id, channelId, "latest");
    const first = await incoming("First", root.id);
    const markThreadRead = vi.spyOn(client.api, "markThreadRead");
    let refuse = () => {};
    markThreadRead.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = () => reject(new Error("offline"));
        }),
    );
    client.markThreadRead(root.id);
    expect(client.state.threadFollows[root.id]?.lastReadSeq).toBe(first.seq);

    const second = await incoming("Second", root.id);
    client.markThreadRead(root.id);
    await markThreadRead.mock.results[1]!.value;
    expect(client.state.threadFollows[root.id]?.lastReadSeq).toBe(second.seq);

    refuse();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.state.threadFollows[root.id]?.lastReadSeq).toBe(second.seq);
  });

  it("counts a reply toward the channel's badge only when it is also sent to the channel", async () => {
    const root = await incoming("Root");
    client.markRead(channelId, root.seq);
    await client.loadThread(root.id, channelId, "latest");
    await incoming("Only in the thread", root.id);
    expect(client.state.channelLastSeq[channelId]).toBe(root.seq);

    const { message } = await owner.sendMessage(channelId, {
      text: "For everyone",
      nonce: "copied",
      threadRootId: root.id,
      alsoSendToChannel: true,
    });
    await expect.poll(() => client.state.channelLastSeq[channelId]).toBe(message.seq);
  });
});

describe("following a thread", () => {
  const followed = async (rootId: string) =>
    (await client.api.listFollowedThreads()).threads.some((thread) => thread.root.id === rootId);

  it("sends an Unfollow only once the Follow before it is answered, so the server ends unfollowed (Q09)", async () => {
    const root = await incoming("Follow, then not");
    await client.loadThread(root.id, channelId, "latest");
    const send = client.api.setThreadFollow.bind(client.api);
    let release = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    // The Follow is slow to reach the server; sent together, the Unfollow would get there first.
    const sent = vi
      .spyOn(client.api, "setThreadFollow")
      .mockImplementationOnce(async (rootId, following) => {
        await slow;
        return send(rootId, following);
      });

    client.setThreadFollow(root.id, true);
    client.setThreadFollow(root.id, false);
    expect(client.state.threadFollows[root.id]?.following).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent.mock.calls.map(([, following]) => following)).toEqual([true]);

    release();
    await expect
      .poll(() => sent.mock.calls.map(([, following]) => following))
      .toEqual([true, false]);
    await Promise.all(sent.mock.results.map((result) => result.value));
    expect(await followed(root.id)).toBe(false);
    expect(client.state.threadFollows[root.id]?.following).toBe(false);
  });

  it("still sends the Unfollow when the Follow before it fails", async () => {
    const root = await incoming("Follow fails");
    await client.loadThread(root.id, channelId, "latest");
    const sent = vi
      .spyOn(client.api, "setThreadFollow")
      .mockRejectedValueOnce(new Error("offline"));

    client.setThreadFollow(root.id, true);
    client.setThreadFollow(root.id, false);
    await expect.poll(() => sent.mock.calls.length).toBe(2);
    await sent.mock.results[1]!.value;

    expect(await followed(root.id)).toBe(false);
    expect(client.state.threadFollows[root.id]?.following).toBe(false);
  });

  it("sends nothing that was waiting its turn once the client is closed", async () => {
    const root = await incoming("Closed meanwhile");
    await client.loadThread(root.id, channelId, "latest");
    let release = () => {};
    const sent = vi.spyOn(client.api, "setThreadFollow").mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          release = () => reject(new Error("offline"));
        }),
    );

    client.setThreadFollow(root.id, true);
    client.setThreadFollow(root.id, false);
    client.destroy();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sent).toHaveBeenCalledOnce();
  });
});

describe("muting a thread", () => {
  it("round-trips, shown at once here and through the server on another device", async () => {
    expect(client.state.threadMutes).toBe(true);
    const root = await incoming("Noisy thread");
    await client.loadThread(root.id, channelId, "latest");
    await incoming("chatter", root.id);
    client.setThreadFollow(root.id, true);
    const other = new WorkspaceClient(client.baseUrl, member.token);
    try {
      other.connect();
      await expect.poll(() => other.state.threadFollows[root.id]?.following).toBe(true);

      client.setThreadMute(root.id, true);
      expect(client.state.threadFollows[root.id]).toMatchObject({ following: false, muted: true });
      await expect.poll(() => other.state.threadFollows[root.id]?.muted).toBe(true);
      expect(server.store.threadFollow(member.id, root.id)?.muted).toBe(true);

      client.setThreadMute(root.id, false);
      expect(client.state.threadFollows[root.id]?.muted).toBeUndefined();
      await expect.poll(() => other.state.threadFollows[root.id]?.muted).toBeUndefined();
      expect(other.state.threadFollows[root.id]?.following).toBe(false);
    } finally {
      other.destroy();
    }
  });

  it("stays muted while the thread is read, before the server answers", async () => {
    const root = await incoming("Muted, then read");
    await client.loadThread(root.id, channelId, "latest");
    client.setThreadMute(root.id, true);
    await expect.poll(() => server.store.threadFollow(member.id, root.id)?.muted).toBe(true);
    await incoming("a reply", root.id);

    let answer = () => {};
    const read = client.api.markThreadRead.bind(client.api);
    const sent = vi
      .spyOn(client.api, "markThreadRead")
      .mockImplementationOnce(async (rootId, seq) => {
        await new Promise<void>((resolve) => (answer = resolve));
        return read(rootId, seq);
      });
    client.markThreadRead(root.id);
    expect(client.state.threadFollows[root.id]).toMatchObject({ following: false, muted: true });
    answer();
    await sent.mock.results[0]!.value;
    expect(client.state.threadFollows[root.id]).toMatchObject({ following: false, muted: true });
  });

  it("sends a Follow only once the mute before it is answered, so the server ends following", async () => {
    const root = await incoming("Mute, then follow");
    await client.loadThread(root.id, channelId, "latest");
    const send = client.api.setThreadMute.bind(client.api);
    let release = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    const muted = vi
      .spyOn(client.api, "setThreadMute")
      .mockImplementationOnce(async (rootId, on) => {
        await slow;
        return send(rootId, on);
      });
    const followed = vi.spyOn(client.api, "setThreadFollow");

    client.setThreadMute(root.id, true);
    client.setThreadFollow(root.id, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(followed).not.toHaveBeenCalled();

    release();
    await expect.poll(() => followed.mock.calls.length).toBe(1);
    await muted.mock.results[0]!.value;
    await followed.mock.results[0]!.value;
    expect(server.store.threadFollow(member.id, root.id)).toMatchObject({ following: true });
    expect(server.store.threadFollow(member.id, root.id)?.muted).toBeUndefined();
  });

  it("puts the thread back as it was when the server refuses", async () => {
    const root = await incoming("Refused");
    await client.loadThread(root.id, channelId, "latest");
    client.setThreadFollow(root.id, true);
    await expect.poll(() => server.store.threadFollow(member.id, root.id)?.following).toBe(true);
    vi.spyOn(client.api, "setThreadMute").mockRejectedValue(new Error("offline"));

    client.setThreadMute(root.id, true);
    expect(client.state.threadFollows[root.id]?.muted).toBe(true);
    await expect.poll(() => client.state.threadFollows[root.id]?.muted).toBeUndefined();
    expect(client.state.threadFollows[root.id]?.following).toBe(true);
  });
});

describe("the read rule every surface uses", () => {
  const reply = (seq: number, broadcast = false) => ({
    channelId: "C1",
    seq,
    threadRootId: "R1",
    broadcast,
  });
  const follow = (lastReadSeq: number) => ({
    R1: { rootId: "R1", channelId: "C1", following: true, lastReadSeq, lastSeq: 99, revision: 1 },
  });

  it("reads what the channel shows with its cursor, and replies only through their thread", () => {
    const state = { memberships: { C1: 50 }, repliesRead: { C1: 10 }, threadFollows: {} };
    expect(
      isMessageRead({ channelId: "C1", seq: 40, threadRootId: null, broadcast: false }, state),
    ).toBe(true);
    // Without a thread cursor, as far as the membership's floor.
    expect(isMessageRead(reply(10), state)).toBe(true);
    expect(isMessageRead(reply(40), state)).toBe(false);
    // A thread cursor decides for its own thread, above or below the floor.
    expect(isMessageRead(reply(40), { ...state, threadFollows: follow(45) })).toBe(true);
    expect(isMessageRead(reply(8), { ...state, threadFollows: follow(5) })).toBe(false);
    // A reply also sent to the channel is read by either cursor.
    expect(isMessageRead(reply(40, true), state)).toBe(true);
    expect(isMessageRead(reply(60, true), { ...state, threadFollows: follow(60) })).toBe(true);
  });

  it("leaves a reply also sent to the channel unread while its thread is held unread", () => {
    const state = { memberships: { C1: 50 }, repliesRead: { C1: 10 } };
    const held = (unreadHold: number) => ({
      R1: { ...follow(39).R1, unreadHold },
    });
    // Marked unread when the channel stood at 50: the channel no longer reads it.
    expect(isMessageRead(reply(40, true), { ...state, threadFollows: held(50) })).toBe(false);
    // Read past that since, it does again.
    expect(isMessageRead(reply(40, true), { ...state, threadFollows: held(45) })).toBe(true);
    // A quiet reply is the thread's either way.
    expect(isMessageRead(reply(40), { ...state, threadFollows: held(45) })).toBe(false);
  });

  it("keeps the older rule for a server that reads replies with the channel's cursor", () => {
    const state = { memberships: { C1: 50 }, repliesRead: null, threadFollows: follow(5) };
    expect(isMessageRead(reply(40), state)).toBe(true);
    expect(isMessageRead(reply(60), state)).toBe(false);
  });
});

describe("agreeing with the server about replies", () => {
  it("holds a reply read in the channel unread once its thread is marked unread, on every device", async () => {
    const root = await incoming("A thread");
    await client.loadThread(root.id, channelId, "latest");
    const { message: reply } = await owner.sendMessage(channelId, {
      text: `for everyone, <@${member.id}>`,
      nonce: "for-everyone",
      threadRootId: root.id,
      alsoSendToChannel: true,
    });
    await expect
      .poll(() => client.state.threads[root.id]?.some((m) => m.id === reply.id))
      .toBe(true);
    client.markRead(channelId, reply.seq, { explicit: true });
    await expect.poll(lastRead).toBe(reply.seq);
    await expect.poll(() => client.state.mentionCounts[channelId] ?? 0).toBe(0);
    expect(isMessageRead(reply, client.state)).toBe(true);

    // The same account on a second device.
    const other = new WorkspaceClient(client.baseUrl, member.token);
    other.connect();
    try {
      await expect.poll(() => other.state.status).toBe("online");
      client.markThreadUnread(root.id, reply.seq);
      // At once here, as the server will have it.
      expect(isMessageRead(reply, client.state)).toBe(false);
      await expect.poll(() => client.state.mentionCounts[channelId]).toBe(1);
      expect(client.state.threadFollows[root.id]?.unreadHold).toBe(reply.seq);
      // The other device hears it, and agrees.
      await expect.poll(() => other.state.threadFollows[root.id]?.unreadHold).toBe(reply.seq);
      expect(isMessageRead(reply, other.state)).toBe(false);
    } finally {
      other.destroy();
    }

    // A device connecting afresh is told of the hold in its snapshot.
    const fresh = new WorkspaceClient(client.baseUrl, member.token);
    fresh.connect();
    try {
      await expect.poll(() => fresh.state.status).toBe("online");
      expect(fresh.state.threadFollows[root.id]?.unreadHold).toBe(reply.seq);
      expect(isMessageRead(reply, fresh.state)).toBe(false);
    } finally {
      fresh.destroy();
    }

    // Reading the thread reads it everywhere.
    client.focusThread(root.id);
    client.markThreadRead(root.id, { explicit: true });
    expect(isMessageRead(reply, client.state)).toBe(true);
    await expect.poll(() => client.state.mentionCounts[channelId] ?? 0).toBe(0);
  });

  it("leaves a reply unread when the channel is read past it, until its thread is read", async () => {
    const root = await incoming("A thread");
    await client.loadThread(root.id, channelId, "latest");
    const reply = await incoming(`over to you <@${member.id}>`, root.id);
    const later = await incoming("Later");
    client.markRead(channelId, later.seq);
    await expect.poll(lastRead).toBe(later.seq);
    expect(client.state.repliesRead?.[channelId]).toBeLessThan(root.seq);
    expect(isMessageRead(reply, client.state)).toBe(false);
    await expect.poll(() => client.state.mentionCounts[channelId]).toBe(1);

    client.focusThread(root.id);
    client.markThreadRead(root.id);
    expect(isMessageRead(reply, client.state)).toBe(true);
    await expect.poll(() => client.state.mentionCounts[channelId] ?? 0).toBe(0);
  });

  it("hears that reading the channel read a reply also sent there, in its thread too", async () => {
    const { message: root } = await client.api.sendMessage(channelId, {
      text: "My question",
      nonce: "mine",
    });
    await client.loadThread(root.id, channelId, "latest");
    const { message: copied } = await owner.sendMessage(channelId, {
      text: "answered for everyone",
      nonce: "copied",
      threadRootId: root.id,
      alsoSendToChannel: true,
    });
    await expect.poll(() => unreadThreadCount(client.state.threadFollows)).toBe(1);
    client.markRead(channelId, copied.seq);
    await expect.poll(() => client.state.threadFollows[root.id]?.lastReadSeq).toBe(copied.seq);
    expect(unreadThreadCount(client.state.threadFollows)).toBe(0);
    expect(isMessageRead(copied, client.state)).toBe(true);
  });

  it("does not count replies written before joining a channel as this account's to read", async () => {
    const { channel } = await owner.createChannel({ type: "public", name: "earlier" });
    // A public channel takes everyone in when it is made; this account leaves
    // it, to join after the replies are written.
    await client.api.leaveChannel(channel.id);
    const { message: root } = await owner.sendMessage(channel.id, { text: "Old", nonce: "old" });
    const { message: old } = await owner.sendMessage(channel.id, {
      text: "<!here> old reply",
      nonce: "old-reply",
      threadRootId: root.id,
    });
    await client.api.joinChannel(channel.id);
    await expect.poll(() => client.state.repliesRead?.[channel.id]).toBeGreaterThanOrEqual(old.seq);
    expect(isMessageRead(old, client.state)).toBe(true);

    const { message: fresh } = await owner.sendMessage(channel.id, {
      text: "<!here> new reply",
      nonce: "new-reply",
      threadRootId: root.id,
    });
    await expect.poll(() => client.state.mentionCounts[channel.id]).toBe(1);
    expect(isMessageRead(fresh, client.state)).toBe(false);
    // A fresh connection is told the same floor by the server.
    const again = new WorkspaceClient(`http://127.0.0.1:${server.port}`, member.token);
    try {
      again.connect();
      await expect.poll(() => again.state.status).toBe("online");
      expect(isMessageRead(old, again.state)).toBe(true);
      expect(isMessageRead(fresh, again.state)).toBe(false);
    } finally {
      again.destroy();
    }
  });
});
