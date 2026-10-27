import type { CallCause, ID } from "@ownbase/protocol";

/*
 * Apart from the call itself, which is loaded only when someone joins one, so
 * the words for what went wrong can be shown without loading it.
 */

/** One line of this device's call log: what happened, and with whom. */
export interface CallLogLine {
  at: number;
  /** The other person, for a line about one connection. */
  peerId?: ID;
  text: string;
}

/** How a call's trouble reads to people, in the log and beside their tile. */
export const CALL_CAUSES: Record<CallCause, string> = {
  signalling:
    "The call setup with them never finished. If it stays this way, both of you leave and rejoin the huddle.",
  no_ice_servers:
    "This device was given no STUN or TURN server, so it can only reach people on its own network. Leaving and rejoining the huddle picks up the workspace's current call settings.",
  no_public_route_here:
    "This device could not find its public address. A firewall or network here may be blocking what calls need.",
  no_public_route_there:
    "Their device offered only addresses on its own network, so it cannot be reached from outside it.",
  needs_relay:
    "Both of you found public addresses, but your networks will not let you reach each other directly. A call between them needs a TURN relay. The host adds one in Manage hosting, under Calls from other networks.",
  unknown: "The reason is not clear from here. The call log has every step.",
};
