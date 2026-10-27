import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import type { ClientToServer, ServerToClient } from "@ownbase/protocol";
import { Api, WorkspaceClient } from "../src/index.js";
import { HuddleSession } from "../src/huddle.js";

let server: WorkspaceServer;
let client: WorkspaceClient;
let channelId: string;
const tracks: { enabled: boolean; stop: ReturnType<typeof vi.fn> }[] = [];

interface Internals {
  handleServerMessage(message: ServerToClient): void;
  sendSocket(message: ClientToServer): void;
}

beforeEach(async () => {
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
  // Mesh signalling is measured at the session boundary; actual browser WebRTC
  // is covered separately. Keep real microphone acquisition/cleanup here.
  vi.spyOn(HuddleSession.prototype, "syncParticipants").mockImplementation(() => {});
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: { ephemeral: { burst: 1, perMinute: 1 } },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const account = await new Api(base).register({
    handle: "caller",
    displayName: "Caller",
    password: "password123",
  });
  client = new WorkspaceClient(base, account.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find(
    (channel) => channel.name === "general",
  )!.id;
});

afterEach(async () => {
  vi.useRealTimers();
  client?.destroy();
  await server?.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function internals(): Internals {
  return client as unknown as Internals;
}

function holdJoin() {
  const sent: ClientToServer[] = [];
  vi.spyOn(client.api, "rtcConfig").mockResolvedValue({ iceServers: [] });
  vi.spyOn(internals(), "sendSocket").mockImplementation((message) => sent.push(message));
  return sent;
}

function result(requestId: string, accepted: boolean) {
  internals().handleServerMessage({
    type: "ephemeral",
    event: accepted
      ? { type: "huddle.join.result", channelId, requestId, accepted: true }
      : {
          type: "huddle.join.result",
          channelId,
          requestId,
          accepted: false,
          message: "Try later.",
        },
  });
}

describe("huddle join acknowledgement", () => {
  it("keeps a muted microphone off before and after admission and resets it for the next join", async () => {
    const sent = holdJoin();
    const first = client.joinHuddle(channelId, { muted: true });
    await expect
      .poll(() => sent.filter((message) => message.type === "huddle.join").length)
      .toBe(1);
    expect(tracks[0]!.enabled).toBe(false);
    expect(client.state.huddle).toBeNull();
    const firstJoin = sent.find((message) => message.type === "huddle.join")!;
    if (firstJoin.type !== "huddle.join") throw new Error("missing join");
    result(firstJoin.requestId!, true);
    await first;
    expect(client.state.huddle?.micMuted).toBe(true);
    expect(tracks[0]!.enabled).toBe(false);
    client.leaveHuddle();
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();

    const second = client.joinHuddle(channelId);
    await expect
      .poll(() => sent.filter((message) => message.type === "huddle.join").length)
      .toBe(2);
    expect(tracks[1]!.enabled).toBe(true);
    const secondJoin = sent.filter((message) => message.type === "huddle.join")[1]!;
    result(secondJoin.requestId!, true);
    await second;
    expect(client.state.huddle?.micMuted).toBe(false);
  });

  it("rejects a real rate-limited join, releases the microphone and keeps the connection usable", async () => {
    await client.joinHuddle(channelId);
    expect(client.state.huddle?.channelId).toBe(channelId);
    expect(server.gateway.huddleParticipants(channelId)).toEqual([client.state.self!.id]);
    client.leaveHuddle();
    await expect(client.joinHuddle(channelId)).rejects.toThrow(/Wait \d+ seconds, then try again/);

    expect(tracks).toHaveLength(2);
    expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
    expect(client.state.huddle).toBeNull();
    expect(server.gateway.huddleParticipants(channelId)).toEqual([]);
    expect(client.state.status).toBe("online");
    expect(HuddleSession.prototype.syncParticipants).toHaveBeenCalledTimes(1);
  });

  it("does not dial cached participants or publish local joined state before admission", async () => {
    const sent = holdJoin();
    client.store.setState({ huddles: { [channelId]: ["cached-peer"] } });
    const joining = client.joinHuddle(channelId);
    await expect.poll(() => sent.some((message) => message.type === "huddle.join")).toBe(true);
    expect(tracks[0]!.stop).not.toHaveBeenCalled();
    expect(client.state.huddle).toBeNull();
    expect(HuddleSession.prototype.syncParticipants).not.toHaveBeenCalled();

    const join = sent.find((message) => message.type === "huddle.join")!;
    if (join.type !== "huddle.join") throw new Error("missing join");
    result(join.requestId!, true);
    await joining;
    expect(client.state.huddle?.channelId).toBe(channelId);
    expect(HuddleSession.prototype.syncParticipants).toHaveBeenCalledWith(["cached-peer"]);
  });

  it("fences a stale refusal from a cancelled attempt and releases both microphones", async () => {
    const sent = holdJoin();
    const first = client.joinHuddle(channelId);
    const firstRejected = expect(first).rejects.toThrow("cancelled");
    await expect
      .poll(() => sent.filter((message) => message.type === "huddle.join").length)
      .toBe(1);
    const second = client.joinHuddle(channelId);
    await firstRejected;
    await expect
      .poll(() => sent.filter((message) => message.type === "huddle.join").length)
      .toBe(2);
    const joins = sent.filter((message) => message.type === "huddle.join");
    result(joins[0]!.requestId!, false);
    expect(tracks[1]!.stop).not.toHaveBeenCalled();
    result(joins[1]!.requestId!, true);
    await second;
    client.leaveHuddle();
    expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
  });

  it("bounds an unanswered join, releases media and sends an unconditional departure", async () => {
    const sent = holdJoin();
    vi.useFakeTimers();
    const joining = client.joinHuddle(channelId);
    const rejected = expect(joining).rejects.toThrow("Check your connection");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.some((message) => message.type === "huddle.join")).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(client.state.huddle).toBeNull();
    expect(sent.at(-1)).toEqual({ type: "huddle.leave", channelId });
  });

  it("releases pending media when the client disconnects before admission", async () => {
    const sent = holdJoin();
    const joining = client.joinHuddle(channelId);
    const rejected = expect(joining).rejects.toThrow("cancelled");
    await expect.poll(() => sent.some((message) => message.type === "huddle.join")).toBe(true);
    client.destroy();
    await rejected;
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(client.state.huddle).toBeNull();
    expect(HuddleSession.prototype.syncParticipants).not.toHaveBeenCalled();
  });

  it("continues joining servers whose snapshots predate admission replies", async () => {
    const sent = holdJoin();
    const self = client.state.self!;
    internals().handleServerMessage({
      type: "ready",
      seq: client.state.lastSeq,
      self,
      users: Object.values(client.state.users),
      channels: Object.values(client.state.channels),
      memberships: [],
      channelLastSeq: {},
      presence: {},
      savedMessageIds: [],
      huddles: {},
      workspaceName: "Older server",
    });
    await client.joinHuddle(channelId);
    expect(client.state.huddle?.channelId).toBe(channelId);
    expect(sent).toContainEqual({ type: "huddle.join", channelId });
    expect(tracks[0]!.stop).not.toHaveBeenCalled();
  });
});

describe("how big the call draws everyone (E13b)", () => {
  it("gives the call's session what the call draws, though the call's view came first", async () => {
    const setViews = vi.spyOn(HuddleSession.prototype, "setViews");
    const drawn = new Map([["U_PRIYA", { camera: 300, screen: 0 }]]);
    client.setCallViews(drawn);
    const sent = holdJoin();
    const joining = client.joinHuddle(channelId);
    await expect
      .poll(() => sent.filter((message) => message.type === "huddle.join").length)
      .toBe(1);
    expect(setViews).toHaveBeenLastCalledWith(drawn);
    const join = sent.find((message) => message.type === "huddle.join")!;
    if (join.type !== "huddle.join") throw new Error("missing join");
    result(join.requestId!, true);
    await joining;

    const closed = new Map();
    client.setCallViews(closed);
    expect(setViews).toHaveBeenLastCalledWith(closed);
  });
});
