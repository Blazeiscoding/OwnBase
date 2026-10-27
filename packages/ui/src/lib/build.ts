import type { BuildRevision } from "@ownbase/protocol";

/** Stamped in by the web and desktop builds (IMP-08); not defined in tests or dev. */
declare const __OWNBASE_BUILD__:
  | { version: string; revision: string; dirty: boolean | null; inputs: string; builtAt: string }
  | undefined;

/** Which source this app was built from, or null when it was not built. */
export const APP_BUILD: BuildRevision | null =
  typeof __OWNBASE_BUILD__ === "undefined"
    ? null
    : { revision: __OWNBASE_BUILD__.revision, dirty: __OWNBASE_BUILD__.dirty };

/** A build as a report says it: a short revision, and whether it had changes. */
export function describeBuild(build: BuildRevision | null | undefined): string {
  if (!build) return "from source";
  const revision = build.revision === "unknown" ? "unknown revision" : build.revision.slice(0, 12);
  return build.dirty ? `${revision} with uncommitted changes` : revision;
}
