import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { SEND_RETRY_WINDOW_MS } from "@ownbase/protocol";
import { Api, ApiError, OUTBOX_LIMIT, WorkspaceClient } from "../src/index.js";

let server: WorkspaceServer;
let client: WorkspaceClient;
let owner: Api;
let channelId: string;
let memberId: string;

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
  memberId = b.user.id;
  owner = new Api(base, a.token);
  client = new WorkspaceClient(base, b.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find((c) => c.name === "general")!.id;
  await client.loadTimeline(channelId);
});

afterEach(async () => {
  client?.destroy();
  await server?.stop();
  vi.restoreAllMocks();
});

async function disconnect() {
  // Hold automatic reconnect while the test changes the real server.
  const connection = client as unknown as { ws: WebSocket; reconnectDelay: number };
  connection.reconnectDelay = 60_000;
  connection.ws.close();
  await expect.poll(() => client.state.status).toBe("reconnecting");
}

describe("connection recovery", () => {
  it("sends from plain HTTP origins without the secure-context randomUUID API", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    });
    try {
      client.send(channelId, "LAN browser send");
      await expect
        .poll(() =>
          client.state.timelines[channelId]?.items.some((m) => m.text === "LAN browser send"),
        )
        .toBe(true);
      expect(client.state.pending).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("replays changes into already-loaded history without rolling back snapshot metadata", async () => {
    const edited = (await owner.sendMessage(channelId, { text: "before edit" })).message;
    const deleted = (await owner.sendMessage(channelId, { text: "before delete" })).message;
    await expect.poll(() => client.state.timelines[channelId]?.items.length).toBe(2);
    await client.loadThread(edited.id, channelId);
    await disconnect();
    await owner.editMessage(edited.id, "after edit");
    await owner.deleteMessage(deleted.id);
    await owner.addReaction(edited.id, "yes");
    await owner.pinMessage(edited.id);
    const reply = (
      await owner.sendMessage(channelId, { text: "offline reply", threadRootId: edited.id })
    ).message;
    const missed = (await owner.sendMessage(channelId, { text: "offline message" })).message;
    await owner.updateChannel(channelId, { topic: "intermediate" });
    await owner.updateChannel(channelId, { topic: "latest" });
    client.connect();
    await expect
      .poll(() => client.state.timelines[channelId]?.items.some((m) => m.id === missed.id))
      .toBe(true);
    const items = client.state.timelines[channelId]!.items;
    expect(items.some((m) => m.id === deleted.id)).toBe(false);
    expect(items.find((m) => m.id === edited.id)).toMatchObject({
      text: "after edit",
      pinned: true,
      replyCount: 1,
      reactions: [{ emoji: "yes" }],
    });
    expect(client.state.threads[edited.id]?.map((m) => m.id)).toEqual([reply.id]);
    expect(client.state.channels[channelId]?.topic).toBe("latest");
    expect(client.state.lastSeq).toBe(server.store.currentSeq());
  });

  it("reloads history after replay expiry, keeping drafts and sending what was lost", async () => {
    client.setDraft(channelId, "Keep my draft");
    vi.spyOn(client.api, "sendMessage").mockRejectedValueOnce(new Error("offline"));
    client.send(channelId, "Keep my pending message");
    await expect.poll(() => client.state.pending[0]?.failed).toBe(true);
    const nonce = client.state.pending[0]!.nonce;
    await disconnect();
    await owner.sendMessage(channelId, { text: "pruned event" });
    const newest = (await owner.sendMessage(channelId, { text: "after pruning" })).message;
    server.store.pruneEvents(1);
    client.connect();
    await expect
      .poll(() => client.state.timelines[channelId]?.items.some((m) => m.id === newest.id))
      .toBe(true);
    expect(client.state.drafts[channelId]).toBe("Keep my draft");
    // Lost on the way, not refused: it goes again once the workspace is back.
    await expect.poll(() => client.state.pending.length).toBe(0);
    const sent = (await owner.listMessages(channelId)).messages.filter(
      (m) => m.text === "Keep my pending message",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.nonce).toBe(nonce);
  });

  it("settles HTTP success even when the socket is disconnected", async () => {
    await disconnect();
    client.send(channelId, "HTTP acknowledgement");
    await expect.poll(() => client.state.pending.length).toBe(0);
    expect(
      client.state.timelines[channelId]?.items.filter((m) => m.text === "HTTP acknowledgement"),
    ).toHaveLength(1);
    client.connect();
    await expect.poll(() => client.state.status).toBe("online");
    expect(
      client.state.timelines[channelId]?.items.filter((m) => m.text === "HTTP acknowledgement"),
    ).toHaveLength(1);
  });

  it("retries a lost acknowledgement with the same nonce and only one persisted message", async () => {
    await disconnect();
    const send = client.api.sendMessage.bind(client.api);
    vi.spyOn(client.api, "sendMessage").mockImplementationOnce(async (...args) => {
      await send(...args);
      throw new Error("response lost");
    });
    client.send(channelId, "Only once");
    await expect.poll(() => client.state.pending[0]?.failed).toBe(true);
    const nonce = client.state.pending[0]!.nonce;
    client.retrySend(nonce);
    client.retrySend(nonce);
    await expect.poll(() => client.state.pending.length).toBe(0);
    const copies = (await owner.listMessages(channelId)).messages.filter(
      (m) => m.text === "Only once",
    );
    expect(copies).toHaveLength(1);
    expect(copies[0]?.nonce).toBe(nonce);
  });

  it("adds private invitation metadata live and removes cached content on departure", async () => {
    const { channel } = await owner.createChannel({ type: "private", name: "private-room" });
    await owner.inviteMember(channel.id, memberId);
    await expect.poll(() => client.state.channels[channel.id]?.name).toBe("private-room");
    const root = (await owner.sendMessage(channel.id, { text: "Private history" })).message;
    await client.loadTimeline(channel.id);
    await client.loadThread(root.id, channel.id);
    await client.api.leaveChannel(channel.id);
    await expect.poll(() => client.state.channels[channel.id]).toBeUndefined();
    expect(client.state.memberships[channel.id]).toBeUndefined();
    expect(client.state.timelines[channel.id]).toBeUndefined();
    expect(client.state.threads[root.id]).toBeUndefined();
  });

  it("drops a revoked private channel even when its access notice could not be read (F06)", async () => {
    const { channel } = await owner.createChannel({ type: "private", name: "private-room" });
    await owner.inviteMember(channel.id, memberId);
    await expect.poll(() => client.state.channels[channel.id]?.name).toBe("private-room");
    await owner.sendMessage(channel.id, { text: "Private history" });
    await client.loadTimeline(channel.id);
    expect(client.state.timelines[channel.id]?.items).toHaveLength(1);
    const elsewhere = new WorkspaceClient(
      owner.baseUrl,
      (owner as unknown as { token: string }).token,
    );
    elsewhere.connect();
    await expect.poll(() => elsewhere.state.status).toBe("online");

    // The removal commits; the read behind the notice that tells the member fails.
    const memberships = server.store.memberships.bind(server.store);
    const failed = vi.spyOn(server.store, "memberships").mockImplementation((userId) => {
      if (userId === memberId) throw new Error("disk");
      return memberships(userId);
    });
    await owner.removeChannelMember(channel.id, memberId);
    await expect.poll(() => failed.mock.calls.length).toBeGreaterThan(0);
    failed.mockRestore();

    // The member's devices reconnect, which takes the client's first retry delay.
    await expect.poll(() => client.state.channels[channel.id], { timeout: 5_000 }).toBeUndefined();
    expect(client.state.memberships[channel.id]).toBeUndefined();
    expect(client.state.timelines[channel.id]).toBeUndefined();
    await expect.poll(() => client.state.status).toBe("online");
    // Nobody else was disturbed, and the owner still sees the channel.
    expect(elsewhere.state.channels[channel.id]?.name).toBe("private-room");
    expect(elsewhere.state.status).toBe("online");
    elsewhere.destroy();
  });
});

describe("outbox durability", () => {
  /** Stands in for a restart: a second client for the same account, fresh state. */
  async function restart(): Promise<WorkspaceClient> {
    const snapshot = client.outboxSnapshot();
    const base = client.baseUrl;
    const token = (client as unknown as { token: string }).token;
    client.destroy();
    client = new WorkspaceClient(base, token);
    client.connect();
    await expect.poll(() => client.state.status).toBe("online");
    client.restoreOutbox(snapshot);
    return client;
  }

  it("sends work the author committed to before a restart, exactly once", async () => {
    vi.spyOn(client.api, "sendMessage").mockRejectedValueOnce(new Error("network is down"));
    client.send(channelId, "survives a restart");
    await expect.poll(() => client.state.pending[0]?.failed).toBe(true);
    const nonce = client.state.pending[0]!.nonce;

    await restart();
    await expect.poll(() => client.state.pending).toHaveLength(0);
    const { messages } = await owner.listMessages(channelId, { limit: 50 });
    expect(messages.filter((m) => m.text === "survives a restart")).toHaveLength(1);
    expect(messages.find((m) => m.text === "survives a restart")!.nonce).toBe(nonce);
  });

  it("does not turn a send the server already accepted into a second message", async () => {
    // With the socket down the client cannot learn from the broadcast either,
    // so the restart is its only route back to the truth.
    await disconnect();
    vi.spyOn(client.api, "sendMessage").mockImplementationOnce(async (channel, body) => {
      await new Api(client.baseUrl, (client as unknown as { token: string }).token).sendMessage(
        channel,
        body,
      );
      throw new Error("the acknowledgement was lost");
    });
    client.send(channelId, "acknowledged but unheard");
    await expect.poll(() => client.state.pending[0]?.failed).toBe(true);

    await restart();
    await expect.poll(() => client.state.pending).toHaveLength(0);
    const { messages } = await owner.listMessages(channelId, { limit: 50 });
    expect(messages.filter((m) => m.text === "acknowledged but unheard")).toHaveLength(1);
  });

  it("stops rather than posting words without the files that belonged to them", async () => {
    vi.spyOn(client.api, "uploadFile").mockRejectedValueOnce(new Error("upload interrupted"));
    client.send(channelId, "see the attached", {
      files: [new File(["contents"], "report.txt", { type: "text/plain" })],
    });
    await expect.poll(() => client.state.pending[0]?.failed).toBe(true);

    await restart();
    const restored = client.state.pending[0]!;
    expect(restored.failed).toBe(true);
    expect(restored.failureReason).toMatch(/attach them again/i);
    expect(restored.attachments.map((a) => a.name)).toEqual(["report.txt"]);
    const { messages } = await owner.listMessages(channelId, { limit: 50 });
    expect(messages.some((m) => m.text === "see the attached")).toBe(false);

    // Retrying without re-attaching keeps saying so instead of half-sending.
    client.retrySend(restored.nonce);
    await expect.poll(() => client.state.pending[0]?.failed).toBe(true);
    expect((await owner.listMessages(channelId, { limit: 50 })).messages).toHaveLength(0);
  });

  it("keeps every send it took, and refuses the one past the limit before taking it", async () => {
    await disconnect();
    vi.spyOn(client.api, "sendMessage").mockRejectedValue(new Error("network is down"));
    for (let i = 1; i <= OUTBOX_LIMIT; i++)
      expect(client.send(channelId, `queued ${i}`)).toBe(true);
    await expect.poll(() => client.state.pending.every((p) => p.failed)).toBe(true);

    // The composer keeps this one: nothing was taken, so nothing can be lost.
    expect(client.outboxFull()).toBe(true);
    expect(client.send(channelId, "one too many")).toBe(false);
    expect(client.state.pending).toHaveLength(OUTBOX_LIMIT);
    expect(client.outboxSnapshot().map((e) => e.text)).toEqual(
      Array.from({ length: OUTBOX_LIMIT }, (_, i) => `queued ${i + 1}`),
    );

    await restart();
    await expect.poll(() => client.state.pending).toHaveLength(0);
    const { messages } = await owner.listMessages(channelId, { limit: 100 });
    expect(messages.filter((m) => m.text.startsWith("queued "))).toHaveLength(OUTBOX_LIMIT);
    expect(messages.some((m) => m.text === "one too many")).toBe(false);
  });

  it("leaves a send older than the retry window for its author, and sends it when they retry", async () => {
    const self = client.state.self!.id;
    const now = Date.now();
    const entry = (nonce: string, text: string, age: number) => ({
      nonce,
      channelId,
      threadRootId: null,
      text,
      userId: self,
      createdAt: now - age,
      attachments: [],
    });
    const send = vi.spyOn(client.api, "sendMessage");
    client.restoreOutbox([
      entry("stale-1", "written long ago", SEND_RETRY_WINDOW_MS + 60_000),
      entry("fresh-1", "written just inside the window", SEND_RETRY_WINDOW_MS - 60_000),
    ]);
    // The one inside the window goes on its own, as any restored send does.
    await expect.poll(() => client.state.pending.map((p) => p.nonce)).toEqual(["stale-1"]);
    expect(send.mock.calls.map(([, body]) => body.nonce)).toEqual(["fresh-1"]);
    // The other waits, and says why.
    const stale = client.state.pending[0]!;
    expect(stale).toMatchObject({ failed: true, refused: false });
    expect(stale.failureReason).toMatch(/more than 30 days ago.*Retry to send it anyway/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    let { messages } = await owner.listMessages(channelId, { limit: 50 });
    expect(messages.some((m) => m.text === "written long ago")).toBe(false);

    // The author's own Retry sends it.
    client.retrySend("stale-1");
    await expect.poll(() => client.state.pending).toHaveLength(0);
    ({ messages } = await owner.listMessages(channelId, { limit: 50 }));
    expect(messages.filter((m) => m.text === "written long ago")).toHaveLength(1);
  });

  it("says a send was already posted when retention has removed it since", async () => {
    // Posted, its answer lost, then removed with older history before the
    // app came back to it: still inside the window, so the app tries again.
    const self = client.state.self!.id;
    const posted = await client.api.sendMessage(channelId, {
      text: "removed with age",
      nonce: "aged-1",
    });
    server.store.transaction(() => server.store.purgeMessagesBefore(Date.now() + 1));
    expect(server.store.getMessage(posted.message.id)).toBeNull();

    client.restoreOutbox([
      {
        nonce: "aged-1",
        channelId,
        threadRootId: null,
        text: "removed with age",
        userId: self,
        createdAt: posted.message.createdAt,
        attachments: [],
      },
    ]);
    await expect
      .poll(() => client.state.pending[0]?.failureReason)
      .toBe("This was already sent once. Discard it to clear it.");
    expect(client.state.pending[0]!.refused).toBe(true);
    const { messages } = await owner.listMessages(channelId, { limit: 50 });
    expect(messages.some((m) => m.text === "removed with age")).toBe(false);
  });

  it("drops nothing it restores, however much was waiting", async () => {
    await disconnect();
    const self = client.state.self!.id;
    const waiting = Array.from({ length: OUTBOX_LIMIT + 10 }, (_, i) => ({
      nonce: `kept-${i}`,
      channelId,
      threadRootId: null,
      text: `kept ${i}`,
      userId: self,
      createdAt: i,
      attachments: [],
      refusal: "This conversation is archived.",
    }));
    client.restoreOutbox(waiting);
    expect(client.state.pending).toHaveLength(OUTBOX_LIMIT + 10);
    expect(client.outboxSnapshot().map((e) => e.nonce)).toEqual(waiting.map((e) => e.nonce));
  });

  it("keeps a send the server refused refused across a restart, until the author retries", async () => {
    const { channel } = await owner.createChannel({ type: "public", name: "plans" });
    await client.api.joinChannel(channel.id);
    await expect.poll(() => client.state.channels[channel.id]?.id).toBe(channel.id);
    await owner.updateChannel(channel.id, { archived: true });
    client.send(channel.id, "sent while archived");
    await expect
      .poll(() => client.state.pending[0]?.failureReason)
      .toBe("This conversation is archived.");
    // Reopened before the restart: sending now would be the app's choice, not theirs.
    await owner.updateChannel(channel.id, { archived: false });

    await restart();
    const restored = client.state.pending[0]!;
    expect(restored).toMatchObject({
      failed: true,
      failureReason: "This conversation is archived.",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await owner.listMessages(channel.id, { limit: 50 })).messages).toHaveLength(0);

    client.retrySend(restored.nonce);
    await expect.poll(() => client.state.pending).toHaveLength(0);
    const { messages } = await owner.listMessages(channel.id, { limit: 50 });
    expect(messages.map((m) => m.text)).toEqual(["sent while archived"]);
  });

  it("keeps a reply to a deleted message refused across a restart", async () => {
    const { message: root } = await owner.sendMessage(channelId, { text: "Root", nonce: "root" });
    await owner.deleteMessage(root.id);
    client.send(channelId, "an answer", { threadRootId: root.id });
    await expect.poll(() => client.state.pending[0]?.failed).toBe(true);

    await restart();
    expect(client.state.pending[0]).toMatchObject({
      failed: true,
      failureReason: "The message this replies to is gone.",
    });
  });

  it("still sends again after a restart when the server only failed to answer", async () => {
    vi.spyOn(client.api, "sendMessage").mockRejectedValueOnce(
      new ApiError(503, "unavailable", "The workspace is busy"),
    );
    client.send(channelId, "outcome unknown");
    await expect.poll(() => client.state.pending[0]?.failed).toBe(true);
    expect(client.outboxSnapshot()[0]!.refusal).toBeUndefined();

    await restart();
    await expect.poll(() => client.state.pending).toHaveLength(0);
    const { messages } = await owner.listMessages(channelId, { limit: 50 });
    expect(messages.filter((m) => m.text === "outcome unknown")).toHaveLength(1);
  });

  it("keeps one account's unsent work out of another's", async () => {
    await disconnect();
    client.send(channelId, "mine");
    const mine = client.outboxSnapshot().map((e) => ({ ...e, userId: "someone-else" }));
    expect(mine).toHaveLength(1);
    const fresh = new WorkspaceClient(
      client.baseUrl,
      (client as unknown as { token: string }).token,
    );
    fresh.connect();
    await expect.poll(() => fresh.state.status).toBe("online");
    fresh.restoreOutbox(mine);
    expect(fresh.state.pending).toHaveLength(0);
    fresh.destroy();
  });
});

describe("reconnecting more than once", () => {
  it("survives a run of reconnections without losing or duplicating anything", async () => {
    const sent: string[] = [];
    for (let round = 0; round < 4; round++) {
      await disconnect();
      const text = `round ${round}`;
      await owner.sendMessage(channelId, { text });
      sent.push(text);
      client.connect();
      await expect.poll(() => client.state.status).toBe("online");
      await expect
        .poll(() => client.state.timelines[channelId]?.items.some((m) => m.text === text))
        .toBe(true);
    }
    const texts = client.state.timelines[channelId]!.items.map((m) => m.text);
    // Each message once, in the order it was sent: a replay that overlapped
    // what was already applied would show one of them twice.
    expect(texts.filter((t) => t.startsWith("round "))).toEqual(sent);
    expect(client.state.lastSeq).toBe(server.store.currentSeq());
  });
});

describe("sequence numbers with gaps in them", () => {
  it("replays across events it is not allowed to see", async () => {
    // A private room the member is not in. Its events take sequence numbers
    // that will never be delivered here, so what arrives is not consecutive —
    // and nothing may assume it is.
    const secret = (await owner.createChannel({ type: "private", name: "secret" })).channel;
    await disconnect();
    await owner.sendMessage(secret.id, { text: "not for you" });
    await owner.sendMessage(secret.id, { text: "nor this" });
    const visible = (await owner.sendMessage(channelId, { text: "after the gap" })).message;
    await owner.sendMessage(secret.id, { text: "nor this either" });

    client.connect();
    await expect
      .poll(() => client.state.timelines[channelId]?.items.some((m) => m.id === visible.id))
      .toBe(true);
    const items = client.state.timelines[channelId]!.items;
    expect(items.some((m) => m.text.includes("not for you"))).toBe(false);
    expect(client.state.channels[secret.id]).toBeUndefined();
    // Caught up to where the server is, not to the last thing it was shown;
    // otherwise every reconnection would replay the same invisible gap again.
    expect(client.state.lastSeq).toBe(server.store.currentSeq());

    // And a second reconnection has nothing left to do.
    await disconnect();
    client.connect();
    await expect.poll(() => client.state.status).toBe("online");
    expect(
      client.state.timelines[channelId]!.items.filter((m) => m.id === visible.id),
    ).toHaveLength(1);
  });
});

describe("a server that has gone backwards", () => {
  it("starts again rather than waiting for sequence numbers that will not come", async () => {
    await owner.sendMessage(channelId, { text: "before the rollback" });
    await expect.poll(() => client.state.timelines[channelId]?.items.length).toBe(1);
    await disconnect();

    // What a restore from backup looks like from here: the client is holding a
    // cursor past anything the server still has.
    (client as unknown as { store: { setState: (p: object) => void } }).store.setState({
      lastSeq: server.store.currentSeq() + 5000,
    });
    const after = (await owner.sendMessage(channelId, { text: "after the rollback" })).message;

    client.connect();
    await expect.poll(() => client.state.status).toBe("online");
    await expect
      .poll(() => client.state.timelines[channelId]?.items.some((m) => m.id === after.id))
      .toBe(true);
    // Asking to resume from a cursor the server cannot honour has to mean
    // reloading, not sitting quietly waiting for events that will never arrive.
    expect(client.state.lastSeq).toBe(server.store.currentSeq());
  });
});

describe("a refusal that will not stop on its own", () => {
  it("gives up and says why when the account must replace its password", async () => {
    const self = client.state.self!;
    await disconnect();
    server.store.setPassword(
      self.id,
      server.store.getUserAuthByHandle(self.handle)!.passwordHash,
      server.store.getUserAuthByHandle(self.handle)!.salt,
      true,
    );

    client.connect();
    await expect.poll(() => client.state.status).toBe("password_change_required");
    // Retrying cannot help, so it must not keep trying: a loop that never ends
    // and never says why is worse than stopping.
    const before = client.state.status;
    await new Promise((r) => setTimeout(r, 250));
    expect(client.state.status).toBe(before);
  });
});
