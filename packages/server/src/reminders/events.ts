import type { EphemeralRegistry } from "../events/registry.js";

/** A reminder set, moved or come due, and one gone, told to its account's devices. */
export const reminderEphemeral = {
  reminder: "person",
  "reminder.removed": "person",
} as const satisfies Partial<EphemeralRegistry>;
