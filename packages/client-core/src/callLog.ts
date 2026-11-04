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
    "The call with them never finished setting up. If it stays this way, both of you leave the huddle and join it again.",
  no_ice_servers:
    "The workspace gave this device no STUN or TURN server, the servers that help calls cross the internet. So it can only reach people on its own network. Leave the huddle and join it again to pick up the workspace's latest call settings.",
  no_public_route_here:
    "This device could not find its address on the internet. A firewall or the network here may be blocking calls.",
  no_public_route_there:
    "Their device offered only addresses on its own network, so nobody outside that network can reach it.",
  needs_relay:
    "Both devices found their internet addresses, but your networks block a direct connection. A call between these networks needs a TURN relay, a server that passes the call between you. The host adds one in Manage hosting, under Calls from other networks.",
  unknown: "The reason is not clear from here. The call log has every step.",
};
