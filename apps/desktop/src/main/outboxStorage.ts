import {
  applyOutboxChanges,
  type OutboxChanges,
  type StoredOutbox,
} from "@ownbase/client-core/outbox";
import type { SettingsStorage } from "./settings.js";

/**
 * Merges one window's outbox changes into the setting that holds an account's
 * outbox, in one turn of the settings queue. Every window on the account goes
 * through here, so none can write over a send another has just stored, as two
 * windows each reading and then writing the whole list could. Gives back the
 * value now stored and the outbox in it.
 */
export async function mergeOutboxSetting(
  settings: SettingsStorage,
  key: string,
  changes: OutboxChanges,
  enveloped: boolean,
): Promise<{ value: unknown; outbox: StoredOutbox }> {
  if (!changes || !Array.isArray(changes.put) || !Array.isArray(changes.remove))
    throw new Error("Invalid outbox changes.");
  let merged: { value: unknown; outbox: StoredOutbox } | undefined;
  await settings.update(key, (current) => {
    merged = applyOutboxChanges(current, changes, enveloped === true);
    return merged.value;
  });
  return merged!;
}
