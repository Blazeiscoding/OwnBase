import type { EphemeralRegistry } from "../events/registry.js";

/**
 * The events of huddles, which live in the gateway alone. A join's answer,
 * the move to another device and a relayed signal go to one socket; a ring
 * to the caller and to each person it rang, on all their devices.
 */
export const huddleEphemeral = {
  "huddle.participants": "channel",
  "huddle.join.result": "device",
  "huddle.moved": "device",
  "huddle.signal": "device",
  "huddle.ring": "person",
} as const satisfies Partial<EphemeralRegistry>;
