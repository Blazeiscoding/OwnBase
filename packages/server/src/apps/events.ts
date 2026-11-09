import type { EphemeralRegistry } from "../events/registry.js";

/** What an app says to one person only: a command's private reply, and the forms it opens. */
export const appsEphemeral = {
  "ephemeral.message": "person",
  "view.open": "person",
  "view.close": "person",
} as const satisfies Partial<EphemeralRegistry>;
