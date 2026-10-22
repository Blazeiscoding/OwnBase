import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type Message, type Poll, type ServerToClient } from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import { toSlackEvent } from "../src/integrations.js";

/** Polls (E6): made, voted on, closed, kept from those who cannot read them, and dropped. */
let server: WorkspaceServer | undefined;
let dataDir: string;
let base: string;
let owner: { token: string; id: string };
let peer: { token: string; id: string };
let channelId: string;
const sockets: WebSocket[] = [];

async function start() {
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    logger: false,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function stop() {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
  server = undefined;
}

async function request(path: string, body?: unknown, method = "POST", auth = owner.token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${auth}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
}

async function connect(auth: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  sockets.push(ws);
  const frames: ServerToClient[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerToClient));
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        type: "hello",
        token: auth,
        lastSeq: null,
        protocolVersion: PROTOCOL_VERSION,
      }),
    ),
  );
  await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
  return frames;
}

const ready = (frames: ServerToClient[]) => frames.find((f) => f.type === "ready") as any;
/** The polls this socket was told about, oldest first. */
const pollUpdates = (frames: ServerToClient[]) =>
  frames.flatMap((f) =>
    f.type === "event" && f.envelope.event.type === "message.updated" && f.envelope.event.pollOnly
      ? [f.envelope.event.message]
      : [],
  );
/** What this socket was told its account chose, oldest first. */
const choicesTold = (frames: ServerToClient[]) =>
  frames.flatMap((f) =>
    f.type === "ephemeral" && f.event.type === "poll.choices" ? [f.event] : [],
  );

let nonce = 0;
const ask = (
  question: string,
  poll: { options: string[]; multiple?: boolean; anonymous?: boolean },
  auth = owner.token,
  channel = channelId,
  extra: Record<string, unknown> = {},
) =>
  request(
    `/api/channels/${channel}/messages`,
    { text: question, nonce: `n-${++nonce}`, poll, ...extra },
    "POST",
    auth,
  );
const poll = async (
  question: string,
  options: string[],
  rules: { multiple?: boolean; anonymous?: boolean } = {},
) => {
  const made = await ask(question, { options, ...rules });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.message as Message & { poll: Poll };
};
const vote = (messageId: string, choices: number[], auth = peer.token) =>
  request(`/api/messages/${messageId}/poll/votes`, { choices }, "PUT", auth);
const close = (messageId: string, auth = owner.token) =>
  request(`/api/messages/${messageId}/poll/close`, undefined, "POST", auth);
const counts = (message: { poll?: Poll }) => message.poll!.options.map((o) => o.votes);
const history = async (auth = owner.token) =>
  (await request(`/api/channels/${channelId}/messages`, undefined, "GET", auth)).body
    .messages as Message[];

async function register(handle: string) {
  const made = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  const body = (await made.json()) as any;
  return { token: body.token as string, id: body.user.id as string };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "slackoss-polls-"));
  await start();
  owner = await register("owner");
  peer = await register("peer");
  channelId = server!.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("making a poll", () => {
  it("is a message whose words are the question, with its choices and no votes", async () => {
    const made = await poll("Lunch?", ["Pizza", " Tacos "], { multiple: true });
    expect(made.text).toBe("Lunch?");
    expect(made.poll).toEqual({
      options: [
        { text: "Pizza", votes: 0, voterIds: [] },
        { text: "Tacos", votes: 0, voterIds: [] },
      ],
      multiple: true,
      anonymous: false,
      voters: 0,
      closedAt: null,
    });
    // Read back the same, and an anonymous one names nobody on any choice.
    expect((await history()).at(-1)!.poll).toEqual(made.poll);
    const secret = await poll("Rate the offsite", ["Good", "Bad"], { anonymous: true });
    expect(secret.poll.options).toEqual([
      { text: "Good", votes: 0 },
      { text: "Bad", votes: 0 },
    ]);
    expect(secret.poll).toMatchObject({ multiple: false, anonymous: true });
  });

  it("can be asked in a thread", async () => {
    const root = (
      await request(`/api/channels/${channelId}/messages`, { text: "Plans", nonce: "r" })
    ).body.message;
    const made = await ask("Which day?", { options: ["Mon", "Tue"] }, owner.token, channelId, {
      threadRootId: root.id,
    });
    expect(made.status).toBe(201);
    expect(made.body.message).toMatchObject({ threadRootId: root.id, poll: { voters: 0 } });
  });

  it("needs a question and two to ten different choices, each short enough", async () => {
    const refused = async (
      question: string,
      options: string[],
      extra: Record<string, unknown> = {},
    ) => (await ask(question, { options }, owner.token, channelId, extra)).status;
    const ten = Array.from({ length: 10 }, (_, i) => `Choice ${i + 1}`);
    expect(await refused("Pick", ["Only"])).toBe(400);
    expect(await refused("Pick", [...ten, "Eleven"])).toBe(400);
    expect(await refused("Pick", ["Yes", "yes"])).toBe(400);
    expect(await refused("Pick", ["Yes", "   "])).toBe(400);
    expect(await refused("Pick", ["Yes", "x".repeat(81)])).toBe(400);
    expect(await refused("   ", ["Yes", "No"])).toBe(400);
    expect(await refused("q".repeat(301), ["Yes", "No"])).toBe(400);
    // A poll is its question and choices, not a carrier for something else.
    expect(await refused("Pick", ["Yes", "No"], { fileIds: ["F1"] })).toBe(400);
    expect(await refused("Pick", ["Yes", "No"], { forwardFrom: "M1" })).toBe(400);
    // At the edges it is taken.
    expect((await ask("q".repeat(300), { options: ten })).status).toBe(201);
    expect((await ask("Pick", { options: ["Yes", "x".repeat(80)] })).status).toBe(201);
  });

  it("is made once when its send is retried", async () => {
    const body = { text: "Retry?", nonce: "same", poll: { options: ["A", "B"] } };
    const first = await request(`/api/channels/${channelId}/messages`, body);
    const again = await request(`/api/channels/${channelId}/messages`, body);
    expect(first.status).toBe(201);
    expect(again.body.message.id).toBe(first.body.message.id);
    expect((await history()).filter((m) => m.poll)).toHaveLength(1);
  });

  it("cannot have its question edited, since people voted on it as it was", async () => {
    const made = await poll("Lunch?", ["Pizza", "Tacos"]);
    const edit = await request(`/api/messages/${made.id}`, { text: "Dinner?" }, "PATCH");
    expect(edit.status).toBe(409);
    expect(edit.body.error).toBe("poll_not_editable");
    expect((await history()).at(-1)!.text).toBe("Lunch?");
  });
});

describe("voting", () => {
  it("takes one choice on a single-choice poll, moves it, and takes it back", async () => {
    const made = await poll("Lunch?", ["Pizza", "Tacos", "Salad"]);
    const first = await vote(made.id, [1]);
    expect(first.status).toBe(200);
    expect(first.body.choices).toEqual([1]);
    expect(counts(first.body.message)).toEqual([0, 1, 0]);
    expect(first.body.message.poll.options[1].voterIds).toEqual([peer.id]);
    expect(first.body.message.poll.voters).toBe(1);

    expect((await vote(made.id, [0, 2])).status).toBe(400);
    expect((await vote(made.id, [3])).status).toBe(400);
    const moved = await vote(made.id, [2]);
    expect(counts(moved.body.message)).toEqual([0, 0, 1]);

    const withdrawn = await vote(made.id, []);
    expect(withdrawn.body.choices).toEqual([]);
    expect(counts(withdrawn.body.message)).toEqual([0, 0, 0]);
    expect(withdrawn.body.message.poll.voters).toBe(0);
  });

  it("takes any number of choices on a multiple-choice poll, counting each voter once", async () => {
    const made = await poll("Which days?", ["Mon", "Tue", "Wed"], { multiple: true });
    await vote(made.id, [0, 2]);
    // The same choice twice is one choice.
    const both = await vote(made.id, [2, 0, 2], owner.token);
    expect(both.body.choices).toEqual([0, 2]);
    expect(counts(both.body.message)).toEqual([2, 0, 2]);
    expect(both.body.message.poll.voters).toBe(2);
    // Voters are listed in the order they chose.
    expect(both.body.message.poll.options[0].voterIds).toEqual([peer.id, owner.id]);
  });

  it("tells every reader the new counts, and the voter's own devices what they chose", async () => {
    const made = await poll("Lunch?", ["Pizza", "Tacos"]);
    const ownerSees = await connect(owner.token);
    const peerSees = await connect(peer.token);
    const peerPhone = await connect(peer.token);

    await vote(made.id, [0]);
    await expect.poll(() => pollUpdates(ownerSees).length).toBe(1);
    expect(counts(pollUpdates(ownerSees)[0]!)).toEqual([1, 0]);
    await expect
      .poll(() => choicesTold(peerPhone))
      .toEqual([{ type: "poll.choices", messageId: made.id, choices: [0] }]);
    expect(choicesTold(peerSees)).toHaveLength(1);
    expect(choicesTold(ownerSees)).toEqual([]);

    // Choosing again what is chosen changes nothing, so nobody is told.
    await vote(made.id, [0]);
    await vote(made.id, [1], owner.token);
    await expect.poll(() => pollUpdates(peerSees).length).toBe(2);
    expect(pollUpdates(ownerSees)).toHaveLength(2);
  });

  it("is not passed to apps, which were told of the message and not its votes", () => {
    const message = { id: "M1", channelId: "C1", text: "Lunch?" } as Message;
    expect(toSlackEvent({ type: "message.updated", message, pollOnly: true })).toBeNull();
  });

  it("is refused on a message that is not a poll, and choices are checked", async () => {
    const plain = (
      await request(`/api/channels/${channelId}/messages`, { text: "Just words", nonce: "p" })
    ).body.message;
    expect((await vote(plain.id, [0])).status).toBe(404);
    expect((await close(plain.id)).status).toBe(404);
    const made = await poll("Lunch?", ["Pizza", "Tacos"]);
    expect((await vote(made.id, [-1])).status).toBe(400);
    expect(
      (await request(`/api/messages/${made.id}/poll/votes`, {}, "PUT", peer.token)).status,
    ).toBe(400);
    expect((await vote("M-missing", [0])).status).toBe(404);
  });

  it("is kept across a restart", async () => {
    const made = await poll("Lunch?", ["Pizza", "Tacos"], { anonymous: true });
    await vote(made.id, [1]);
    await close(made.id);
    await stop();
    await start();
    const kept = (await history()).find((m) => m.id === made.id)!;
    expect(counts(kept)).toEqual([0, 1]);
    expect(kept.poll!.closedAt).toEqual(expect.any(Number));
    expect(ready(await connect(peer.token)).pollChoices).toEqual({ [made.id]: [1] });
  });
});

describe("an anonymous poll", () => {
  it("counts votes for everyone but tells only the voter what they chose", async () => {
    const made = await poll("Rate the offsite", ["Good", "Fine", "Bad"], { anonymous: true });
    const ownerSees = await connect(owner.token);
    const voted = await vote(made.id, [2]);
    expect(counts(voted.body.message)).toEqual([0, 0, 1]);
    expect(voted.body.choices).toEqual([2]);

    // Nobody, its author included, is told who chose what, now or later.
    await expect.poll(() => pollUpdates(ownerSees).length).toBe(1);
    const told = JSON.stringify(pollUpdates(ownerSees));
    expect(told).not.toContain(peer.id);
    expect(JSON.stringify(await history())).not.toContain(peer.id);
    const log = server!.store.eventsSince(0, owner.id)!;
    expect(JSON.stringify(log.filter((e) => e.event.type === "message.updated"))).not.toContain(
      peer.id,
    );

    // A device signing in learns its own account's choices, and only those.
    expect(ready(await connect(peer.token)).pollChoices).toEqual({ [made.id]: [2] });
    expect(ready(await connect(owner.token)).pollChoices).toEqual({});
  });

  it("is said to be kept by this server even before anyone votes", async () => {
    expect(ready(await connect(peer.token)).pollChoices).toEqual({});
  });
});

describe("closing a poll", () => {
  it("is for its author only, and makes the votes final", async () => {
    const made = await poll("Lunch?", ["Pizza", "Tacos"]);
    await vote(made.id, [0]);
    const peerSees = await connect(peer.token);

    const notTheirs = await close(made.id, peer.token);
    expect(notTheirs.status).toBe(403);

    const closed = await close(made.id);
    expect(closed.status).toBe(200);
    expect(closed.body.message.poll.closedAt).toEqual(expect.any(Number));
    expect(counts(closed.body.message)).toEqual([1, 0]);
    await expect.poll(() => pollUpdates(peerSees).length).toBe(1);
    expect(pollUpdates(peerSees)[0]!.poll!.closedAt).toBe(closed.body.message.poll.closedAt);

    const late = await vote(made.id, [1]);
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("poll_closed");
    expect((await vote(made.id, [])).status).toBe(409);

    // Closing it again changes nothing and tells nobody.
    expect((await close(made.id)).status).toBe(200);
    expect(pollUpdates(peerSees)).toHaveLength(1);
  });
});

describe("who can see and vote", () => {
  it("keeps a private conversation's poll from those outside it", async () => {
    const secret = (
      await request("/api/channels", { type: "private", name: "secret", memberIds: [peer.id] })
    ).body.channel;
    const made = (await ask("Budget?", { options: ["Up", "Down"] }, owner.token, secret.id)).body
      .message;
    const outsider = await register("outsider");
    expect((await vote(made.id, [0], outsider.token)).status).toBe(404);
    expect((await close(made.id, outsider.token)).status).toBe(404);
    expect((await vote(made.id, [0])).status).toBe(200);
  });

  it("lets a guest vote but not make a poll", async () => {
    server!.setAccessPolicy("guest_allowed");
    const joined = await fetch(`${base}/api/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Visitor" }),
    });
    const guest = (await joined.json()) as any;
    const made = await poll("Lunch?", ["Pizza", "Tacos"]);
    expect((await vote(made.id, [1], guest.token)).status).toBe(200);
    const theirs = await ask("Mine?", { options: ["A", "B"] }, guest.token);
    expect(theirs.status).toBe(403);
    expect(theirs.body.error).toBe("guest_not_allowed");
  });

  it("refuses votes once its conversation is archived", async () => {
    const made = await poll("Lunch?", ["Pizza", "Tacos"]);
    server!.store.updateChannel(channelId, { archived: true });
    const late = await vote(made.id, [0]);
    expect(late.status).toBe(400);
    expect(late.body.error).toBe("channel_archived");
  });
});

describe("deleting a poll", () => {
  it("drops its votes, the log's copies of its choices, and the voter's private choices", async () => {
    const made = await poll("Rate the offsite", ["Good", "Bad"], { anonymous: true });
    await vote(made.id, [0]);
    expect((await request(`/api/messages/${made.id}`, undefined, "DELETE")).status).toBe(200);

    expect((await vote(made.id, [1])).status).toBe(404);
    const log = server!.store.eventsSince(0, owner.id)!;
    const copies = log.flatMap((e) =>
      (e.event.type === "message.created" || e.event.type === "message.updated") &&
      e.event.message.id === made.id
        ? [e.event.message]
        : [],
    );
    expect(copies.length).toBeGreaterThan(1);
    for (const copy of copies) {
      expect(copy.poll).toBeUndefined();
      expect(copy.text).toBe("");
    }
    expect(ready(await connect(peer.token)).pollChoices).toEqual({});
  });
});

describe("the /poll command", () => {
  it("is listed, and an older client that sends it is told where polls are made", async () => {
    const listed = (await request("/api/commands", undefined, "GET")).body.commands;
    expect(listed).toContainEqual(expect.objectContaining({ command: "poll", builtin: true }));
    const sent = await request(`/api/channels/${channelId}/commands`, { text: "/poll Lunch?" });
    expect(sent.status).toBe(400);
    expect(sent.body.error).toBe("in_app_command");
    expect((await history()).some((m) => m.text.includes("Lunch?"))).toBe(false);
  });
});
