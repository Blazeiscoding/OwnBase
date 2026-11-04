import type { BackupAttention } from "./hosting.js";

/**
 * What the tray says of scheduled backups that did not finish (OPS-02). At
 * sign-in the tray is often all there is to see, so a failing backup must
 * not wait for someone to open the window and look.
 */
export function backupTrayItems(
  attention: BackupAttention[],
): { label: string; action: "show" | "retry" }[] {
  const [first] = attention;
  if (!first) return [];
  const items: { label: string; action: "show" | "retry" }[] = [
    {
      // Menu labels read "&" as an access key.
      label:
        attention.length === 1
          ? `See why the backup of ${first.name.replaceAll("&", "&&")} did not finish…`
          : `See why ${attention.length} scheduled backups did not finish…`,
      action: "show",
    },
  ];
  if (attention.some((a) => a.canRetry))
    items.push({ label: "Try the backup again", action: "retry" });
  return items;
}
