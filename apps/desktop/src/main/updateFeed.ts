import { appendFile, stat, truncate } from "node:fs/promises";
import { newerRelease, type InstallFeed } from "./updates.js";

/** Where releases are published, as electron-builder.yml's `publish` names it too. */
export const RELEASES = "https://api.github.com/repos/Blazeiscoding/OwnBase/releases?per_page=20";

/** The update log is cut back to nothing past this size: it is for the latest few updates. */
const LOG_LIMIT = 256 * 1024;

/**
 * Writes a line to the update log, which says which version updated to
 * which, and why one could not. Never throws: a log is not worth failing for.
 */
export function updateLog(path: string): (message: string, error?: unknown) => void {
  let writing = Promise.resolve();
  return (message, error) => {
    const detail = error instanceof Error ? ` ${error.message}` : error ? ` ${String(error)}` : "";
    const line = `${new Date().toISOString()} ${message}${detail}\n`;
    writing = writing
      .then(async () => {
        const size = await stat(path).then(
          (info) => info.size,
          () => 0,
        );
        if (size > LOG_LIMIT) await truncate(path, 0);
        await appendFile(path, line);
      })
      .catch(() => {});
  };
}

/**
 * The Windows installer's updater: electron-updater, reading the feed file
 * (latest.yml) electron-builder wrote beside the installer and the Release
 * workflow published with it. The installer is not code signed, so what it
 * downloads is checked only against the SHA-512 in that feed file, fetched
 * over HTTPS from GitHub. `feedUrl` serves a feed from elsewhere, for a test.
 *
 * electron-updater is loaded on the first look, not at start.
 */
export function windowsFeed(
  log: (message: string, error?: unknown) => void,
  feedUrl?: string,
): InstallFeed & { quitAndInstall: () => void } {
  let installOnQuit = true;
  let loaded: Promise<import("electron-updater").NsisUpdater> | null = null;
  let updater: import("electron-updater").NsisUpdater | null = null;
  const load = () =>
    (loaded ??= import("electron-updater").then((module) => {
      // A CommonJS package: its exports are the default export here.
      const { NsisUpdater } = ((module as { default?: unknown }).default ??
        module) as typeof import("electron-updater");
      const made = new NsisUpdater(feedUrl ? { provider: "generic", url: feedUrl } : undefined);
      made.autoDownload = false;
      // There is no web installer, only the full one.
      made.disableWebInstaller = true;
      made.autoInstallOnAppQuit = installOnQuit;
      made.logger = {
        info: (message: unknown) => log(`updater: ${String(message)}`),
        warn: (message: unknown) => log(`updater warning: ${String(message)}`),
        error: (message: unknown) => log(`updater error: ${String(message)}`),
        debug: () => {},
      };
      updater = made;
      return made;
    }));
  return {
    check: async () => {
      const result = await (await load()).checkForUpdates();
      return result?.isUpdateAvailable ? result.updateInfo.version : null;
    },
    download: async (progress) => {
      const made = await load();
      const heard = (info: { percent: number }) => progress(info.percent);
      made.on("download-progress", heard);
      try {
        await made.downloadUpdate();
      } finally {
        made.off("download-progress", heard);
      }
    },
    installOnQuit: (on) => {
      installOnQuit = on;
      if (updater) updater.autoInstallOnAppQuit = on;
    },
    // Silent, as the one-click installer is, and opening the new version after.
    quitAndInstall: () => updater?.quitAndInstall(true, true),
  };
}

/**
 * The newest release newer than `current`, read from GitHub's list of
 * releases as the website's download buttons read it. For the Mac app, which
 * cannot replace itself until it has a real signature.
 */
export async function latestRelease(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  current: string,
  url = RELEASES,
): Promise<string | null> {
  const response = await fetcher(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`The list of releases answered ${response.status}.`);
  return newerRelease(await response.json(), current);
}
