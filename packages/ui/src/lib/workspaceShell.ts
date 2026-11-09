import { createContext, useContext } from "react";
import type { HostingEntry, HostingLine, OtherWorkspace } from "../components/Sidebar.js";
import type { Platform } from "../platform.js";
import type { SignedOutHow } from "./signOut.js";

/**
 * What the app around a workspace gives it: the platform, this device's other
 * saved workspaces, this computer's hosting, and the ways out of it.
 */
export interface WorkspaceShell {
  platform: Platform;
  /** This device's other saved sign-ins, in the rail's order (`railOrder`). */
  otherWorkspaces: OtherWorkspace[];
  /** Where this workspace sits among them on the rail. */
  railPlace: number;
  onOpenWorkspace?: (url: string) => void;
  /** Back to the screen that adds or joins a workspace. */
  onLeaveWorkspace: () => void;
  /** "ended": the server ended this sign-in, nobody here chose to. */
  onSignedOut: (how?: SignedOutHow) => void;
  /** A guest kept its identity as an account; carry on with this token. */
  onAccountCreated?: (token: string, handle: string) => void;
  /** This computer's hosting, shown in the sidebar's header. */
  hosting?: HostingLine;
  /** This computer hosts the workspace on screen, so Manage hosting can change it too. */
  hostedHere?: boolean;
  /** Manage hosting, for the workspace menu and Ctrl+K, in the desktop app. */
  hostingEntry?: HostingEntry;
}

export const WorkspaceShellContext = createContext<WorkspaceShell | null>(null);

export function useWorkspaceShell(): WorkspaceShell {
  const shell = useContext(WorkspaceShellContext);
  if (!shell) throw new Error("WorkspaceShellContext missing");
  return shell;
}
