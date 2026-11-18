import type { EphemeralRegistry } from "../events/registry.js";

/** Custom emoji added and removed, and who may add them, told to everyone signed in (J12). */
export const emojiEphemeral = {
  "emoji.added": "everyone",
  "emoji.removed": "everyone",
  "workspace.emojiAdding": "everyone",
} as const satisfies Partial<EphemeralRegistry>;
