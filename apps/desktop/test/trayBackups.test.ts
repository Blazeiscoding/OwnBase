import { describe, expect, it } from "vitest";
import type { BackupAttention } from "../src/main/hosting.js";
import { backupTrayItems } from "../src/main/trayBackups.js";

/**
 * The tray's word on scheduled backups that did not finish (OPS-02): at
 * sign-in it is often all there is to see.
 */
const failed = (name: string, canRetry = true): BackupAttention => ({
  folder: `w-${name.length}`,
  name,
  note: `The scheduled backup of ${name} did not finish.`,
  canRetry,
});

describe("scheduled backups in the tray", () => {
  it("says nothing while every backup finishes", () => {
    expect(backupTrayItems([])).toEqual([]);
  });

  it("names the one that did not finish, and offers to try again", () => {
    expect(backupTrayItems([failed("Rocket Team")])).toEqual([
      { label: "See why the backup of Rocket Team did not finish…", action: "show" },
      { label: "Try the backup again", action: "retry" },
    ]);
  });

  it("counts several, rather than listing them", () => {
    expect(backupTrayItems([failed("Rocket Team"), failed("Design Guild")])[0]).toEqual({
      label: "See why 2 scheduled backups did not finish…",
      action: "show",
    });
  });

  it("offers no retry when each backup was made and only removing older ones failed", () => {
    expect(backupTrayItems([failed("Rocket Team", false)])).toEqual([
      { label: "See why the backup of Rocket Team did not finish…", action: "show" },
    ]);
  });

  it("keeps an ampersand in a name from becoming an access key", () => {
    expect(backupTrayItems([failed("R&D")])[0]!.label).toBe(
      "See why the backup of R&&D did not finish…",
    );
  });
});
