import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import type { Message } from "@slackoss/protocol";
import {
  Api,
  WorkspaceClient,
  readStoredOutbox,
  shownPoll,
  storedPending,
  type WorkspaceState,
} from "../src/index.js";

/**
 * Polls on the client (E6): one goes through the outbox like any message; a
 * vote shows at once and then as the server has it, on every client; an
 * anonymous poll's own choices come from the server alone and are never
 * counted twice; a refused vote goes back; and an older server is offered none.
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

async function online(token = aliceToken) {
  const client = new WorkspaceClient(base, token);
  onTestFinished(() => client.destroy());
  client.connect();
  await until(client, (s) => s.status === "online", "connection");
  const general = Object.values(client.state.channels).find((c) => c.name === "general")!;
  await client.loadTimeline(general.id);
  return { client, general };
}

const held = (client: WorkspaceClient, channelId: string, id: string): Message | undefined =>
  client.state.timelines[channelId]?.items.find((m) => m.id === id);
/** The poll as this client shows it, with what its account has chosen. */
const shown = (client: WorkspaceClient, message: Message, s = client.state) =>
  shownPoll(
    s.timelines[message.channelId]!.items.find((m) => m.id === message.id)!,
    s.self?.id,
    s.pollChoices,
    s.pollPicks,
  )!;
const counts = (client: WorkspaceClient, message: Message, s = client.state) =>
  shown(client, message, s).poll.options.map((o) => o.votes);

let nonce = 0;
async function asked(
  channelId: string,
  question: string,
  options: string[],
  rules: { multiple?: boolean; anonymous?: boolean } = {},
  token = bobToken,
) {
  const api = new Api(base, token);
  return (
    await api.sendMessage(channelId, {
      text: question,
      nonce: `poll-${++nonce}`,
      poll: { options, ...rules },
    })
  ).message;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "slackoss-client-polls-"));
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

describe("polls on the client", () => {
  it("are sent through the outbox, with their choices and no votes", async () => {
    const { client, general } = await online();
    expect(client.state.pollChoices).toEqual({});
    const sent = client.send(general.id, "Where for lunch?", {
      poll: { options: ["Pizza", "Tacos"], multiple: false, anonymous: false },
    });
    expect(sent).toBe(true);
    expect(client.state.pending[0]!.poll).toEqual({
      options: ["Pizza", "Tacos"],
      multiple: false,
      anonymous: false,
    });
    // It survives a restart as it was.
    const [stored] = client.outboxSnapshot();
    expect(readStoredOutbox([storedPending(stored!)])!.entries[0]!.poll).toEqual(
      client.state.pending[0]!.poll,
    );
    await until(client, (s) => s.pending.length === 0, "the send");
    const message = client.state.timelines[general.id]!.items.at(-1)!;
    expect(message.text).toBe("Where for lunch?");
    expect(message.poll).toMatchObject({ voters: 0, closedAt: null, multiple: false });
    // A question that starts like a command is still a question.
    expect(
      client.send(general.id, "/shrug or /me?", {
        poll: { options: ["One", "Other"], multiple: false, anonymous: false },
      }),
    ).toBe(true);
    await until(client, (s) => s.pending.length === 0, "the second send");
    expect(client.state.timelines[general.id]!.items.at(-1)!.text).toBe("/shrug or /me?");
  });

  it("show a vote at once, then as the server has it, on every client and as no edit", async () => {
    const alice = await online();
    const bob = await online(bobToken);
    const message = await asked(alice.general.id, "Which day?", ["Mon", "Tue", "Wed"]);
    await until(alice.client, () => !!held(alice.client, message.channelId, message.id), "it");
    await until(bob.client, () => !!held(bob.client, message.channelId, message.id), "it");
    const changedBefore = bob.client.state.changedContent[message.channelId];
    const aliceId = alice.client.state.self!.id;

    const voted = alice.client.vote(held(alice.client, message.channelId, message.id)!, [1]);
    // Shown before the server answers.
    expect(shown(alice.client, message).mine).toEqual([1]);
    expect(counts(alice.client, message)).toEqual([0, 1, 0]);
    expect(shown(alice.client, message).poll.options[1]!.voterIds).toEqual([aliceId]);
    expect(await voted).toBe(true);

    // Then as the server has it, with nothing held here.
    await until(alice.client, (s) => !s.pollPicks[message.id], "the pick to settle");
    expect(held(alice.client, message.channelId, message.id)!.poll!.options[1]).toMatchObject({
      votes: 1,
      voterIds: [aliceId],
    });
    const seen = await until(
      bob.client,
      () => held(bob.client, message.channelId, message.id)!.poll!.voters === 1,
      "bob to see the vote",
    );
    expect(counts(bob.client, message)).toEqual([0, 1, 0]);
    expect(shown(bob.client, message).mine).toEqual([]);
    // A vote is not an edit: nothing new to load for Activity or the header.
    expect(seen.changedContent[message.channelId]).toBe(changedBefore);

    // Choices made quickly go in order, and the last one stands.
    const latest = held(alice.client, message.channelId, message.id)!;
    const first = alice.client.vote(latest, [0]);
    const second = alice.client.vote(latest, [2]);
    expect(shown(alice.client, message).mine).toEqual([2]);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    await until(alice.client, (s) => !s.pollPicks[message.id], "the last pick to settle");
    expect(counts(alice.client, message)).toEqual([0, 0, 1]);
    await until(bob.client, () => counts(bob.client, message)[2] === 1, "bob to see it moved");
    expect(counts(bob.client, message)).toEqual([0, 0, 1]);
  });

  it("keep an anonymous vote to its voter and never count it twice", async () => {
    const alice = await online();
    const message = await asked(alice.general.id, "Rate it", ["Good", "Bad"], { anonymous: true });
    await until(alice.client, () => !!held(alice.client, message.channelId, message.id), "it");
    const totals: number[] = [];
    const stop = alice.client.store.subscribe((s) => {
      if (s.timelines[message.channelId]?.items.some((m) => m.id === message.id))
        totals.push(counts(alice.client, message, s).reduce((a, b) => a + b, 0));
    });
    onTestFinished(stop);

    const voted = alice.client.vote(held(alice.client, message.channelId, message.id)!, [0]);
    expect(counts(alice.client, message)).toEqual([1, 0]);
    expect(await voted).toBe(true);
    await until(
      alice.client,
      (s) =>
        !s.pollPicks[message.id] &&
        held(alice.client, message.channelId, message.id)!.poll!.voters === 1,
      "the vote to settle",
    );
    expect(alice.client.state.pollChoices![message.id]).toEqual([0]);
    expect(Math.max(...totals)).toBe(1);
    // Nothing on the poll says who chose.
    expect(held(alice.client, message.channelId, message.id)!.poll!.options[0]).toEqual({
      text: "Good",
      votes: 1,
    });

    // Another device of hers hears what she chose; Bob's does not.
    const phone = await online();
    expect(phone.client.state.pollChoices![message.id]).toEqual([0]);
    expect(shown(phone.client, message).mine).toEqual([0]);
    const bob = await online(bobToken);
    expect(bob.client.state.pollChoices![message.id]).toBeUndefined();

    // Taking it back is heard on her other device too.
    expect(await alice.client.vote(held(alice.client, message.channelId, message.id)!, [])).toBe(
      true,
    );
    await until(phone.client, (s) => !s.pollChoices![message.id], "the phone to hear it");
    await until(phone.client, () => counts(phone.client, message)[0] === 0, "the count");
    expect(Math.max(...totals)).toBe(1);
  });

  it("put a refused vote back, and close only by their author", async () => {
    const alice = await online();
    const bob = await online(bobToken);
    const message = await asked(alice.general.id, "Ship it?", ["Yes", "No"]);
    await until(alice.client, () => !!held(alice.client, message.channelId, message.id), "it");
    await until(bob.client, () => !!held(bob.client, message.channelId, message.id), "it");

    expect(await alice.client.closePoll(held(alice.client, message.channelId, message.id)!)).toBe(
      false,
    );
    expect(await bob.client.closePoll(held(bob.client, message.channelId, message.id)!)).toBe(true);
    expect(held(bob.client, message.channelId, message.id)!.poll!.closedAt).toEqual(
      expect.any(Number),
    );

    // Alice has not heard yet: her vote shows, is refused, and goes back.
    const stale = { ...message, poll: { ...message.poll!, closedAt: null } };
    alice.client.store.setState((s) => ({
      timelines: {
        ...s.timelines,
        [message.channelId]: {
          ...s.timelines[message.channelId]!,
          items: s.timelines[message.channelId]!.items.map((m) =>
            m.id === message.id ? stale : m,
          ),
        },
      },
    }));
    const voted = alice.client.vote(stale, [0]);
    expect(shown(alice.client, message).mine).toEqual([0]);
    expect(await voted).toBe(false);
    expect(alice.client.state.pollPicks[message.id]).toBeUndefined();
    expect(shown(alice.client, message).mine).toEqual([]);
    expect(counts(alice.client, message)).toEqual([0, 0]);
  });

  it("are not sent to a server that keeps none, nor with files", async () => {
    const { client, general } = await online();
    const poll = { options: ["A", "B"], multiple: false, anonymous: false };
    const file = new File(["x"], "x.txt", { type: "text/plain" });
    expect(client.send(general.id, "With a file?", { poll, files: [file] })).toBe(false);
    client.store.setState({ pollChoices: null });
    expect(client.send(general.id, "Older server?", { poll })).toBe(false);
    expect(client.state.pending).toEqual([]);
  });

  it("let go of a deleted poll's choices", async () => {
    const alice = await online();
    const message = await asked(
      alice.general.id,
      "Gone soon",
      ["A", "B"],
      { anonymous: true },
      aliceToken,
    );
    await until(alice.client, () => !!held(alice.client, message.channelId, message.id), "it");
    await alice.client.vote(held(alice.client, message.channelId, message.id)!, [1]);
    await until(alice.client, (s) => !!s.pollChoices![message.id], "her choice");
    await new Api(base, aliceToken).deleteMessage(message.id);
    await until(alice.client, (s) => !s.pollChoices![message.id], "the choice to go");
  });
});
