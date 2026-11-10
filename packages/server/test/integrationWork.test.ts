import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEventType } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * What one event costs an app with many subscriptions (F11). Whether its bot
 * is in the channel, the workspace's id and the callback body are the same
 * for every one of them, so each is worked out once per event; every
 * subscription still gets its own delivery, and the filters still apply.
 */
let server: WorkspaceServer;
let base: string;
let token: string;
let ownerId: string;
let general: string;

beforeEach(async () => {
  // Isolated: nothing is sent, so what is queued stays to be counted.
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    isolated: true,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  const owner = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
  }).then((r) => r.json() as Promise<{ token: string; user: { id: string } }>);
  token = owner.token;
  ownerId = owner.user.id;
  general = server.store.channels.byName("general")!.id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.stop();
});

function app(
  name: string,
  inChannel: boolean,
  subscriptions: number,
  eventTypes: AppEventType[] = [],
) {
  const store = server.store;
  const bot = store.apps.createBotUser(`bot-${name}`, name, "", "");
  if (inChannel) store.channels.addMember(general, bot.id);
  const created = store.apps.create({
    name,
    botUserId: bot.id,
    createdBy: ownerId,
    signingSecret: "test-signing-secret-not-a-credential",
  });
  const ids: string[] = [];
  for (let i = 0; i < subscriptions; i++)
    ids.push(
      store.apps.createSubscription({
        appId: created.id,
        url: `https://example.invalid/${name}/${i}`,
        eventTypes,
      }).id,
    );
  return { botUserId: bot.id, ids };
}

async function post(text: string) {
  const response = await fetch(`${base}/api/channels/${general}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  expect(response.status).toBe(201);
}

describe("queueing one event for many subscriptions (F11)", () => {
  it.each([1, 10, 100])(
    "checks the bot, reads the workspace and builds the body once for %i subscriptions",
    async (count) => {
      const busy = app("busy", true, count);
      const outside = app("outside", false, 1);
      const filtered = app("filtered", true, 1, ["reaction.added"]);
      const membership = vi.spyOn(server.store.channels, "isMember");
      const meta = vi.spyOn(server.store, "getMeta");
      const queued = vi.spyOn(server.store.deliveries, "enqueue");

      await post("Hello, apps.");

      const asked = (botUserId: string) =>
        membership.mock.calls.filter(([, userId]) => userId === botUserId).length;
      expect(asked(busy.botUserId)).toBe(1);
      expect(asked(outside.botUserId)).toBe(1);
      expect(meta.mock.calls.filter(([key]) => key === "workspace_id")).toHaveLength(1);

      // Every subscription of the bot in the channel, and only those.
      const subscriptions = queued.mock.calls.map(([id]) => id);
      expect(subscriptions.sort()).toEqual([...busy.ids].sort());
      expect(subscriptions).not.toContain(outside.ids[0]);
      expect(subscriptions).not.toContain(filtered.ids[0]);
      const bodies = new Set(queued.mock.calls.map(([, , , body]) => body));
      expect(bodies.size).toBe(1);
      const body = JSON.parse([...bodies][0]!) as { event: { text: string }; team_id: string };
      expect(body.event.text).toBe("Hello, apps.");
      expect(body.team_id).toBe(server.store.getMeta("workspace_id"));
    },
  );
});
