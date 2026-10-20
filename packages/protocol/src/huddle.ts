import type { ID } from "./entities.js";

/**
 * WebRTC negotiation payloads. The server relays these untouched — it never
 * sees or carries media, only the handshake between peers.
 *
 * Deliberately plain objects rather than DOM types: this package is shared
 * with the server, which has no lib.dom.
 */
export type HuddleSignal =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | {
      kind: "ice";
      candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };
    }
  /**
   * Which of the sender's video slots are actually carrying something.
   *
   * This has to be said out loud rather than read off the connection. A
   * receiver's track reports `muted: false` once the transport is up, whether
   * or not a single frame has ever arrived — verified against Chrome, where a
   * silent slot showed an unmuted track and 0 bytes received. Without this the
   * far side shows a black tile for a camera nobody turned on.
   */
  | {
      kind: "media";
      camera: boolean;
      screen: boolean;
      /**
       * Whether their microphone is muted. Optional because a client from
       * before this field simply does not say, and a call is not worth
       * dropping over a missing badge.
       */
      muted?: boolean;
    };

/**
 * The kinds of route ICE can find to a device: on its own network (`host`),
 * its public address as a STUN server saw it (`srflx`), one learnt from the
 * other side's checks (`prflx`), and one through a TURN relay (`relay`).
 */
export type CandidateKind = "host" | "srflx" | "prflx" | "relay";
export const CANDIDATE_KINDS: readonly CandidateKind[] = ["host", "srflx", "prflx", "relay"];

/** How many routes of each kind one side offered. */
export type CandidateCounts = Record<CandidateKind, number>;

/**
 * Why a connection did not come up, as far as one side can tell:
 * - `signalling`: the call setup never completed (no answer, or a failure
 *   making one);
 * - `no_ice_servers`: this side was given no STUN or TURN server, so it can be
 *   reached only on its own network;
 * - `no_public_route_here`: this side has servers but found no public route,
 *   so something blocks it reaching them;
 * - `no_public_route_there`: the other side offered only routes on its own
 *   network;
 * - `needs_relay`: both sides found public routes, and still could not reach
 *   each other directly: a network between them needs a TURN relay;
 * - `unknown`: none of these.
 */
export type CallCause =
  | "signalling"
  | "no_ice_servers"
  | "no_public_route_here"
  | "no_public_route_there"
  | "needs_relay"
  | "unknown";

/**
 * What one side saw of one connection in a huddle, for the host's call log.
 * Counts and states only: no address, no SDP, nothing said or shown.
 */
export interface CallReport {
  /** `stalled`: still not connected after a while, and trying again. */
  outcome: "connected" | "stalled" | "failed";
  /** Since this side started connecting to the other. */
  afterMs: number;
  /** The servers this side was given to find routes with. */
  iceServers: { stun: number; turn: number };
  local: CandidateCounts;
  remote: CandidateCounts;
  connectionState: string;
  iceConnectionState: string;
  /** The kinds of route the connection settled on, once connected. */
  route?: { local: CandidateKind; remote: CandidateKind; protocol: "udp" | "tcp" };
  /** How many times this side has tried again. */
  retries: number;
  cause?: CallCause;
}

/** One line of a server's call log, kept in memory for the host. */
export interface CallLogEntry {
  at: number;
  channelId: ID;
  /** Who joined, left, sent or reported. */
  userId: ID;
  /** The other end of a signal or a report. */
  peerId?: ID;
  kind: "joined" | "left" | "refused" | "offer" | "answer" | "dropped" | "report";
  /** Why someone was refused, left or came back, or a signal was dropped. */
  reason?: string;
  report?: CallReport;
}

/** Who is currently in a channel's huddle. */
export interface HuddleState {
  channelId: ID;
  userIds: ID[];
}

/**
 * Deterministic tie-break for who sends the offer, so two peers learning about
 * each other at the same moment don't both offer (WebRTC "glare").
 */
export function shouldInitiateOffer(selfId: ID, otherId: ID): boolean {
  return selfId < otherId;
}
