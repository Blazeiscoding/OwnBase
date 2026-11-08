import type { WorkspaceClient } from "@ownbase/client-core";

/** How a workspace's sign-in came to an end, for the screen that follows. */
export type SignedOutHow = "ended" | undefined;

/** Why the client stopped: "ended" when the server ended a sign-in nobody here gave up. */
export function signedOutHow(
  client: WorkspaceClient,
  status: WorkspaceClient["state"]["status"],
): SignedOutHow {
  return status === "auth_failed" && !client.signedOutOnPurpose ? "ended" : undefined;
}

/** The sign-in a workspace ended, as the sign-in screen offers it again. */
export interface SignedOutFrom {
  url: string;
  handle: string;
  workspaceName: string;
}
