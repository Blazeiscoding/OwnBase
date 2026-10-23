import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import type { ClientToServer } from "@slackoss/protocol";
import { Api, WorkspaceClient, type SignedIn } from "../src/index.js";
import { HuddleSession } from "../src/huddle.js";

/**
 * A call goes on through a dropped connection to the server: the device
 * keeps its microphone and its peers, asks to go on when the socket returns,
 * and dials afresh if the server let its place go meanwhile. Joined on
 * another device, or refused on the way back, the call ends and says why.
 */
let server: WorkspaceServer;
const clients: WorkspaceClient[] = [];
const tracks: { enabled: boolean; stop: ReturnType<typeof vi.fn> }[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await server?.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Internals {
  sendSocket(message: ClientToServer): void;
}

async function start(options: { huddleGraceMs?: number; burst?: number } = {}) {
  tracks.length = 0;
  vi.stubGlobal("AudioContext", undefined);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        const track = { enabled: true, stop: vi.fn() };
        tracks.push(track);
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      }),
    },
  });
  // The mesh is watched at the session's edge; real WebRTC is a browser's.
  vi.spyOn(HuddleSession.prototype, "syncParticipants").mockImplementation(() => {});
  vi.spyOn(HuddleSession.prototype, "closePeers");
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: options.burst ? { ephemeral: { burst: options.burst, perMinute: 1 } } : false,
    ...(options.huddleGraceMs === undefined ? {} : { huddleGraceMs: options.huddleGraceMs }),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const account = await new Api(base).register({
    handle: "caller",
    displayName: "Caller",
    password: "password123",
  });
  return { base, account };
}

async function open(base: string, token: string) {
  const client = new WorkspaceClient(base, token);
  clients.push(client);
  const sent: ClientToServer[] = [];
  const internals = client as unknown as Internals;
  const send = internals.sendSocket.bind(client);
  vi.spyOn(internals, "sendSocket").mockImplementation((message) => {
    sent.push(message);
    send(message);
  });
  vi.spyOn(client.api, "rtcConfig").mockResolvedValue({ iceServers: [] });
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  const general = Object.values(client.state.channels).find((c) => c.name === "general")!.id;
  const joins = () => sent.filter((message) => message.type === "huddle.join");
  const leaves = () => sent.filter((message) => message.type === "huddle.leave");
  return { client, general, joins, leaves };
}

/** Closes this person's sockets from the server's side, as a restarted socket or a blip does. */
function dropConnection(userId: string) {
  server.gateway.resynchronizeUser(userId);
}

describe("a call through a dropped connection to the server", () => {
  it("goes on, and takes back the place the server kept", async () => {
    const { base, account } = await start();
    const { client, general, joins, leaves } = await open(base, account.token);
    await client.joinHuddle(general);
    const self = client.state.self!.id;
    expect(server.gateway.huddleParticipants(general)).toEqual([self]);

    dropConnection(self);
    await expect.poll(() => client.state.status).toBe("reconnecting");
    // Still in the call, with the microphone on, while the socket is away.
    expect(client.state.huddle?.channelId).toBe(general);
    expect(tracks[0]!.stop).not.toHaveBeenCalled();

    await expect.poll(() => client.state.status, { timeout: 5000 }).toBe("online");
    await expect.poll(() => joins()).toHaveLength(2);
    expect(leaves()).toEqual([]);
    expect(HuddleSession.prototype.closePeers).not.toHaveBeenCalled();
    // Its peers are matched against who is there now.
    await expect
      .poll(() => vi.mocked(HuddleSession.prototype.syncParticipants).mock.calls.length)
      .toBe(2);
    expect(server.gateway.huddleParticipants(general)).toEqual([self]);
    expect(client.state.huddle?.channelId).toBe(general);
    expect(client.callLog().map((line) => line.text)).toContain(
      "Back in the huddle, in the place the server kept.",
    );
  });

  it("dials afresh when the server let its place go meanwhile", async () => {
    const { base, account } = await start({ huddleGraceMs: 20 });
    const { client, general, joins } = await open(base, account.token);
    await client.joinHuddle(general);
    const self = client.state.self!.id;

    dropConnection(self);
    await expect.poll(() => client.state.status).toBe("reconnecting");
    await expect.poll(() => server.gateway.huddleParticipants(general)).toEqual([]);
    await expect.poll(() => client.state.status, { timeout: 5000 }).toBe("online");
    await expect.poll(() => joins()).toHaveLength(2);
    expect(HuddleSession.prototype.closePeers).toHaveBeenCalledOnce();
    await expect.poll(() => server.gateway.huddleParticipants(general)).toEqual([self]);
    // Written when the join's answer arrives, which can be after the server seats it.
    await expect
      .poll(() => client.callLog().map((line) => line.text))
      .toContain("Let into the huddle again.");
    expect(client.state.huddle?.channelId).toBe(general);
  });

  it("ends, and says why, when the server will not let it back in", async () => {
    // One join a minute: the first spends it, so coming back after the place
    // went is refused.
    const { base, account } = await start({ huddleGraceMs: 20, burst: 1 });
    const { client, general } = await open(base, account.token);
    await client.joinHuddle(general);

    dropConnection(client.state.self!.id);
    await expect.poll(() => client.state.status).toBe("reconnecting");
    await expect.poll(() => client.state.status, { timeout: 5000 }).toBe("online");
    await expect.poll(() => client.state.huddle).toBeNull();
    expect(client.state.huddleEnded).toMatchObject({
      channelId: general,
      error: true,
      message: expect.stringMatching(
        /^The huddle ended here after the connection dropped\. Huddle joins are temporarily limited/,
      ),
    });
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
  });

  it("still ends when the connection was ended for good, such as signing out", async () => {
    const { base, account } = await start();
    const { client, general } = await open(base, account.token);
    await client.joinHuddle(general);
    await client.api.logout();
    await expect.poll(() => client.state.status).toBe("auth_failed");
    // The refusal arrives before the socket closes; the call ends with the close.
    await expect.poll(() => client.state.huddle).toBeNull();
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(server.gateway.huddleParticipants(general)).toEqual([]);
  });
});

describe("a call joined on another device", () => {
  it("ends here without ending it there, and says so", async () => {
    const { base, account } = await start();
    const laptop = await open(base, account.token);
    await laptop.client.joinHuddle(laptop.general);
    const self = laptop.client.state.self!.id;
    const second = (await new Api(base).login({
      handle: "caller",
      password: "password123",
    })) as SignedIn;
    const phone = await open(base, second.token);
    await phone.client.joinHuddle(phone.general);

    await expect.poll(() => laptop.client.state.huddle).toBeNull();
    expect(laptop.client.state.huddleEnded).toMatchObject({
      channelId: laptop.general,
      error: false,
      message: "You joined this huddle on another device, so it ended here.",
    });
    expect(laptop.leaves()).toEqual([]);
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(phone.client.state.huddle?.channelId).toBe(phone.general);
    expect(server.gateway.huddleParticipants(phone.general)).toEqual([self]);
  });
});
