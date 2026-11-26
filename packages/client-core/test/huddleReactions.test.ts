import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient } from "../src/index.js";
import { HuddleSession, REACTION_SHOWN_MS } from "../src/huddle.js";
import { network } from "./network.js";

/**
 * Reactions and raised hands (K17) between real clients and a real server:
 * the connections between them are left out, as WebRTC is not here.
 */
const net = network();

let server: WorkspaceServer;
let base: string;
let channelId: string;
const clients: WorkspaceClient[] = [];

beforeEach(async () => {
  vi.stubGlobal("AudioContext", undefined);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        const track = { enabled: true, stop: vi.fn() };
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      }),
    },
  });
  vi.spyOn(HuddleSession.prototype, "syncParticipants").mockImplementation(() => {});
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await server?.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function person(handle: string) {
  const account = await new Api(base).register({
    handle,
    displayName: handle,
    password: "password123",
  });
  const client = new WorkspaceClient(base, account.token);
  clients.push(client);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find((c) => c.name === "general")!.id;
  return { client, id: account.user.id, token: account.token };
}

describe("reactions and raised hands in a huddle", () => {
  it("shows a hand raised before someone joined, and a reaction to everyone in the call", async () => {
    const maya = await person("maya");
    const priya = await person("priya");
    await maya.client.joinHuddle(channelId);
    await priya.client.joinHuddle(channelId);

    priya.client.toggleHand();
    await expect.poll(() => maya.client.state.huddle?.hands).toEqual([priya.id]);
    await expect.poll(() => priya.client.state.huddle?.hands).toEqual([priya.id]);

    // Alex joins later, and sees it from the moment the call shows.
    const alex = await person("alex");
    await alex.client.joinHuddle(channelId);
    expect(alex.client.state.huddle?.hands).toEqual([priya.id]);

    maya.client.reactInHuddle("👍");
    for (const someone of [maya, priya, alex])
      await expect
        .poll(() => someone.client.state.huddle?.reactions)
        .toEqual([{ id: 1, userId: maya.id, emoji: "👍" }]);
    await expect
      .poll(() => alex.client.state.huddle?.reactions, { timeout: REACTION_SHOWN_MS + 2000 })
      .toEqual([]);

    priya.client.toggleHand();
    await expect.poll(() => alex.client.state.huddle?.hands).toEqual([]);
    expect(net.sent(priya.token).filter((m) => m.type === "huddle.hand")).toEqual([
      { type: "huddle.hand", channelId, raised: true },
      { type: "huddle.hand", channelId, raised: false },
    ]);
  });

  it("hears nothing of another huddle's reactions", async () => {
    const maya = await person("maya");
    const sam = await person("sam");
    await maya.client.joinHuddle(channelId);
    net.deliver(
      {
        type: "ephemeral",
        event: { type: "huddle.react", channelId: "C_ELSEWHERE", from: sam.id, emoji: "👍" },
      },
      maya.token,
    );
    maya.client.reactInHuddle("🎉");
    await expect.poll(() => maya.client.state.huddle?.reactions?.length).toBe(1);
    expect(maya.client.state.huddle?.reactions?.[0]?.emoji).toBe("🎉");
  });
});
