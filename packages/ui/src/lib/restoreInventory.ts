import type { RestoreInventory } from "../platform.js";

/** What a restored backup would bring back into use, in a sentence. */
export function inventorySummary(inventory: RestoreInventory): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    `accept ${count(inventory.sessions, "earlier sign-in", "earlier sign-ins")}`,
    `send ${count(inventory.scheduled.waiting, "waiting scheduled message", "waiting scheduled messages")}`,
    `deliver ${count(inventory.undeliveredEvents, "waiting app event", "waiting app events")}`,
  ];
  const origins = inventory.appAddresses.map((a) => a.origin);
  if (origins.length > 0) parts.push(`call apps at ${origins.join(", ")}`);
  const last = parts.pop()!;
  return `Once back in use, it will ${parts.join(", ")} and ${last}.`;
}
