import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import type { Message } from "@slackoss/protocol";
import {
  Api,
  WorkspaceClient,
  forwardOf,
  forwardSource,
  readStoredOutbox,
  storedPending,
  type WorkspaceState,
} from "../src/index.js";
import { quoteChanges, requote } from "../src/replies.js";

/**
 * Forwarding on the client (E1): a send carries the message it passes on and
 * shows it while sending, and a forward already held follows its original
 * when that is edited or deleted, though the original lives in another
 * conversation.
 */
let server: WorkspaceServer;
let base: string;
let dataDir: string;
let aliceToken: string;
let bobToken: string;

function until(
  client: WorkspaceClient,
  predicate: (s: WorkspaceState) => boolean,
  label = "condition",
): Promise<WorkspaceState> {
  return new Promise((resolve, reject) => {
    if (predicate(client.state)) return resolve(client.state);
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${label}`));
    }, 5000);
    const unsubscribe = client.store.subscribe((s) => {
      if (predicate(s)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(s);
      }
    });
  });
}

/** Alice, online, with #general loaded and a public #news of Bob's that she can read. */
async function online() {
  const bob = new Api(base, bobToken);
  const { channel: news } = await bob.createChannel({
    type: "public",
    name: `news-${Math.random().toString(36).slice(2, 8)}`,
  });
  const client = new WorkspaceClient(base, aliceToken);
  onTestFinished(() => client.destroy());
  client.connect();
  await until(client, (s) => s.status === "online", "connection");
  const general = Object.values(client.state.channels).find((c) => c.name === "general")!;
  await client.loadTimeline(general.id);
  return { client, general, news, bob };
}

const held = (client: WorkspaceClient, channelId: string, id: string) =>
  client.state.timelines[channelId]?.items.find((m) => m.id === id);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "slackoss-forward-"));
  server = await createWorkspaceServer({ dataDir, port: 0, mdns: false, rateLimits: false });
  base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base);
  aliceToken = (
    await api.register({ handle: "alice", displayName: "Alice", password: "password123" })
  ).token;
  bobToken = (await api.register({ handle: "bob", displayName: "Bob", password: "password123" }))
    .token;
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("forwarding on the client", () => {
  it("sends a forward with its comment, shows the card while sending, and learns the server forwards", async () => {
    const { client, general, news, bob } = await online();
    expect(client.state.forwards).toBe(true);
    const { message: original } = await bob.sendMessage(news.id, { text: "We ship Friday" });

    client.send(general.id, "FYI", { forward: forwardOf(original, general.id, true) });
    expect(client.state.pending[0]!.forward).toMatchObject({
      id: original.id,
      text: "We ship Friday",
      hidden: false,
    });
    const sent = await until(
      client,
      (s) =>
        s.pending.length === 0 && !!s.timelines[general.id]?.items.some((m) => m.text === "FYI"),
      "delivery",
    );
    const forward = sent.timelines[general.id]!.items.find((m) => m.text === "FYI")!;
    expect(forward.forwardedFrom).toMatchObject({
      id: original.id,
      channelId: news.id,
      text: "We ship Friday",
    });

    // With nothing to say of its own, it still goes.
    expect(client.send(general.id, "", { forward: forwardOf(original, general.id, true) })).toBe(
      true,
    );
    await until(client, (s) => s.pending.length === 0, "the bare forward");
  });

  it("sends the comment alone to a server that does not forward, and nothing without one", async () => {
    const { client, general, news, bob } = await online();
    const { message: original } = await bob.sendMessage(news.id, { text: "Old server?" });
    client.store.setState({ forwards: false });
    expect(client.send(general.id, "", { forward: forwardOf(original, general.id, true) })).toBe(
      false,
    );
    client.send(general.id, "Have a look", { forward: forwardOf(original, general.id, true) });
    expect(client.state.pending[0]!).not.toHaveProperty("forward");
    await until(client, (s) => s.pending.length === 0, "delivery");
  });

  it("keeps a held card current when its original, in another conversation, changes", async () => {
    const { client, general, news, bob } = await online();
    const { message: original } = await bob.sendMessage(news.id, { text: "Meeting at 3" });
    const { message: forward } = await client.api.sendMessage(general.id, {
      text: "",
      forwardFrom: original.id,
    });
    await until(client, () => !!held(client, general.id, forward.id), "the forward");

    await bob.editMessage(original.id, "Meeting at 4");
    await until(
      client,
      () => held(client, general.id, forward.id)?.forwardedFrom?.text === "Meeting at 4",
      "the edit",
    );
    await bob.deleteMessage(original.id);
    const after = await until(
      client,
      () => held(client, general.id, forward.id)?.forwardedFrom?.deleted === true,
      "the deletion",
    );
    expect(
      after.timelines[general.id]!.items.find((m) => m.id === forward.id)!.forwardedFrom,
    ).toEqual({
      id: original.id,
      channelId: news.id,
      userId: "",
      text: "",
      files: [],
      createdAt: 0,
      deleted: true,
      hidden: false,
    });
  });

  it("says why a forward was refused once what it passes on is gone", async () => {
    const { client, general, news, bob } = await online();
    const { message: original } = await bob.sendMessage(news.id, { text: "Soon gone" });
    const { message: forward } = await client.api.sendMessage(general.id, {
      text: "",
      forwardFrom: original.id,
    });
    await bob.deleteMessage(original.id);

    // Chosen before the deletion reached this window: the original itself,
    // and the forward of it, which now has nothing to pass on.
    client.send(general.id, "", { forward: forwardOf(original, general.id, true) });
    client.send(general.id, "", { forward: forwardOf(forward, general.id, true) });
    const failed = await until(
      client,
      (s) => s.pending.length === 2 && s.pending.every((p) => p.failed),
      "both refusals",
    );
    expect(failed.pending.map((p) => [p.refused, p.failureReason])).toEqual([
      [true, "The message this forwards is no longer there."],
      [true, "What this forwards is private or deleted, so it cannot be passed on."],
    ]);
  });
});

describe("a forward's card", () => {
  const message = (over: Partial<Message> = {}): Message => ({
    id: "O1",
    channelId: "C_SECRET",
    userId: "U_BOB",
    text: "The plan",
    threadRootId: null,
    broadcast: false,
    seq: 1,
    createdAt: 5,
    editedAt: null,
    nonce: null,
    replyCount: 0,
    reactions: [],
    files: [],
    pinned: false,
    actions: [],
    ...over,
  });

  it("shows a private original only in its own conversation", () => {
    expect(forwardOf(message(), "C_GENERAL", false)).toEqual({
      id: "O1",
      channelId: "C_SECRET",
      userId: "",
      text: "",
      files: [],
      createdAt: 0,
      deleted: false,
      hidden: true,
    });
    expect(forwardOf(message(), "C_SECRET", false)).toMatchObject({
      text: "The plan",
      hidden: false,
    });
    expect(forwardOf(message(), "C_GENERAL", true)).toMatchObject({
      text: "The plan",
      hidden: false,
    });
  });

  it("follows an edit and a deletion, and a hidden one shows nothing either way", () => {
    const shown = message({ id: "F1", forwardedFrom: forwardOf(message(), "C_SECRET", false) });
    const hidden = message({ id: "F2", forwardedFrom: forwardOf(message(), "C_GENERAL", false) });
    const edited = requote(
      [shown, hidden],
      quoteChanges({ type: "message.updated", message: message({ text: "The new plan" }) })!,
    );
    expect(edited[0]!.forwardedFrom!.text).toBe("The new plan");
    expect(edited[1]).toBe(hidden);
    const deleted = requote(
      [shown, hidden],
      quoteChanges({
        type: "message.deleted",
        messageId: "O1",
        channelId: "C_SECRET",
        threadRootId: null,
      })!,
    );
    expect(deleted[0]!.forwardedFrom).toMatchObject({ deleted: true, text: "" });
    expect(deleted[1]!.forwardedFrom).toMatchObject({ deleted: true, hidden: true, text: "" });
    // A list with no forward of what changed comes back as it was.
    const list = [message({ id: "X1" })];
    expect(
      requote(
        list,
        quoteChanges({
          type: "message.deleted",
          messageId: "O1",
          channelId: "C_SECRET",
          threadRootId: null,
        })!,
      ),
    ).toBe(list);
  });

  it("passes on the original of a forward with nothing of its own, and nothing hidden or deleted", () => {
    const original = message();
    expect(forwardSource(original)).toBe(original);
    const commented = message({
      id: "F1",
      channelId: "C_GENERAL",
      text: "Look",
      forwardedFrom: forwardOf(original, "C_GENERAL", true),
    });
    expect(forwardSource(commented)).toBe(commented);
    const withFile = message({
      ...commented,
      text: "",
      files: [
        { id: "FILE1", name: "a.png", mime: "image/png", size: 1, width: null, height: null },
      ],
    });
    expect(forwardSource(withFile)).toBe(withFile);

    // Shown where it was forwarded, so passed on from there as the original.
    const bare = message({
      id: "F2",
      text: " ",
      forwardedFrom: forwardOf(original, "C_SECRET", false),
    });
    const source = forwardSource(bare)!;
    expect(source).toEqual({
      id: "O1",
      channelId: "C_SECRET",
      userId: "U_BOB",
      text: "The plan",
      files: [],
      createdAt: 5,
    });
    // It stays as private as the original: shown only back in its own conversation.
    expect(forwardOf(source, "C_GENERAL", false).hidden).toBe(true);
    expect(forwardOf(source, "C_SECRET", false).hidden).toBe(false);

    const hidden = message({
      id: "F3",
      text: "",
      forwardedFrom: forwardOf(original, "C_GENERAL", false),
    });
    expect(forwardSource(hidden)).toBeNull();
    const deleted = message({
      id: "F4",
      text: "",
      forwardedFrom: { ...forwardOf(original, "C_SECRET", false), deleted: true },
    });
    expect(forwardSource(deleted)).toBeNull();
  });

  it("keeps what a waiting send forwards across a restart, and refuses a malformed one", () => {
    const entry = {
      nonce: "n1",
      channelId: "C1",
      threadRootId: null,
      text: "",
      userId: "U1",
      createdAt: 1,
      attachments: [],
      forward: forwardOf(message(), "C_SECRET", false),
    };
    expect(storedPending(entry).forward).toEqual(entry.forward);
    expect(readStoredOutbox([entry])?.entries[0]?.forward).toEqual(entry.forward);
    expect(readStoredOutbox([{ ...entry, forward: { id: "O1" } }])).toBeNull();
  });
});
