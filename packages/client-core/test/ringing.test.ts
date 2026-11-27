import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { PROTOCOL_VERSION } from "@ownbase/protocol";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient, type HuddleState, type WorkspaceState } from "../src/index.js";

/**
 * Ringing on the client (E10): a ring this account is part of, from the
 * snapshot and as it changes, gone once it rings nobody; and declining one,
 * which goes only to a server that rings.
 */
let server: WorkspaceServer;
let base: string;
let alice: { token: string; id: string };
let bob: { token: string; id: string };

/** How long the server rings a direct message's huddle (its `HUDDLE_RING_MS`). */
const SERVER_RING_MS = 30_000;

/**
 * Puts timeouts on a clock the test moves, still running at real speed, so
 * a ring runs out without the test waiting the whole of it.
 */
function moveableClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

function until(
  client: WorkspaceClient,
  predicate: (s: WorkspaceState) => boolean,
  label = "condition",
): Promise<WorkspaceState> {
  return new Promise((resolve, reject) => {
    if (predicate(client.state)) return resolve(client.state);
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${label}`));
    }, 5000);
    const unsubscribe = client.store.subscribe((s) => {
      if (predicate(s)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(s);
      }
    });
  });
}

async function online(token: string, url = base) {
  const client = new WorkspaceClient(url, token);
  onTestFinished(() => client.destroy());
  client.connect();
  await until(client, (s) => s.status === "online", "connection");
  return client;
}

/** A bare socket for the caller, since starting a real call needs a microphone. */
async function socket(token: string, url = base) {
  const ws = new WebSocket(url.replace("http", "ws") + "/ws");
  onTestFinished(() => ws.close());
  const ready = new Promise<void>((resolve) =>
    ws.addEventListener("message", (event) => {
      if (JSON.parse(String(event.data)).type === "ready") resolve();
    }),
  );
  ws.addEventListener("open", () =>
    ws.send(
      JSON.stringify({ type: "hello", token, lastSeq: null, protocolVersion: PROTOCOL_VERSION }),
    ),
  );
  await ready;
  return (message: unknown) => ws.send(JSON.stringify(message));
}

async function directMessage() {
  const made = await new Api(base, alice.token).createChannel({ type: "dm", memberIds: [bob.id] });
  return made.channel.id;
}

beforeAll(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  const api = new Api(base);
  const register = async (handle: string) => {
    const made = await api.register({ handle, displayName: handle, password: "password123" });
    return { token: made.token, id: made.user.id };
  };
  alice = await register("alice");
  bob = await register("bob");
});

afterAll(async () => {
  await server.stop();
});

describe("rings on the client", () => {
  it("hold a ring while it rings this account, and let it go once answered elsewhere", async () => {
    const channelId = await directMessage();
    const laptop = await online(bob.token);
    expect(laptop.state.rings).toEqual({});
    const caller = await socket(alice.token);
    caller({ type: "huddle.join", channelId, requestId: "a" });
    const state = await until(laptop, (s) => !!s.rings?.[channelId], "the ring");
    expect(state.rings![channelId]).toMatchObject({
      callerId: alice.id,
      ringing: [bob.id],
      answered: [],
    });

    // Answered on another of Bob's devices: it stops here too.
    const phone = await socket(bob.token);
    phone({ type: "huddle.join", channelId, requestId: "b" });
    await until(laptop, (s) => !s.rings?.[channelId], "the ring to stop");
    caller({ type: "huddle.leave", channelId });
    phone({ type: "huddle.leave", channelId });
  });

  it("give a device the ring it connects in the middle of, and decline it", async () => {
    const channelId = await directMessage();
    const caller = await socket(alice.token);
    caller({ type: "huddle.join", channelId, requestId: "a" });
    await expect.poll(() => server.huddles.ring(channelId)).not.toBeNull();

    const late = await online(bob.token);
    expect(late.state.rings?.[channelId]?.ringing).toEqual([bob.id]);
    late.declineRing(channelId);
    // Gone here at once, and the server heard it.
    expect(late.state.rings?.[channelId]).toBeUndefined();
    await expect.poll(() => server.huddles.ring(channelId)).toBeNull();
    caller({ type: "huddle.leave", channelId });
  });

  it("decline only a ring that rings this account, and only where the server rings", async () => {
    const channelId = await directMessage();
    const laptop = await online(bob.token);
    const sent: { type?: string }[] = [];
    const send = WebSocket.prototype.send;
    const spy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      data,
    ) {
      sent.push(JSON.parse(String(data)));
      return send.call(this, data);
    });
    try {
      // Nothing ringing: nothing to say.
      laptop.declineRing(channelId);
      // One ringing someone else is not this account's to decline.
      laptop.store.setState({
        rings: {
          [channelId]: {
            channelId,
            callerId: alice.id,
            startedAt: 0,
            endsAt: 1,
            ringing: [alice.id],
            answered: [],
            declined: [],
          },
        },
      });
      laptop.declineRing(channelId);
      expect(sent.filter((message) => message.type === "huddle.decline")).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("say once, on the caller's device in the call, who declined or that nobody answered", async () => {
    const channelId = await directMessage();
    // This device is the one in the call; the call itself goes on a bare socket.
    const inCall = await online(alice.token);
    inCall.store.setState({ huddle: { channelId } as HuddleState });
    const elsewhere = await online(alice.token);
    const caller = await socket(alice.token);
    caller({ type: "huddle.join", channelId, requestId: "a" });
    const callee = await online(bob.token);
    await until(callee, (s) => !!s.rings?.[channelId], "the ring");

    callee.declineRing(channelId);
    const said = await until(inCall, (s) => s.ringNotice !== null, "the notice");
    expect(said.ringNotice).toMatchObject({ channelId, message: "bob declined" });
    await until(elsewhere, (s) => !s.rings?.[channelId], "the other device to hear it end");
    expect(elsewhere.state.ringNotice).toBeNull();
    expect(callee.state.ringNotice).toBeNull();
    caller({ type: "huddle.leave", channelId });

    // Nobody answering in time, on a clock the test moves past the ring.
    const other = await createWorkspaceServer({
      dataDir: ":memory:",
      port: 0,
      mdns: false,
      rateLimits: false,
    });
    onTestFinished(() => other.stop());
    const url = `http://127.0.0.1:${other.port}`;
    const api = new Api(url);
    const carol = await api.register({
      handle: "carol",
      displayName: "Carol",
      password: "password123",
    });
    const dave = await api.register({
      handle: "dave",
      displayName: "Dave",
      password: "password123",
    });
    const quiet = (
      await new Api(url, carol.token).createChannel({ type: "dm", memberIds: [dave.user.id] })
    ).channel.id;
    const carols = await online(carol.token, url);
    carols.store.setState({ huddle: { channelId: quiet } as HuddleState });
    const carolsSocket = await socket(carol.token, url);
    moveableClock();
    carolsSocket({ type: "huddle.join", channelId: quiet, requestId: "a" });
    await until(carols, (s) => !!s.rings?.[quiet], "the ring");
    await vi.advanceTimersByTimeAsync(SERVER_RING_MS);
    const missed = await until(carols, (s) => s.ringNotice !== null, "no answer");
    expect(missed.ringNotice).toMatchObject({ channelId: quiet, message: "No answer" });
  });

  it("forget how a ring went once this device joins a huddle", async () => {
    const quiet = new WorkspaceClient(base, alice.token);
    onTestFinished(() => quiet.destroy());
    const { user } = await quiet.api.me();
    quiet.store.setState({
      self: user,
      ringNotice: { channelId: "C_ELSEWHERE", message: "No answer", at: 1 },
    });
    // Node has no microphone, so the join goes no further; the notice is gone already.
    const joining = quiet.joinHuddle("C_ANOTHER").catch(() => {});
    expect(quiet.state.ringNotice).toBeNull();
    await joining;
  });

  it("in a group, tell only the caller, and say nobody answered only when nobody did", async () => {
    const other = await createWorkspaceServer({
      dataDir: ":memory:",
      port: 0,
      mdns: false,
      rateLimits: false,
    });
    onTestFinished(() => other.stop());
    const url = `http://127.0.0.1:${other.port}`;
    const api = new Api(url);
    const made = async (handle: string) =>
      api.register({ handle, displayName: handle, password: "password123" });
    const [carol, dave, erin] = [await made("carol"), await made("dave"), await made("erin")];
    const channelId = (
      await new Api(url, carol.token).createChannel({
        type: "group_dm",
        memberIds: [dave.user.id, erin.user.id],
      })
    ).channel.id;
    const caller = await online(carol.token, url);
    caller.store.setState({ huddle: { channelId } as HuddleState });
    const answerer = await online(dave.token, url);
    answerer.store.setState({ huddle: { channelId } as HuddleState });
    const callerSocket = await socket(carol.token, url);
    const daveSocket = await socket(dave.token, url);
    const erins = await online(erin.token, url);

    // Dave answers and Erin says no: Carol hears it, Dave, in the call too, does not.
    callerSocket({ type: "huddle.join", channelId, requestId: "a" });
    await until(erins, (s) => !!s.rings?.[channelId], "the ring");
    daveSocket({ type: "huddle.join", channelId, requestId: "b" });
    await until(erins, (s) => s.rings?.[channelId]?.answered.length === 1, "dave answering");
    erins.declineRing(channelId);
    const said = await until(caller, (s) => s.ringNotice !== null, "the notice");
    expect(said.ringNotice?.message).toBe("erin declined");
    await until(answerer, (s) => !s.rings?.[channelId], "the ring to end for dave");
    expect(answerer.state.ringNotice).toBeNull();

    // Again: Dave answers and Erin lets it ring out. Someone answered, so nothing is said.
    for (const send of [callerSocket, daveSocket]) send({ type: "huddle.leave", channelId });
    await expect.poll(() => other.huddles.participants(channelId)).toEqual([]);
    caller.store.setState({ ringNotice: null });
    moveableClock();
    callerSocket({ type: "huddle.join", channelId, requestId: "c" });
    await until(erins, (s) => !!s.rings?.[channelId], "the second ring");
    daveSocket({ type: "huddle.join", channelId, requestId: "d" });
    await until(erins, (s) => s.rings?.[channelId]?.answered.length === 1, "dave answering again");
    await vi.advanceTimersByTimeAsync(SERVER_RING_MS);
    await until(caller, (s) => !s.rings?.[channelId], "the second ring to run out");
    expect(caller.state.ringNotice).toBeNull();
  });
});

describe("asking someone into a channel's call (K18)", () => {
  it("rings them, and tells only whoever asked that they can't join or didn't answer", async () => {
    const other = await createWorkspaceServer({
      dataDir: ":memory:",
      port: 0,
      mdns: false,
      rateLimits: false,
    });
    onTestFinished(() => other.stop());
    const url = `http://127.0.0.1:${other.port}`;
    const api = new Api(url);
    const made = async (handle: string) =>
      api.register({ handle, displayName: handle, password: "password123" });
    const [maya, sam, priya] = [await made("maya"), await made("sam"), await made("priya")];
    const general = other.store.channels.byName("general")!.id;
    const mayas = await online(maya.token, url);
    mayas.store.setState({ huddle: { channelId: general } as HuddleState });
    // The device in the call has the call code, which words how an ask went.
    (mayas as unknown as { calls: { callCode: unknown } }).calls.callCode =
      await import("../src/huddle.js");
    const priyas = await online(priya.token, url);
    priyas.store.setState({ huddle: { channelId: general } as HuddleState });
    const mayaInCall = await socket(maya.token, url);
    const priyaInCall = await socket(priya.token, url);
    mayaInCall({ type: "huddle.join", channelId: general, requestId: "a" });
    priyaInCall({ type: "huddle.join", channelId: general, requestId: "b" });
    await expect.poll(() => other.huddles.participants(general)).toHaveLength(2);
    const sams = await online(sam.token, url);

    mayaInCall({ type: "huddle.ask", channelId: general, userId: sam.user.id });
    const rung = await until(sams, (s) => !!s.rings[general], "the ring");
    expect(rung.rings[general]).toMatchObject({
      ringing: [sam.user.id],
      askedBy: { [sam.user.id]: maya.user.id },
    });
    sams.declineRing(general);
    const said = await until(mayas, (s) => s.ringNotice !== null, "the notice");
    expect(said.ringNotice).toMatchObject({ channelId: general, message: "sam can't join now" });
    await until(priyas, (s) => !s.rings[general], "the ring to end for priya");
    expect(priyas.state.ringNotice).toBeNull();

    // Missed: the ring runs out on a clock the test moves.
    mayas.store.setState({ ringNotice: null });
    moveableClock();
    mayaInCall({ type: "huddle.ask", channelId: general, userId: sam.user.id });
    await until(sams, (s) => !!s.rings[general], "the second ring");
    await vi.advanceTimersByTimeAsync(SERVER_RING_MS);
    const missed = await until(mayas, (s) => s.ringNotice !== null, "the missed notice");
    expect(missed.ringNotice?.message).toBe("sam didn't answer");
    await until(sams, (s) => !s.rings[general], "the ring to stop for sam");
  });

  it("says someone who paused notifications can't join, without ringing them", async () => {
    const other = await createWorkspaceServer({
      dataDir: ":memory:",
      port: 0,
      mdns: false,
      rateLimits: false,
    });
    onTestFinished(() => other.stop());
    const url = `http://127.0.0.1:${other.port}`;
    const api = new Api(url);
    const maya = await api.register({
      handle: "maya",
      displayName: "Maya",
      password: "password123",
    });
    const sam = await api.register({ handle: "sam", displayName: "Sam", password: "password123" });
    await new Api(url, sam.token).updateMe({ dndUntil: Date.now() + 60_000 });
    const general = other.store.channels.byName("general")!.id;
    const sams = await online(sam.token, url);
    const mayas = await online(maya.token, url);
    // Node has no microphone, so this device is put in the call by hand.
    const calls = (
      mayas as unknown as {
        calls: {
          sendSocket: (m: unknown) => void;
          session: unknown;
          huddleAdmitted: boolean;
          callCode: unknown;
        };
      }
    ).calls;
    calls.sendSocket({ type: "huddle.join", channelId: general, requestId: "a" });
    await expect.poll(() => other.huddles.participants(general)).toHaveLength(1);
    mayas.store.setState({ huddle: { channelId: general } as HuddleState });
    calls.session = { channelId: general };
    calls.huddleAdmitted = true;
    calls.callCode = await import("../src/huddle.js");
    mayas.ringIntoCall(sam.user.id);
    calls.session = null;

    const said = await until(mayas, (s) => s.ringNotice !== null, "the notice");
    expect(said.ringNotice).toMatchObject({ channelId: general, message: "Sam can't join now" });
    expect(other.huddles.ring(general)).toBeNull();
    expect(sams.state.rings).toEqual({});
  });
});
