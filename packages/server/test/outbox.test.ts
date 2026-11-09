import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ID, type ServerToClient } from "@ownbase/protocol";
import { Outbox, type OutboxSink } from "../src/events/outbox.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/** What reached a fake gateway, in order. */
function sink(online: ID[]) {
  const told: string[] = [];
  const out: OutboxSink = {
    isOnline: (id) => online.includes(id),
    anyoneOnline: () => online.length > 0,
    tellPerson: (id, event) => void told.push(`${id} ${event.type}`),
    tellAdmins: (event) => void told.push(`admins ${event.type}`),
    updateChannelAccess: (channel, id) => void told.push(`${id} access ${channel}`),
  };
  return { out, told };
}

function outbox(online: ID[], members: Record<ID, ID[]> = {}) {
  const reads = { members: 0, counts: [] as ID[] };
  const box = new Outbox({
    memberIds: (channelId) => (reads.members++, members[channelId] ?? []),
    unreadMentionCounts: (userId) => (reads.counts.push(userId), {}),
  });
  const { out, told } = sink(online);
  box.connect(out, (err) => {
    throw err;
  });
  return { box, told, reads };
}

describe("the outbox", () => {
  it("sends at once outside a change, and only once a change commits inside one", () => {
    const { box, told } = outbox(["U1"]);
    box.person("U1", { type: "scheduled" });
    expect(told).toEqual(["U1 scheduled"]);
    box.begin();
    box.person("U1", { type: "saved", messageId: "M1", saved: true });
    expect(told).toHaveLength(1);
    box.commit();
    expect(told).toEqual(["U1 scheduled", "U1 saved"]);
  });

  it("tells nobody of a change that was rolled back", () => {
    const { box, told } = outbox(["U1"]);
    const mark = box.begin();
    box.person("U1", { type: "saved", messageId: "M1", saved: true });
    box.access("C1", "U1");
    box.mentions(["U1"]);
    box.rollback(mark);
    box.person("U1", { type: "scheduled" });
    expect(told).toEqual(["U1 scheduled"]);
  });

  it("reads a notice when it sends it, once per key, and only for someone connected", () => {
    const { box, told } = outbox(["U1"]);
    let reads = 0;
    const friends = () => (reads++, { type: "friends" as const, friends: [] });
    box.begin();
    box.person("U1", friends, { key: "friends" });
    box.person("U1", friends, { key: "friends" });
    box.person("U2", friends, { key: "friends" });
    box.commit();
    expect(told).toEqual(["U1 friends"]);
    expect(reads).toBe(1);
  });

  it("sends what goes ahead first, then the rest, then mention counts once each", () => {
    const { box, told } = outbox(["U1", "U2"]);
    box.hold(() => {
      box.begin();
      box.mentions(["U1", "U2"]);
      box.person("U1", { type: "scheduled" });
      box.access("C1", "U2");
      box.person("U1", { type: "poll.choices", messageId: "M1", choices: [0] }, { ahead: true });
      box.mentions(["U1"]);
      box.commit();
      expect(told).toEqual([]);
      box.flushAhead();
      expect(told).toEqual(["U2 access C1", "U1 poll.choices"]);
      told.push("event frames");
    });
    expect(told).toEqual([
      "U2 access C1",
      "U1 poll.choices",
      "event frames",
      "U1 scheduled",
      "U1 mentions",
      "U2 mentions",
    ]);
  });

  it("tells someone offline nothing, but still ends what their access no longer allows", () => {
    const { box, told, reads } = outbox([]);
    box.person("U1", { type: "scheduled" });
    box.mentions(["U1"]);
    box.mentionsIn("C1");
    box.access("C1", "U1");
    expect(told).toEqual(["U1 access C1"]);
    expect(reads).toEqual({ members: 0, counts: [] });
  });

  it("recounts a conversation's members from the audience its change already read (F10)", () => {
    const { box, told, reads } = outbox(["U1", "U3"], { C1: ["U1", "U2", "U3"] });
    box.hold(
      () => {
        box.begin();
        box.mentionsIn("C1");
        box.mentionsIn("C1");
        box.commit();
      },
      new Map([["C1", new Set(["U1", "U2"])]]),
    );
    expect(reads.members).toBe(0);
    expect(told).toEqual(["U1 mentions"]);

    box.mentionsIn("C1");
    expect(reads.members).toBe(1);
    expect(told).toEqual(["U1 mentions", "U1 mentions", "U3 mentions"]);
  });
});

describe("a store write", () => {
  let server: WorkspaceServer;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await server.stop();
  });

  it("tells the account's devices once committed, and nothing when its change is undone", async () => {
    server = await createWorkspaceServer({
      dataDir: ":memory:",
      host: "127.0.0.1",
      port: 0,
      mdns: false,
      rateLimits: false,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const registered = (await (
      await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "sam", displayName: "Sam", password: "password123" }),
      })
    ).json()) as { token: string; user: { id: ID } };
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    sockets.push(ws);
    const frames: ServerToClient[] = [];
    ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerToClient));
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          token: registered.token,
          lastSeq: null,
          protocolVersion: PROTOCOL_VERSION,
        }),
      ),
    );
    await expect.poll(() => frames.some((f) => f.type === "synced")).toBe(true);
    const me = registered.user.id;
    const store = server.store;

    expect(() =>
      store.transaction(() => {
        store.setNotifyDefault(me, "all");
        throw new Error("undone");
      }),
    ).toThrow("undone");
    store.setNotifyDefault(me, "nothing");

    const told = () =>
      frames.flatMap((f) =>
        f.type === "ephemeral" && f.event.type === "notify.default" ? [f.event.level] : [],
      );
    await expect.poll(told).toEqual(["nothing"]);
  });
});
