import { afterEach, describe, expect, it } from "vitest";
import { orderedUlid, ulid } from "../src/ids.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * Messages are read back in the order of their ids, by the server's pages and
 * by the client's lists. An id is a millisecond and a random half, so two
 * messages made in the same millisecond used to sort either way round.
 */
describe("ids for what is kept in order", () => {
  it("sorts ones made in the same millisecond as they were made", () => {
    const now = Date.UTC(2026, 9, 13);
    const ids = Array.from({ length: 5_000 }, () => orderedUlid(now));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the millisecond it was made in, and starts each one afresh", () => {
    const now = Date.UTC(2026, 9, 13);
    const first = orderedUlid(now);
    const next = orderedUlid(now + 1);
    expect(first).toHaveLength(26);
    expect(first.slice(0, 10)).toBe(ulid(now).slice(0, 10));
    expect(next.slice(0, 10)).toBe(ulid(now + 1).slice(0, 10));
    expect(next > first).toBe(true);
    // Not the last one plus one: a new millisecond draws its random half again.
    const again = orderedUlid(now + 2);
    expect(again.slice(10)).not.toBe(next.slice(10));
  });

  it("leaves an ordinary id as hard to guess as it was", () => {
    const now = Date.UTC(2026, 9, 13);
    const halves = new Set(Array.from({ length: 200 }, () => ulid(now).slice(10)));
    // Drawn each time, never counted up from the one before.
    expect(halves.size).toBe(200);
    const [a, b] = [ulid(now), ulid(now)];
    expect(Number.parseInt(b.slice(-4), 32) - Number.parseInt(a.slice(-4), 32)).not.toBe(1);
  });
});

describe("messages made faster than the clock ticks", () => {
  let server: WorkspaceServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it("come back in the order they were made", async () => {
    server = await createWorkspaceServer({
      dataDir: ":memory:",
      host: "127.0.0.1",
      port: 0,
      mdns: false,
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
    });
    const { user } = (await res.json()) as { user: { id: string } };
    const general = server.store.getChannelByName("general")!.id;

    // Straight into the store: hundreds within each millisecond.
    const made = Array.from({ length: 2_000 }, (_, n) =>
      server!.store.createMessage({
        channelId: general,
        userId: user.id,
        text: `message ${n}`,
        threadRootId: null,
        nonce: null,
      }),
    );

    const ids = made.map((message) => message.id);
    expect([...ids].sort()).toEqual(ids);
  });
});
