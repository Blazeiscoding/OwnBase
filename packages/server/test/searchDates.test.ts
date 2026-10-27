import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * `before:` and `after:` name days on the reader's calendar, carried with the
 * query, and a date that is not one is said to be so rather than ignored.
 */
let server: WorkspaceServer;
let base: string;
let token: string;
let channelId: string;

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
  });
  token = ((await res.json()) as { token: string }).token;
  channelId = server.store.getChannelByName("general")!.id;
});

afterEach(async () => {
  await server.stop();
});

/** Posts a message and moves it to the given moment. */
async function postedAt(text: string, at: number) {
  const res = await fetch(`${base}/api/channels/${channelId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const { message } = (await res.json()) as { message: Message };
  (
    server.store as unknown as {
      db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } };
    }
  ).db
    .prepare("UPDATE messages SET created_at = ? WHERE id = ?")
    .run(at, message.id);
}

async function search(q: string, tz?: string) {
  const params = new URLSearchParams({ q, ...(tz ? { tz } : {}) });
  const res = await fetch(`${base}/api/search?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("dates in a search", () => {
  it("reads them on the reader's calendar, whatever the server's", async () => {
    // 22:00 on 8 March in New York, and 00:30 on the 9th, just after the change.
    await postedAt("zebra late on the eighth", Date.UTC(2026, 2, 9, 2));
    await postedAt("zebra early on the ninth", Date.UTC(2026, 2, 9, 4, 30));

    const after = await search("zebra after:2026-03-08", "America/New_York");
    expect(after.status).toBe(200);
    expect(after.body.messages.map((m: Message) => m.text)).toEqual(["zebra early on the ninth"]);

    const before = await search("zebra before:2026-03-09", "America/New_York");
    expect(before.body.messages.map((m: Message) => m.text)).toEqual(["zebra late on the eighth"]);

    // A reader in Tokyo is already well into the 9th for both.
    const tokyo = await search("zebra after:2026-03-08", "Asia/Tokyo");
    expect(tokyo.body.messages).toHaveLength(2);
  });

  it("says which date it could not read, instead of searching without it", async () => {
    const res = await search("zebra before:2026-02-31 after:2026-02-29", "UTC");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_search_date");
    expect(res.body.message).toContain("before:2026-02-31, after:2026-02-29");
  });

  it("refuses a time zone it does not know", async () => {
    const res = await search("zebra after:2026-03-08", "Mars/Olympus_Mons");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_time_zone");
  });
});
