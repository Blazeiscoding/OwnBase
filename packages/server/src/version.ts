/**
 * The server's version, kept apart from the server itself so that what only
 * needs to name it (a backup's manifest, a discovery announcement) does not
 * load the HTTP server, sockets and discovery to do so (REV-07).
 */
export const SERVER_VERSION = "0.1.0";

/** Stamped in by the build (IMP-08); not defined when the server runs from source. */
declare const __OWNBASE_BUILD__:
  | { version: string; revision: string; dirty: boolean | null; inputs: string; builtAt: string }
  | undefined;

/** Which source this server was built from, or null when it runs from source. */
export const SERVER_BUILD =
  typeof __OWNBASE_BUILD__ === "undefined"
    ? null
    : { revision: __OWNBASE_BUILD__.revision, dirty: __OWNBASE_BUILD__.dirty };
