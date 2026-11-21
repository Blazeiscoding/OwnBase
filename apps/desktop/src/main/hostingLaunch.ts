import type { StartedWorkspace } from "@ownbase/protocol/desktop";
import type { HostedList } from "./hostedList.js";
import type { HostedServer, HostingOptions, HostingSnapshot } from "./hosting.js";
import { RegistryFormatError, type HostedWorkspace } from "./registry.js";

/** The settings key naming, by its folder, the workspace to start when the app opens. */
export const START_ON_LAUNCH_KEY = "startOnLaunch";

/**
 * The settings key for reopening a stable public address when the workspace
 * starts with OwnBase: which workspace, and which address, so a changed
 * address or another workspace is never published by it.
 */
export const REOPEN_PUBLIC_KEY = "reopenPublicOnLaunch";

/** What the hosting controller tells this part about the run, read at each use. */
export interface LaunchRun {
  server: HostedServer | null;
  workspace: { folder: string } | null;
  phase: HostingSnapshot["phase"];
  /** The running workspace is a restored copy started only to look inside. */
  isolated: boolean;
  /** Counts starts, so a step that waited can tell the run it began with from a later one. */
  runs: number;
}

export type HostingLaunch = ReturnType<typeof createHostingLaunch>;

/**
 * What hosting does when OwnBase opens: the workspace chosen to start with
 * it, whether its stable public address reopens, and what did not happen.
 */
export function createHostingLaunch(
  options: Pick<HostingOptions, "settings"> & {
    hosted: HostedList;
    serialized<T>(operation: () => Promise<T>): Promise<T>;
    changed(): void;
    run(): LaunchRun;
    start(value: unknown): Promise<StartedWorkspace>;
    openToAll(value: unknown): Promise<void>;
    /** The stable address a public link would be opened at now, if one is configured and valid. */
    stableUrl(): string | undefined;
  },
) {
  const { hosted, serialized, changed, start, openToAll, stableUrl } = options;
  /** What `REOPEN_PUBLIC_KEY` holds, once read; null when nothing is to reopen. */
  let reopenPublic: { folder: string; address: string } | null | undefined;
  /**
   * The folder of the workspace to start when the app opens, once read: null
   * for none, undefined until read. Kept so a status snapshot, which cannot
   * wait for the settings file, can say whether the running one is it.
   */
  let launchFolder: string | null | undefined;
  let launchError:
    { message: string; part: "hosting" | "public-address"; folder: string | null } | undefined;

  /**
   * The workspace chosen to start with the app, or null when none was. A
   * choice that cannot be read is not "none": it throws, and nothing is kept,
   * so reading again after the settings file is repaired finds it.
   */
  async function readLaunchFolder(): Promise<string | null> {
    if (launchFolder !== undefined) return launchFolder;
    const stored = await options.settings.get(START_ON_LAUNCH_KEY, { strict: true });
    if (stored !== null && (typeof stored !== "string" || !stored))
      throw new Error("The workspace chosen to start with OwnBase is not one it can read.");
    launchFolder = stored;
    return launchFolder;
  }

  /**
   * Chooses the workspace to start whenever OwnBase opens, by its folder,
   * or none. Only a workspace in the list can be chosen, and only one at a time.
   */
  function setStartOnLaunch(value: unknown): Promise<string | null> {
    if (value !== null && typeof value !== "string")
      return Promise.reject(new Error("Choose a workspace to start when OwnBase opens."));
    return serialized(async () => {
      const chosen = value === null ? undefined : await hosted.listed(value);
      if (chosen?.restoredHold !== undefined)
        throw new Error(`Put ${chosen.name} back in use before choosing it to start with OwnBase.`);
      try {
        await options.settings.set(START_ON_LAUNCH_KEY, value);
      } catch {
        throw new Error(
          "OwnBase could not save that choice. Check that its settings folder is writable, then try again.",
        );
      }
      launchFolder = value;
      // Starting nothing leaves nothing that failed to start.
      if (value === null) launchError = undefined;
      changed();
      return value;
    });
  }

  /**
   * Starts the workspace chosen to start with the app, if one was. A failure
   * is kept in the status to be shown, rather than lost while no window is
   * open to say it. A choice whose workspace has left the list is dropped.
   */
  async function startForLaunch(): Promise<void> {
    let folder: string | null;
    try {
      folder = await readLaunchFolder();
    } catch {
      launchError = {
        part: "hosting",
        folder: null,
        message:
          "OwnBase did not start hosting when it opened, because it could not read which workspace to start. Check that its settings file can be read, then choose the workspace again under When this computer starts.",
      };
      changed();
      return;
    }
    if (!folder) return;
    let entry: HostedWorkspace | undefined;
    try {
      entry = (await hosted.load()).find((e) => e.folder === folder);
    } catch (error) {
      launchError = {
        part: "hosting",
        folder,
        message:
          error instanceof RegistryFormatError
            ? `OwnBase did not start hosting when it opened. ${error.message}`
            : "OwnBase did not start hosting when it opened, because it could not read its list of hosted workspaces.",
      };
      changed();
      return;
    }
    if (!entry) {
      launchFolder = null;
      await options.settings.set(START_ON_LAUNCH_KEY, null).catch(() => {});
      return;
    }
    if (entry.restoredHold !== undefined) {
      launchError = {
        part: "hosting",
        folder,
        message: `OwnBase did not start hosting ${entry.name} when it opened, because it was restored from a backup and has not been put back in use.`,
      };
      changed();
      return;
    }
    try {
      await start({ folder });
    } catch (error) {
      launchError = {
        part: "hosting",
        folder,
        message: `OwnBase did not start hosting ${entry.name} when it opened. ${
          error instanceof Error ? error.message : ""
        }`.trim(),
      };
      changed();
      return;
    }
    // Read before any request queued behind the start can take its turn.
    await reopenPublicAfterLaunch(entry.name, folder, options.run().runs);
  }

  async function readReopenPublic(): Promise<{ folder: string; address: string } | null> {
    if (reopenPublic !== undefined) return reopenPublic;
    const stored = (await options.settings.get(REOPEN_PUBLIC_KEY)) as {
      folder?: unknown;
      address?: unknown;
    } | null;
    reopenPublic =
      stored && typeof stored.folder === "string" && typeof stored.address === "string"
        ? { folder: stored.folder, address: stored.address }
        : null;
    return reopenPublic;
  }

  /**
   * Publishes the stable address again after starting with OwnBase, when
   * the host asked for that for this workspace and this address. Get a public link
   * checks that the address reaches this running workspace before publishing,
   * and asks for an invite unless told otherwise, so nothing is weakened. A
   * failure is kept to be shown; hosting on the network carries on.
   *
   * Only the run that started with OwnBase is published. One stopped
   * meanwhile, or replaced by another workspace or another start of this
   * one, is left alone.
   */
  async function reopenPublicAfterLaunch(name: string, folder: string, run: number): Promise<void> {
    const launched = () => {
      const state = options.run();
      return state.server !== null && state.workspace?.folder === folder && state.runs === run;
    };
    const wanted = await readReopenPublic();
    if (!launched() || !wanted || wanted.folder !== folder || options.run().isolated) return;
    const current = stableUrl();
    if (current !== wanted.address) {
      launchError = {
        part: "public-address",
        folder,
        message: `${name} started, but the public link at ${wanted.address} was not reopened. The address OwnBase uses has changed${current ? ` to ${current}` : ""}. Press Get a public link, then turn on reopening it again.`,
      };
      changed();
      return;
    }
    try {
      // Asked for now, before anything else can start; its turn checks the run again.
      await openToAll({});
    } catch (error) {
      if (!launched()) return;
      launchError = {
        part: "public-address",
        folder,
        message: `${name} started on this network, but ${wanted.address} was not reopened. ${
          error instanceof Error ? error.message : ""
        }`.trim(),
      };
      changed();
    }
  }

  /**
   * Chooses whether the running workspace reopens its stable public address
   * when it starts with OwnBase. Only a stable address can be chosen: a
   * temporary one is different every time, so reopening it would publish an
   * address nobody was given.
   */
  function setReopenPublicOnLaunch(value: unknown): Promise<boolean> {
    if (typeof value !== "boolean")
      return Promise.reject(new Error("Say whether to reopen the address with true or false."));
    return serialized(async () => {
      const { server, workspace, phase, isolated: isolatedRun } = options.run();
      if (value) {
        if (!server || !workspace || phase !== "running")
          throw new Error("Start hosting the workspace before choosing to reopen its address.");
        if (isolatedRun)
          throw new Error(
            "A restored copy you are looking inside has no public address to reopen.",
          );
        if (!stableUrl())
          throw new Error(
            "OwnBase can reopen the public link only if it keeps the same address. Without your own address, the link changes every time. Enter your own address first.",
          );
      }
      const next = value ? { folder: workspace!.folder, address: stableUrl()! } : null;
      try {
        await options.settings.set(REOPEN_PUBLIC_KEY, next);
      } catch {
        throw new Error(
          "OwnBase could not save that choice. Check that its settings folder is writable, then try again.",
        );
      }
      reopenPublic = next;
      // Not reopening it any more leaves nothing that failed to reopen.
      if (!value && launchError?.part === "public-address") launchError = undefined;
      changed();
      return value;
    });
  }

  /**
   * The host has read what did not happen when OwnBase opened and does not
   * need it said again. Whatever is running carries on as it is.
   */
  function dismissLaunchError(): void {
    launchError = undefined;
    changed();
  }

  /** The running workspace is public now, which a failed reopen of it was waiting for. */
  function publicReopened(): void {
    if (
      launchError?.part === "public-address" &&
      launchError.folder === options.run().workspace?.folder
    )
      launchError = undefined;
  }

  return {
    /** What the status says of it: the choice, what did not happen, and what reopens. */
    state: () => ({ launchFolder, launchError, reopenPublic }),
    readLaunchFolder,
    /** Keeps the choice just written to the settings file, or null for none. */
    rememberLaunchFolder(folder: string | null): void {
      launchFolder = folder;
    },
    readReopenPublic,
    /** Hosting has started, which is what a failed start needed. */
    hostingStarted(): void {
      if (launchError?.part === "hosting") launchError = undefined;
    },
    setStartOnLaunch,
    startForLaunch,
    setReopenPublicOnLaunch,
    dismissLaunchError,
    publicReopened,
  };
}
