import type { EphemeralRegistry } from "../events/registry.js";

/**
 * User groups made, changed and deleted (J13), told to everyone signed in but
 * guests: a group can hold people a guest cannot see.
 */
export const groupEphemeral = {
  "userGroup.saved": "members",
  "userGroup.deleted": "members",
} as const satisfies Partial<EphemeralRegistry>;
