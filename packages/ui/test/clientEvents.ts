import type { ClientEvents, WorkspaceClient } from "@ownbase/client-core";

/** Tells a client's listeners some news, as the server's event would. */
export function emit<K extends keyof ClientEvents>(
  client: WorkspaceClient,
  event: K,
  ...args: ClientEvents[K]
): void {
  (
    client as unknown as {
      events: { emit: (event: K, ...args: ClientEvents[K]) => void };
    }
  ).events.emit(event, ...args);
}
