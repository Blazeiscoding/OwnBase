import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Stamped in by the build (IMP-08); not defined when the app runs from source. */
declare const __OWNBASE_BUILD__: { revision: string } | undefined;

/** The file the installer gates leave in a profile for the next version to find. */
export const GATE_MARKER = "release-gate-marker.txt";

/** What the installed app says about itself to the release gates (F05). */
export interface GateReport {
  /** The profile this process is using, not one that merely exists. */
  userData: string;
  version: string;
  revision: string | null;
  /** The marker an earlier version's profile was given, as this process reads it. */
  marker: string | null;
  /** Whether this process could read the settings the profile already had. */
  settingsReadable: boolean;
}

/**
 * Writes the report the installer gates ask for with
 * `OWNBASE_RELEASE_GATE_REPORT=<file>` (F05). An upgrade passes only when the
 * process that started is using the previous release's profile and reads
 * what that release left there; a registry entry or a leftover folder proves
 * neither. Says only where the profile is, which build this is, and a
 * marker the gate itself wrote: nothing anyone saved.
 */
export async function writeGateReport(
  path: string,
  app: { userData: string; version: string },
  settingsReadable: () => Promise<boolean>,
): Promise<GateReport> {
  let marker: string | null = null;
  try {
    marker = (await readFile(join(app.userData, GATE_MARKER), "utf8")).trim();
  } catch {
    // None left there: a fresh profile.
  }
  const report: GateReport = {
    userData: app.userData,
    version: app.version,
    revision: typeof __OWNBASE_BUILD__ === "undefined" ? null : __OWNBASE_BUILD__.revision,
    marker,
    settingsReadable: await settingsReadable().catch(() => false),
  };
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  return report;
}
