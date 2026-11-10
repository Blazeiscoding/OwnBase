import type { EphemeralRegistry } from "../events/registry.js";

/** An account's queue of scheduled messages changed, told only to its devices. */
export const scheduledEphemeral = {
  scheduled: "person",
} as const satisfies Partial<EphemeralRegistry>;
