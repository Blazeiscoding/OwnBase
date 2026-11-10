import type { EphemeralRegistry } from "../events/registry.js";

/** An account's own choices in anonymous polls, told only to its devices (E6). */
export const pollEphemeral = {
  "poll.choices": "person",
} as const satisfies Partial<EphemeralRegistry>;
