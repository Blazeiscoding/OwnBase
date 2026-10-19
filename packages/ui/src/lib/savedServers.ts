import type { SavedServer } from "../platform.js";

/** A failed/corrupt read must not become an empty list that a later save overwrites. */
export function parseSavedServers(value: unknown): SavedServer[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error("Could not read saved sign-ins.");
  return value.map((entry) => {
    if (
      !entry ||
      typeof entry.url !== "string" ||
      typeof entry.token !== "string" ||
      !entry.token ||
      typeof entry.workspaceName !== "string" ||
      typeof entry.handle !== "string" ||
      !Number.isFinite(entry.lastUsedAt) ||
      entry.lastUsedAt < 0
    )
      throw new Error("Could not read saved sign-ins.");
    const url = new URL(entry.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Could not read a saved workspace address.");
    return {
      url: entry.url,
      token: entry.token,
      workspaceName: entry.workspaceName,
      handle: entry.handle,
      lastUsedAt: entry.lastUsedAt,
    };
  });
}

/** The saved sign-ins `value` holds, or null when they cannot be read. */
export function readSavedServers(value: unknown): SavedServer[] | null {
  try {
    return parseSavedServers(value);
  } catch {
    return null;
  }
}

/**
 * One change to the saved sign-ins, as data, so a store can make it in one
 * step for every tab and window at once, and write it down to make again.
 */
export type SignInChange =
  /**
   * Opening `server` makes it the one used most recently. `held` says this
   * window already held that sign-in, as against one it just made.
   */
  | { kind: "use"; server: SavedServer; held: boolean }
  | { kind: "forget"; url: string }
  /** Signing out removes that sign-in only, not a newer one to the same workspace. */
  | { kind: "signOut"; url: string; token: string };

export function isSignInChange(value: unknown): value is SignInChange {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  switch (value.kind) {
    case "use":
      return (
        "held" in value &&
        typeof value.held === "boolean" &&
        "server" in value &&
        readSavedServers([value.server]) !== null
      );
    case "forget":
      return "url" in value && typeof value.url === "string";
    case "signOut":
      return (
        "url" in value &&
        typeof value.url === "string" &&
        "token" in value &&
        typeof value.token === "string"
      );
    default:
      return false;
  }
}

/** What `change` makes of the sign-ins stored now. */
export function changeSavedServers(stored: SavedServer[], change: SignInChange): SavedServer[] {
  switch (change.kind) {
    case "use": {
      const { server } = change;
      const same = (s: SavedServer) => s.url === server.url && s.token === server.token;
      // Held here but gone from what is stored: another window forgot it, or
      // signed in again, since. Opening it here does not put it back.
      return change.held && !stored.some(same)
        ? stored
        : [server, ...stored.filter((s) => s.url !== server.url)];
    }
    case "forget":
      return stored.filter((s) => s.url !== change.url);
    case "signOut":
      return stored.filter((s) => s.url !== change.url || s.token !== change.token);
  }
}
