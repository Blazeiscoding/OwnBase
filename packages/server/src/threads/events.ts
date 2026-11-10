import type { EphemeralRegistry } from "../events/registry.js";

/** How an account follows a thread, and how far it has read it, told to its devices. */
export const threadEphemeral = {
  "thread.follow": "person",
} as const satisfies Partial<EphemeralRegistry>;
