import type { AppUpdater } from "electron-updater";
import { appendLog } from "./appLog.js";
import { isOffered, type InstallFeed } from "./updates.js";

/**
 * Where the app takes new versions from: the Release workflow's copy of each
 * release on Cloudflare R2, never GitHub, whose downloads crawled at ~480 KB/s
 * in India. electron-builder.yml's `publish` names it too.
 */
export const DOWNLOADS = "https://dl.ownbase.site";
/**
 * Names the newest release on R2. The Release workflow writes it only after
 * that release's files are all there, so a version it names can be downloaded.
 */
export const LATEST = `${DOWNLOADS}/latest.json`;

/**
 * Writes a line to the update log, which says which version updated to
 * which, and why one could not. Never throws: a log is not worth failing for.
 * It is cut back past the same size as the app's log (`appLog.ts`): it is for
 * the latest few updates.
 */
export function updateLog(path: string): (message: string, error?: unknown) => void {
  const write = appendLog(path);
  return (message, error) => {
    const detail = error instanceof Error ? ` ${error.message}` : error ? ` ${String(error)}` : "";
    void write(`${message}${detail}`);
  };
}

/** A release as latest.json names it, checked. */
export interface R2Release {
  tag: string;
  version: string;
  /** The folder holding its files, ending in a slash. */
  base: string;
  /** Each file by name, as GitHub names it too. */
  files: Record<string, { url: string; size: number }>;
}

const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

/**
 * latest.json, checked, or an error saying what is wrong with it. It comes
 * from the network, so its tag must look like a version and every file must
 * be in that tag's folder on dl.ownbase.site, over HTTPS.
 */
export function readLatest(body: unknown): R2Release {
  const latest = body as { tag?: unknown; files?: unknown } | null;
  if (typeof latest?.tag !== "string" || !TAG.test(latest.tag))
    throw new Error(`${LATEST} names no version.`);
  const { tag } = latest;
  const base = `${DOWNLOADS}/${tag}/`;
  if (typeof latest.files !== "object" || latest.files === null)
    throw new Error(`${LATEST} lists no files for ${tag}.`);
  const files: R2Release["files"] = {};
  for (const [name, file] of Object.entries(latest.files as Record<string, unknown>)) {
    const { url, size } = (file ?? {}) as { url?: unknown; size?: unknown };
    let href = "";
    try {
      href = typeof url === "string" ? new URL(url).href : "";
    } catch {}
    // URL resolves "..", so a file outside the tag's folder does not start with it.
    if (!href.startsWith(base)) throw new Error(`${LATEST} lists ${name} outside ${base}.`);
    if (typeof size !== "number") throw new Error(`${LATEST} gives no size for ${name}.`);
    files[name] = { url: href, size };
  }
  return { tag, version: tag.slice(1), base, files };
}

/**
 * The release latest.json names, when this copy may take it, or null. An
 * error when R2 cannot be reached or latest.json is wrong: then there is no
 * update this time, and the caller logs why. Nothing falls back to GitHub.
 */
export async function newerOnR2(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  current: string,
): Promise<R2Release | null> {
  const response = await fetcher(LATEST, {
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`${LATEST} answered ${response.status}.`);
  const body: unknown = await response.json().catch(() => null);
  const release = readLatest(body);
  return isOffered(release.version, current) ? release : null;
}

/** What updaterFeed uses of electron-updater's NsisUpdater or AppImageUpdater. */
export type Updater = Pick<
  AppUpdater,
  | "autoDownload"
  | "autoInstallOnAppQuit"
  | "logger"
  | "setFeedURL"
  | "checkForUpdates"
  | "downloadUpdate"
  | "on"
  | "off"
  | "quitAndInstall"
>;

/** electron-updater, loaded on the first look rather than at start. */
async function electronUpdater(): Promise<typeof import("electron-updater")> {
  const module = await import("electron-updater");
  // A CommonJS package: its exports are the default export here.
  return ((module as { default?: unknown }).default ?? module) as typeof import("electron-updater");
}

/** The Windows installer's updater, which reads latest.yml. */
export async function nsisUpdater(): Promise<Updater> {
  const updater = new (await electronUpdater()).NsisUpdater();
  // There is no web installer, only the full one.
  updater.disableWebInstaller = true;
  return updater;
}

/**
 * The AppImage's updater, which reads latest-linux.yml and writes the new
 * version over the file named by $APPIMAGE, the one the person opened.
 */
export async function appImageUpdater(): Promise<Updater> {
  return new (await electronUpdater()).AppImageUpdater();
}

/** The feed file electron-builder writes beside each kind of package. */
export const FEED_FILE = { nsis: "latest.yml", appImage: "latest-linux.yml" } as const;

/**
 * The updater of a package that can replace itself, the Windows installer or
 * the AppImage: electron-updater, pointed at the folder on R2 of the release
 * latest.json names, and only once that release is newer than this copy. It
 * reads the feed file electron-builder wrote beside the package (latest.yml,
 * or latest-linux.yml) and a block map for a smaller download, beside the
 * installer or inside the AppImage. Neither is code signed, so what it
 * downloads is checked only against the SHA-512 in that feed, fetched over
 * HTTPS from dl.ownbase.site.
 */
export function updaterFeed(
  log: (message: string, error?: unknown) => void,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  current: string,
  makeUpdater: () => Promise<Updater> = nsisUpdater,
  feedFile: string = FEED_FILE.nsis,
): InstallFeed & { quitAndInstall: () => void } {
  let installOnQuit = true;
  let loaded: Promise<Updater> | null = null;
  let updater: Updater | null = null;
  const load = () =>
    (loaded ??= makeUpdater().then((made) => {
      made.autoDownload = false;
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
      const release = await newerOnR2(fetcher, current);
      if (!release) return null;
      const made = await load();
      made.setFeedURL({ provider: "generic", url: release.base });
      const result = await made.checkForUpdates();
      const info = result?.updateInfo;
      if (!result?.isUpdateAvailable || info?.version !== release.version)
        throw new Error(`${release.base}${feedFile} is for ${info?.version ?? "nothing"}.`);
      // Plain names of files latest.json lists, so the download stays in that folder.
      for (const { url } of info.files)
        if (!/^[\w.-]+$/.test(url) || !Object.hasOwn(release.files, url))
          throw new Error(`${release.base}${feedFile} names ${url}, which is not there.`);
      return release.version;
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
    // Silent, as the one-click installer is, and opening the new version
    // after; the AppImage has nothing to show either way.
    quitAndInstall: () => updater?.quitAndInstall(true, true),
  };
}

/**
 * The version latest.json names, when newer than `current`. For the Mac app,
 * which cannot replace itself until it has a real signature, and the .deb,
 * which only the system's package tools may replace, so each only says one is
 * out and links to the website, whose download is the same R2 copy.
 */
export async function latestOnR2(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  current: string,
): Promise<string | null> {
  return (await newerOnR2(fetcher, current))?.version ?? null;
}
