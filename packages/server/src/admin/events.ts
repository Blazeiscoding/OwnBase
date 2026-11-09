import type { EphemeralRegistry } from "../events/registry.js";

/**
 * What changes for the whole workspace, told to everyone signed in since the
 * Join screen tells anyone who asks; and what waits for the owner and admins.
 */
export const adminEphemeral = {
  "workspace.renamed": "everyone",
  "workspace.accessPolicy": "everyone",
  "workspace.icon": "everyone",
  "workspace.linkPreviews": "everyone",
  reports: "admins",
} as const satisfies Partial<EphemeralRegistry>;
