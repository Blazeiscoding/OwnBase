import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { WorkspaceClient, WorkspaceState } from "@ownbase/client-core";
import type { ID } from "@ownbase/protocol";
import type { Platform } from "./platform.js";

export const PlatformContext = createContext<Platform | null>(null);
export const ClientContext = createContext<WorkspaceClient | null>(null);
/**
 * Opens a message in the workspace on screen, so a link to one written in a
 * message opens it there rather than in another window of the app.
 */
export const OpenMessageContext = createContext<((channelId: ID, messageId: ID) => void) | null>(
  null,
);

export function usePlatform(): Platform {
  const p = useContext(PlatformContext);
  if (!p) throw new Error("PlatformContext missing");
  return p;
}

export function useClient(): WorkspaceClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error("ClientContext missing");
  return c;
}

/** Subscribe to a slice of the workspace replica. Components re-render only when their slice changes. */
export function useWorkspace<T>(selector: (s: WorkspaceState) => T): T {
  const client = useClient();
  return useStore(client.store, selector);
}
