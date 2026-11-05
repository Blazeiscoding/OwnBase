import type { WorkspaceClient } from "@ownbase/client-core";

/**
 * Workspaces this window is signing out of on purpose. Signing out closes the
 * connection, which the client reads as a sign-in that ended, often before the
 * sign-out's own answer arrives; that close must not be told as news.
 */
const leaving = new WeakSet<WorkspaceClient>();

/** Runs a deliberate sign-out, marked as one while it runs and after it works. */
export async function signOutOnPurpose<T>(client: WorkspaceClient, run: () => Promise<T>) {
  leaving.add(client);
  try {
    return await run();
  } catch (err) {
    leaving.delete(client);
    throw err;
  }
}

/** How a workspace's sign-in came to an end, for the screen that follows. */
export type SignedOutHow = "ended" | undefined;

/** Why the client stopped: "ended" when the server ended a sign-in nobody here gave up. */
export function signedOutHow(
  client: WorkspaceClient,
  status: WorkspaceClient["state"]["status"],
): SignedOutHow {
  return status === "auth_failed" && !leaving.has(client) ? "ended" : undefined;
}

/** The sign-in a workspace ended, as the sign-in screen offers it again. */
export interface SignedOutFrom {
  url: string;
  handle: string;
  workspaceName: string;
}
