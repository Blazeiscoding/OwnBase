import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

let server: WorkspaceServer;
let base: string;
let token: string;
let channelId: string;

async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status).toBe(method === "POST" ? 201 : 200);
  return (await response.json()) as any;
}

beforeEach(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  token = "";
  token = (
    await request("/api/auth/register", "POST", {
      handle: "reader",
      displayName: "Reader",
      password: "password123",
    })
  ).token;
  channelId = server.store.channels.byName("general")!.id;
});

afterEach(async () => {
  await server.stop();
});

describe("channel history snapshot sequence", () => {
  it.each(["latest", "older", "around", "newer"])(
    "includes committed edits in the %s page watermark without advancing read-through",
    async (mode) => {
      const first = (
        await request(`/api/channels/${channelId}/messages`, "POST", { text: "Before" })
      ).message;
      const second = (
        await request(`/api/channels/${channelId}/messages`, "POST", { text: "Original" })
      ).message;
      const third = (
        await request(`/api/channels/${channelId}/messages`, "POST", { text: "After" })
      ).message;
      const readThrough = server.store.channels.lastMessageSeq(channelId);
      await request(`/api/messages/${second.id}`, "PATCH", {
        text: "Edited",
        expectedText: "Original",
      });
      const snapshotSeq = server.store.currentSeq();
      expect(snapshotSeq).toBeGreaterThan(readThrough);
      const path = `/api/channels/${channelId}/messages`;
      const response = await request(
        mode === "around"
          ? `${path}/around/${second.id}`
          : mode === "newer"
            ? `${path}/after/${first.id}`
            : mode === "older"
              ? `${path}?before=${third.id}`
              : path,
      );
      expect(response.seq).toBe(snapshotSeq);
      expect(
        response.messages.find((message: { id: string }) => message.id === second.id),
      ).toMatchObject({ text: "Edited" });
      if (mode === "latest" || mode === "older") expect(response.readThroughSeq).toBe(readThrough);
    },
  );
});
