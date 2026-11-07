import type { HostingStatus, Platform } from "../src/platform.js";

type Hosting = NonNullable<Platform["hosting"]>;

/** A hosting status as a test names it; the rest is what the desktop app says by default. */
export function hostingStatus(
  status: Pick<HostingStatus, "running" | "phase"> & Partial<HostingStatus>,
): HostingStatus {
  return { backgroundAvailable: true, ...status };
}

/**
 * The desktop app's hosting with nothing hosted and nothing happening, for a
 * test that is about something else; `overrides` replace what it is about.
 */
export function hostingStub(overrides: Partial<Hosting> = {}): Hosting {
  return {
    status: async () => hostingStatus({ running: false, phase: "stopped" }),
    subscribe: () => () => {},
    start: async () => ({ folder: "rocket-team", workspaceName: "Rocket Team", port: 8543 }),
    stop: async () => {},
    openToAll: async () => {},
    endOpenToAll: async () => {},
    setAccessPolicy: async () => {},
    setPublicAddress: async () => {},
    installCloudflared: async () => {},
    relay: {
      get: async () => ({ kind: "none" }),
      set: async () => ({ kind: "none" }),
      test: async () => [],
    },
    lastHosted: async () => null,
    list: async () => ({ workspaces: [], unreadable: [] }),
    backup: async () => null,
    forget: async () => {},
    rename: async (folder, name) => ({ folder, name }),
    openFolder: async () => {},
    icon: async () => null,
    setStartOnLaunch: async () => {},
    setReopenPublicOnLaunch: async () => {},
    dismissLaunchError: async () => {},
    setPort: async () => {},
    setAutoBackup: async () => null,
    retryBackups: async () => {},
    openAtLogin: null,
    restore: async () => null,
    backups: async () => [],
    restoreOver: async () => null,
    ...overrides,
  };
}
