import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import type { Message } from "@ownbase/protocol";
import {
  Api,
  WorkspaceClient,
  quoteOf,
  readStoredOutbox,
  storedPending,
  type WorkspaceState,
} from "../src/index.js";
import { quoteChanges, requote } from "../src/replies.js";

/**
 * Inline replies on the client: a send carries what it answers, and replies
 * already held follow the original when it is edited or deleted, live or
 * caught up on after being away.
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

async function online(token: string) {
  const client = new WorkspaceClient(base, token);
  onTestFinished(() => client.destroy());
  client.connect();
  await until(client, (s) => s.status === "online", "connection");
  const general = Object.values(client.state.channels).find((c) => c.name === "general")!;
  await client.loadTimeline(general.id);
  return { client, general };
}

const held = (client: WorkspaceClient, channelId: string, id: string) =>
  client.state.timelines[channelId]?.items.find((m) => m.id === id);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-replies-"));
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

describe("inline replies on the client", () => {
  it("sends what a message answers, shows it while sending, and learns the server keeps them", async () => {
    const { client, general } = await online(aliceToken);
    expect(client.state.inlineReplies).toBe(true);
    const { message: original } = await new Api(base, bobToken).sendMessage(general.id, {
      text: "Pizza or tacos?",
    });
    await until(client, () => !!held(client, general.id, original.id), "original");

    client.send(general.id, "Tacos", { replyTo: quoteOf(original, true) });
    expect(client.state.pending[0]!.replyTo).toMatchObject({ id: original.id, ping: true });
    const sent = await until(
      client,
      (s) =>
        s.pending.length === 0 && !!s.timelines[general.id]?.items.some((m) => m.text === "Tacos"),
      "delivery",
    );
    const reply = sent.timelines[general.id]!.items.find((m) => m.text === "Tacos")!;
    expect(reply.replyTo).toMatchObject({ id: original.id, text: "Pizza or tacos?", ping: true });
  });

  it("sends a plain message to a server that would not keep the answer", async () => {
    const { client, general } = await online(aliceToken);
    const { message: original } = await new Api(base, bobToken).sendMessage(general.id, {
      text: "Old server?",
    });
    client.store.setState({ inlineReplies: false });
    client.send(general.id, "Maybe", { replyTo: quoteOf(original, true) });
    expect(client.state.pending[0]!).not.toHaveProperty("replyTo");
    const sent = await until(client, (s) => s.pending.length === 0, "delivery");
    expect(sent.timelines[general.id]!.items.find((m) => m.text === "Maybe")).not.toHaveProperty(
      "replyTo",
    );
  });

  it("shows an edit or deletion of what replies answer, as it happens", async () => {
    const { client, general } = await online(aliceToken);
    const bob = new Api(base, bobToken);
    const { message: original } = await bob.sendMessage(general.id, { text: "Meeting at 3" });
    const { message: reply } = await client.api.sendMessage(general.id, {
      text: "See you",
      replyToId: original.id,
    });
    await until(client, () => !!held(client, general.id, reply.id), "reply");

    await bob.editMessage(original.id, "Meeting at 4");
    await until(
      client,
      () => held(client, general.id, reply.id)?.replyTo?.text === "Meeting at 4",
      "edit",
    );
    await bob.deleteMessage(original.id);
    const after = await until(
      client,
      () => held(client, general.id, reply.id)?.replyTo?.deleted === true,
      "deletion",
    );
    expect(after.timelines[general.id]!.items.find((m) => m.id === reply.id)!.replyTo).toEqual({
      id: original.id,
      userId: "",
      text: "",
      fileCount: 0,
      deleted: true,
      ping: true,
    });
  });

  it("catches up on an edit and a deletion made while it was away", async () => {
    const first = await online(aliceToken);
    const bob = new Api(base, bobToken);
    const general = first.general;
    const { message: edited } = await bob.sendMessage(general.id, { text: "Draft one" });
    const { message: deleted } = await bob.sendMessage(general.id, { text: "Oops" });
    const { message: toEdited } = await first.client.api.sendMessage(general.id, {
      text: "Re draft",
      replyToId: edited.id,
    });
    const { message: toDeleted } = await first.client.api.sendMessage(general.id, {
      text: "Re oops",
      replyToId: deleted.id,
    });
    await until(first.client, () => !!held(first.client, general.id, toDeleted.id), "replies");
    const seqBefore = first.client.state.lastSeq;
    const timeline = first.client.state.timelines[general.id]!;
    first.client.destroy();

    await bob.editMessage(edited.id, "Draft two");
    await bob.deleteMessage(deleted.id);

    // Back with what it held, resuming from where it left off.
    const again = new WorkspaceClient(base, aliceToken);
    onTestFinished(() => again.destroy());
    again.store.setState({
      lastSeq: seqBefore,
      channels: first.client.state.channels,
      timelines: { [general.id]: timeline },
    });
    again.connect();
    await until(
      again,
      () =>
        held(again, general.id, toEdited.id)?.replyTo?.text === "Draft two" &&
        held(again, general.id, toDeleted.id)?.replyTo?.deleted === true,
      "replay",
    );
  });
});

describe("keeping quotes current", () => {
  const message = (over: Partial<Message>): Message => ({
    id: "M1",
    channelId: "C1",
    userId: "U1",
    text: "",
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
    actions: [],
    ...over,
  });
  const original = message({ id: "O1", userId: "U2", text: "Before" });
  const reply = message({ id: "R1", text: "After", replyTo: quoteOf(original, false) });
  const plain = message({ id: "P1", text: "Unrelated" });

  it("leaves a list alone when nothing in it quotes what changed", () => {
    const items = [plain, reply];
    const other = new Map([["O2", null]]);
    expect(requote(items, other)).toBe(items);
    expect(
      requote(
        items,
        quoteChanges({ type: "pin.added", channelId: "C1", messageId: "O1", userId: "U1" }) ??
          new Map(),
      ),
    ).toBe(items);
  });

  it("takes an edit's words and a deletion, and keeps whether it notified", () => {
    const edited = requote(
      [plain, reply],
      quoteChanges({ type: "message.updated", message: { ...original, text: "Changed" } })!,
    );
    expect(edited[0]).toBe(plain);
    expect(edited[1]!.replyTo).toEqual({ ...quoteOf(original, false), text: "Changed" });
    const removed = requote(
      edited,
      quoteChanges({ type: "history.removed", channelId: "C1", rootIds: ["O1"] })!,
    );
    expect(removed[1]!.replyTo).toEqual({
      id: "O1",
      userId: "",
      text: "",
      fileCount: 0,
      deleted: true,
      ping: false,
    });
  });

  it("skips a reply read after the change it would apply", () => {
    const items = [reply];
    const changes = quoteChanges({
      type: "message.deleted",
      channelId: "C1",
      messageId: "O1",
      threadRootId: null,
    })!;
    expect(requote(items, changes, () => false)).toBe(items);
  });

  it("keeps what a waiting send answers across a restart, and refuses a malformed one", () => {
    const entry = {
      nonce: "n1",
      channelId: "C1",
      threadRootId: null,
      text: "Queued",
      userId: "U1",
      createdAt: 1,
      attachments: [],
      replyTo: quoteOf(original, true),
    };
    expect(storedPending(entry).replyTo).toEqual(quoteOf(original, true));
    expect(readStoredOutbox([entry])?.entries[0]?.replyTo).toEqual(quoteOf(original, true));
    expect(readStoredOutbox([{ ...entry, replyTo: { id: "O1" } }])).toBeNull();
  });
});
