import { applyDraftChanges, isDraftChanges, type DraftChanges } from "@ownbase/client-core/drafts";
import type { SettingsStorage } from "./settings.js";

/**
 * Merges one window's draft changes into the setting that holds an account's
 * drafts, in one turn of the settings queue, as `mergeOutboxSetting` does for
 * the outbox: a draft typed in one window is not lost to another window
 * writing about a different conversation. Gives back the value now stored and
 * the drafts in it.
 */
export async function mergeDraftsSetting(
  settings: SettingsStorage,
  key: string,
  changes: DraftChanges,
  enveloped: boolean,
): Promise<{ value: unknown; drafts: Record<string, string> }> {
  if (!isDraftChanges(changes)) throw new Error("Invalid draft changes.");
  let merged: { value: unknown; drafts: Record<string, string> } | undefined;
  await settings.update(key, (current) => {
    merged = applyDraftChanges(current, changes, enveloped === true);
    return merged.value;
  });
  return merged!;
}
