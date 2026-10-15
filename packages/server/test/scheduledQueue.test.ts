import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerToClient } from "@slackoss/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * The scheduled queue has bounds: how much one account and the workspace may
 * have waiting, how much one flush takes at once, and how often a held
 * message is looked at again.
 */
let server: WorkspaceServer | undefined;
let base: string;
const sockets: WebSocket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.stop();
  server = undefined;
});

async function start(
  scheduledLimits?: Parameters<typeof createWorkspaceServer>[0]["scheduledLimits"],
) {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    scheduledLimits,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function request(path: string, token: string, body?: unknown, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function register(handle: string) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
  });
  const body = (await res.json()) as { token: string; user: { id: string } };
  return { token: body.token, id: body.user.id };
}

const general = () => server!.store.getChannelByName("general")!.id;
const schedule = (token: string, text: string, channelId = general()) =>
  request(`/api/channels/${channelId}/scheduled`, token, {
    text,
    sendAt: Date.now() + 3_600_000,
  });
/** Brings every waiting row forward instead of idling the test until it is due. */
const allDue = () => {
  for (const item of server!.store.dueScheduled(Date.now() + 7_200_000, 100_000))
    server!.store.rescheduleMessage(item.id, Date.now() - 1000);
};
const sent = () => server!.store.listMessages({ channelId: general(), limit: 500 }).length;

describe("admission to the scheduled queue", () => {
  it("refuses one account's next message past its limit, and takes one again after a cancel", async () => {
    await start({ perAccount: 3 });
    const owner = await register("owner");
    const other = await register("other");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await schedule(owner.token, `queued ${i}`);
      expect(res.status).toBe(201);
      ids.push(res.body.scheduled.id);
    }
    const refused = await schedule(owner.token, "one too many");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("scheduled_limit");
    expect(refused.body.message).toMatch(/already have 3 messages waiting/);

    // Someone else's queue is theirs.
    expect((await schedule(other.token, "mine")).status).toBe(201);

    await request(`/api/scheduled/${ids[0]}`, owner.token, undefined, "DELETE");
    expect((await schedule(owner.token, "now there is room")).status).toBe(201);
  });

  it("still replays a request it already accepted when the account is at its limit", async () => {
    await start({ perAccount: 1 });
    const owner = await register("owner");
    const body = { text: "once", nonce: "same-request", sendAt: Date.now() + 3_600_000 };
    const path = `/api/channels/${general()}/scheduled`;
    expect((await request(path, owner.token, body)).status).toBe(201);
    expect((await request(path, owner.token, body)).status).toBe(200);
  });

  it("refuses anyone once the workspace holds as many as it allows", async () => {
    await start({ perWorkspace: 2 });
    const owner = await register("owner");
    const other = await register("other");
    expect((await schedule(owner.token, "one")).status).toBe(201);
    expect((await schedule(other.token, "two")).status).toBe(201);
    const refused = await schedule(owner.token, "three");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("scheduled_limit");
  });
});

describe("draining the scheduled queue", () => {
  it("takes a batch per turn, and the rest on later turns, until all are sent", async () => {
    await start({ batch: 10, perAccount: 1000 });
    const owner = await register("owner");
    for (let i = 0; i < 35; i++) await schedule(owner.token, `due ${i}`);
    allDue();

    server!.flushScheduled();
    // Only one batch ran before the loop was handed back.
    expect(sent()).toBe(10);
    await expect.poll(sent).toBe(35);
    expect(server!.store.dueScheduled(Date.now(), 100)).toEqual([]);
  });
});

describe("a held scheduled message", () => {
  it("waits for its next attempt instead of being checked on every tick", async () => {
    await start({ heldRetryMs: 60_000 });
    const owner = await register("owner");
    const queued = await schedule(owner.token, "for a closed room");
    await request(`/api/channels/${general()}`, owner.token, { archived: true }, "PATCH");
    allDue();
    server!.flushScheduled();
    expect(server!.store.getScheduled(queued.body.scheduled.id)!.status).toBe("held");

    const hold = vi.spyOn(server!.store, "holdScheduled");
    server!.flushScheduled();
    server!.flushScheduled();
    expect(hold).not.toHaveBeenCalled();
    // It comes round again once its pause is over.
    expect(server!.store.dueScheduled(Date.now() + 61_000).map((s) => s.id)).toEqual([
      queued.body.scheduled.id,
    ]);
  });

  it("goes at the next flush once its channel reopens", async () => {
    await start();
    const owner = await register("owner");
    await schedule(owner.token, "waited for the room");
    await request(`/api/channels/${general()}`, owner.token, { archived: true }, "PATCH");
    allDue();
    server!.flushScheduled();
    expect(sent()).toBe(0);

    await request(`/api/channels/${general()}`, owner.token, { archived: false }, "PATCH");
    server!.flushScheduled();
    expect(sent()).toBe(1);
  });

  it("goes at the next flush once its author is let back into a private channel", async () => {
    await start();
    const owner = await register("owner");
    const member = await register("member");
    const { body } = await request("/api/channels", owner.token, {
      type: "private",
      name: "leads",
      memberIds: [member.id],
    });
    const channelId = body.channel.id as string;
    await schedule(member.token, "for the leads", channelId);
    server!.store.removeMember(channelId, member.id);
    allDue();
    server!.flushScheduled();
    expect(server!.store.listScheduled(member.id)[0]!.status).toBe("held");

    server!.store.addMember(channelId, member.id);
    server!.flushScheduled();
    expect(server!.store.listScheduled(member.id)).toEqual([]);
    expect(server!.store.listMessages({ channelId, limit: 10 }).map((m) => m.text)).toEqual([
      "for the leads",
    ]);
  });
});

describe("telling the author's devices that their queue changed (UX-08)", () => {
  async function connect(token: string) {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    sockets.push(ws);
    const frames: ServerToClient[] = [];
    ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as ServerToClient));
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          token,
          lastSeq: null,
          syncVersion: 1,
          protocolVersion: PROTOCOL_VERSION,
        }),
      ),
    );
    await expect.poll(() => frames.some((f) => f.type === "ready")).toBe(true);
    const told = () =>
      frames.filter((f) => f.type === "ephemeral" && f.event.type === "scheduled").length;
    return { frames, told };
  }

  it("says so to the author alone as a message is queued, edited, moved, held, sent and cancelled", async () => {
    await start({ heldRetryMs: 60_000 });
    const owner = await register("owner");
    const other = await register("other");
    const mine = await connect(owner.token);
    const theirs = await connect(other.token);
    const ready = mine.frames.find((f) => f.type === "ready");
    expect(ready && "scheduledEvents" in ready && ready.scheduledEvents).toBe(true);

    const id = (await schedule(owner.token, "first")).body.scheduled.id as string;
    await expect.poll(mine.told).toBe(1);
    await request(
      `/api/scheduled/${id}/text`,
      owner.token,
      { text: "edited", expectedText: "first" },
      "PATCH",
    );
    await expect.poll(mine.told).toBe(2);
    await request(`/api/scheduled/${id}`, owner.token, { sendAt: Date.now() + 7_200_000 }, "PATCH");
    await expect.poll(mine.told).toBe(3);

    // Held because its room closed: the author's list should say why.
    await request(`/api/channels/${general()}`, owner.token, { archived: true }, "PATCH");
    allDue();
    server!.flushScheduled();
    await expect.poll(mine.told).toBe(4);
    // Held again for the same reason a minute later: nothing new to say.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    server!.flushScheduled();
    vi.mocked(Date.now).mockRestore();
    expect(server!.store.getScheduled(id)!.status).toBe("held");

    // Sent once the room reopens: it leaves the list.
    await request(`/api/channels/${general()}`, owner.token, { archived: false }, "PATCH");
    server!.flushScheduled();
    expect(sent()).toBe(1);
    await expect.poll(mine.told).toBe(5);

    const second = (await schedule(owner.token, "second")).body.scheduled.id as string;
    await expect.poll(mine.told).toBe(6);
    await request(`/api/scheduled/${second}`, owner.token, undefined, "DELETE");
    await expect.poll(mine.told).toBe(7);

    // A request replayed by its nonce changed nothing, so it says nothing.
    const body = { text: "once", nonce: "same-request", sendAt: Date.now() + 3_600_000 };
    const path = `/api/channels/${general()}/scheduled`;
    await request(path, owner.token, body);
    await expect.poll(mine.told).toBe(8);
    expect((await request(path, owner.token, body)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mine.told()).toBe(8);

    expect(theirs.told()).toBe(0);
  });

  it("says so when a message is given up on", async () => {
    await start();
    const owner = await register("owner");
    const mine = await connect(owner.token);
    const root = await request(`/api/channels/${general()}/messages`, owner.token, {
      text: "a thread",
    });
    const rootId = root.body.message.id as string;
    const id = (
      await request(`/api/channels/${general()}/scheduled`, owner.token, {
        text: "a late reply",
        threadRootId: rootId,
        sendAt: Date.now() + 3_600_000,
      })
    ).body.scheduled.id as string;
    await expect.poll(mine.told).toBe(1);
    await request(`/api/messages/${rootId}`, owner.token, undefined, "DELETE");
    allDue();
    server!.flushScheduled();
    expect(server!.store.getScheduled(id)!.status).toBe("failed");
    await expect.poll(mine.told).toBe(2);
  });
});
