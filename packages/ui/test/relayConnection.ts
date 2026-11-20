import { vi } from "vitest";

/** What a relay gives a connection that asks it for routes: candidates, or errors. */
export type RelayAnswer = ({ candidate: string | null } | { errorCode: number })[];

/** A relayed route, as a TURN server that took the username and password gives one. */
export const RELAYED =
  "candidate:1 1 udp 41885439 104.30.1.1 50000 typ relay raddr 0.0.0.0 rport 0";

/**
 * The browser's RTCPeerConnection, stood in for: once it has an offer, it
 * reports what `answer` holds then, in order. Each connection made is kept
 * with the configuration it was made with and whether it was closed.
 */
export function stubRelayConnections(answer: () => RelayAnswer) {
  const made: { config: RTCConfiguration; closed: boolean }[] = [];
  class FakeConnection extends EventTarget {
    private readonly record: (typeof made)[number];
    constructor(config: RTCConfiguration) {
      super();
      this.record = { config, closed: false };
      made.push(this.record);
    }
    createDataChannel() {}
    async createOffer() {
      return { type: "offer", sdp: "" };
    }
    async setLocalDescription() {
      const events = answer();
      setTimeout(() => {
        for (const event of events) {
          if ("errorCode" in event)
            this.dispatchEvent(Object.assign(new Event("icecandidateerror"), event));
          else
            this.dispatchEvent(
              Object.assign(new Event("icecandidate"), {
                candidate:
                  event.candidate === null
                    ? null
                    : { candidate: event.candidate, type: event.candidate.split(" ")[7] },
              }),
            );
        }
      });
    }
    close() {
      this.record.closed = true;
    }
  }
  vi.stubGlobal("RTCPeerConnection", FakeConnection);
  return made;
}
