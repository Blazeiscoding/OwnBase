import type { RestoreInventory } from "../platform.js";

/** What a restored backup would bring back into use, in a sentence. */
export function inventorySummary(inventory: RestoreInventory): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    count(inventory.sessions, "sign-in it still accepts", "sign-ins it still accepts"),
    count(inventory.scheduled.waiting, "scheduled message waiting", "scheduled messages waiting"),
    count(
      inventory.undeliveredEvents,
      "app event not yet delivered",
      "app events not yet delivered",
    ),
  ];
  const origins = inventory.appAddresses.map((a) => a.origin);
  if (origins.length > 0) parts.push(`apps it calls at ${origins.join(", ")}`);
  return `Put back in use, it brings ${parts.join(", ")}.`;
}
