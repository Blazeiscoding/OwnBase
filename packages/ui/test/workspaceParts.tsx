import type { ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import type { WorkspaceClient } from "@ownbase/client-core";
import type { ID } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { ToastProvider } from "../src/components/Toast.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import {
  Navigation,
  NavigationContext,
  type Dialog,
  type NavigationState,
  type Panel,
} from "../src/lib/navigation.js";
import { WorkspaceShellContext, type WorkspaceShell } from "../src/lib/workspaceShell.js";
import { reloadCollapsed } from "../src/lib/sidebarLayout.js";

export const testPlatform = (kind: Platform["kind"] = "web"): Platform => ({
  kind,
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
});

export interface WorkspaceParts {
  navigation: Navigation;
  shell: WorkspaceShell;
  /** Where the parts asked to go: the last dialog and panel, and every conversation opened. */
  dialog: () => Dialog;
  panel: () => Panel;
  opened: ID[];
  wrap: (children: ReactNode) => ReactNode;
}

/**
 * What a part of the workspace screen needs around it: the client, the
 * platform, the screen's navigation and shell, and its notices and questions.
 * The navigation is a real one, so a test reads where a press went from it.
 */
export function workspaceParts(
  client: WorkspaceClient,
  options: {
    channelId?: ID | null;
    shell?: Partial<WorkspaceShell>;
    state?: Partial<NavigationState>;
  } = {},
): WorkspaceParts {
  reloadCollapsed();
  const shell: WorkspaceShell = {
    platform: testPlatform(),
    otherWorkspaces: [],
    railPlace: 0,
    onLeaveWorkspace: () => {},
    onSignedOut: () => {},
    ...options.shell,
  };
  const navigation = new Navigation(client, client.baseUrl, {
    channelId: options.channelId ?? null,
    ...options.state,
  });
  const opened: ID[] = [];
  navigation.store.subscribe((s, was) => {
    if (s.channelId && s.channelId !== was.channelId) opened.push(s.channelId);
  });
  const wrap = (children: ReactNode) => (
    <PlatformContext.Provider value={shell.platform}>
      <ClientContext.Provider value={client}>
        <WorkspaceShellContext.Provider value={shell}>
          <NavigationContext.Provider value={navigation}>
            <ToastProvider>
              <ConfirmProvider>{children}</ConfirmProvider>
            </ToastProvider>
          </NavigationContext.Provider>
        </WorkspaceShellContext.Provider>
      </ClientContext.Provider>
    </PlatformContext.Provider>
  );
  return {
    navigation,
    shell,
    dialog: () => navigation.state.dialog,
    panel: () => navigation.state.panel,
    opened,
    wrap,
  };
}

/** Renders a part of the workspace screen inside `workspaceParts`. */
export function renderPart(
  client: WorkspaceClient,
  children: ReactNode,
  options: Parameters<typeof workspaceParts>[1] = {},
): WorkspaceParts & Omit<RenderResult, "rerender"> & { rerender: (next: ReactNode) => void } {
  const parts = workspaceParts(client, options);
  const view = render(parts.wrap(children));
  return { ...parts, ...view, rerender: (next: ReactNode) => view.rerender(parts.wrap(next)) };
}

/** The notices and questions the app around a workspace screen provides. */
export function AppNotices({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>{children}</ConfirmProvider>
    </ToastProvider>
  );
}
