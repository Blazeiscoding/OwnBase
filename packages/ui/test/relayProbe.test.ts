import { afterEach, describe, expect, it, vi } from "vitest";
import { probeRelay } from "../src/lib/relayProbe.js";
import { RELAYED, stubRelayConnections } from "./relayConnection.js";

const servers = [{ urls: "turn:relay.example.org:3478", username: "u", credential: "p" }];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("checking a relay", () => {
  it("asks for relayed routes only, and finds one when the relay answers", async () => {
    const made = stubRelayConnections(() => [{ candidate: RELAYED }, { candidate: null }]);
    expect(await probeRelay(servers)).toBe("works");
    expect(made).toEqual([
      { config: { iceServers: servers, iceTransportPolicy: "relay" }, closed: true },
    ]);
  });

  it("tells a refused password from a relay that never answered", async () => {
    stubRelayConnections(() => [{ errorCode: 401 }, { candidate: null }]);
    expect(await probeRelay(servers)).toBe("refused");
    stubRelayConnections(() => [{ errorCode: 701 }, { candidate: null }]);
    expect(await probeRelay(servers)).toBe("unreachable");
  });

  it("gives up when gathering never ends, ten seconds on", async () => {
    vi.useFakeTimers();
    const made = stubRelayConnections(() => []);
    let found: string | undefined;
    void probeRelay(servers).then((result) => (found = result));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(found).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(found).toBe("unreachable");
    expect(made[0]!.closed).toBe(true);
  });
});
