import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

/**
 * Installs Cloudflare's cloudflared for Open to all with what this computer
 * already has: winget on Windows, Homebrew on a Mac or on Linux. Without one,
 * or when it fails, OwnBase downloads Cloudflare's own release into its
 * folder, and keeps it only when it matches the digest GitHub publishes.
 */

/** How cloudflared gets installed: a package manager this computer has, or a download. */
export type InstallRoute = "winget" | "homebrew" | "download";

/** What installing would do, or is doing, for the hosting status. */
export interface InstallState {
  /** How the next install starts, or how the one under way is going now. */
  via: InstallRoute;
  installing?: true;
  /** Bytes downloaded so far, and of how many, once a download has started. */
  received?: number;
  total?: number;
}

const NAMES: Record<Exclude<InstallRoute, "download">, string> = {
  winget: "winget",
  homebrew: "Homebrew",
};

/**
 * winget installs the portable cloudflared for this account alone. The
 * package also offers a machine-wide installer, which needs an administrator.
 */
const WINGET_ARGS = [
  "install",
  "--id",
  "Cloudflare.cloudflared",
  "--exact",
  "--source",
  "winget",
  "--scope",
  "user",
  "--accept-package-agreements",
  "--accept-source-agreements",
  "--disable-interactivity",
];

/** Homebrew updating itself first can take minutes, for a formula it already knows. */
const HOMEBREW_ENV = {
  HOMEBREW_NO_AUTO_UPDATE: "1",
  HOMEBREW_NO_ENV_HINTS: "1",
  NONINTERACTIVE: "1",
};

/** A file is there, even a link stat cannot follow, as winget's alias in WindowsApps is. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The package manager to install with, looked for on PATH and then where it
 * usually is, since an app opened from the Dock or Start has a short PATH.
 */
export function findPackageManager(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = present,
  platform: NodeJS.Platform = process.platform,
): { route: "winget" | "homebrew"; command: string } | null {
  const windows = platform === "win32";
  const file = windows ? "winget.exe" : "brew";
  const candidates = (env.PATH ?? env.Path ?? "")
    .split(windows ? ";" : ":")
    .filter(Boolean)
    .map((dir) => join(dir, file));
  if (windows) {
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", file));
  } else {
    candidates.push(
      "/opt/homebrew/bin/brew",
      "/usr/local/bin/brew",
      "/home/linuxbrew/.linuxbrew/bin/brew",
    );
  }
  const command = candidates.find((candidate) => exists(candidate));
  return command ? { route: windows ? "winget" : "homebrew", command } : null;
}

/**
 * Cloudflare's release file for this computer, or null where it publishes
 * none. Windows on Arm runs the x64 one, as it runs OwnBase's x64 build.
 */
export function releaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const assets: Partial<Record<NodeJS.Platform, Record<string, string>>> = {
    win32: {
      x64: "cloudflared-windows-amd64.exe",
      arm64: "cloudflared-windows-amd64.exe",
      ia32: "cloudflared-windows-386.exe",
    },
    darwin: { x64: "cloudflared-darwin-amd64.tgz", arm64: "cloudflared-darwin-arm64.tgz" },
    linux: {
      x64: "cloudflared-linux-amd64",
      arm64: "cloudflared-linux-arm64",
      arm: "cloudflared-linux-arm",
      ia32: "cloudflared-linux-386",
    },
  };
  return assets[platform]?.[arch] ?? null;
}

/** Where the copy OwnBase downloads is kept in its folder. */
export function downloadedCloudflared(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(dir, platform === "win32" ? "cloudflared.exe" : "cloudflared");
}

/** A regular file's contents in an uncompressed tar archive, found by its name. */
export function fileInTar(tar: Buffer, name: string): Buffer | null {
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return null;
    const field = (start: number, end: number) =>
      header
        .subarray(start, end)
        .toString("latin1")
        .replace(/\0[\s\S]*$/, "");
    const size = Number.parseInt(field(124, 136).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) return null;
    const start = offset + 512;
    // "0" is a regular file; a NUL type flag is one too, in older archives.
    const regular = header[156] === 0x30 || header[156] === 0;
    if (regular && field(0, 100).replace(/^\.\//, "") === name)
      return start + size <= tar.length ? tar.subarray(start, start + size) : null;
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

const LATEST_RELEASE = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
const RELEASE_DOWNLOADS = "/cloudflare/cloudflared/releases/download/";
/** Far more than any cloudflared so far, which are under 60 MB. */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/** A failure already put in words for the window. */
class InstallFailure extends Error {}

const UNREACHABLE =
  "OwnBase could not reach Cloudflare's releases on GitHub. Check this computer's internet connection, then try again.";
const STALLED =
  "The download from GitHub stopped partway. Check this computer's internet connection, then try again.";
const MISMATCH =
  "The downloaded cloudflared did not match the one Cloudflare published, so OwnBase did not keep it. Try again.";
// Filesystem errors name the account's folders, which the window never needs.
const CANNOT_SAVE =
  "OwnBase could not save cloudflared in its folder. Check that this computer has free space, then try again.";
const NO_RELEASE =
  "Cloudflare publishes no cloudflared for this computer. Install it yourself, then check again.";
const CANCELLED = "Installing cloudflared was cancelled.";

/** The release file to download, with what it must turn out to be. */
function pickAsset(release: unknown, name: string): { url: string; size: number; sha256: string } {
  const assets = (release as { assets?: unknown } | null)?.assets;
  const asset = Array.isArray(assets)
    ? (assets.find((entry) => (entry as { name?: unknown })?.name === name) as
        { browser_download_url?: unknown; size?: unknown; digest?: unknown } | undefined)
    : undefined;
  const sha256 =
    typeof asset?.digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1] : null;
  let url: URL | null = null;
  try {
    url = new URL(String(asset?.browser_download_url));
  } catch {
    // Refused below, with everything else that does not add up.
  }
  const size = asset?.size;
  if (
    !sha256 ||
    !url ||
    url.origin !== "https://github.com" ||
    !url.pathname.startsWith(RELEASE_DOWNLOADS) ||
    !url.pathname.endsWith(`/${name}`) ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_DOWNLOAD_BYTES
  )
    throw new InstallFailure(
      "Cloudflare's latest release has no cloudflared OwnBase can check for this computer. Install it yourself, then check again.",
    );
  return { url: url.href, size, sha256 };
}

/** Whether a cloudflared runs on this computer: it answers with its version. */
export function cloudflaredRuns(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4_096);
    };
    try {
      // A first run can wait on a virus scan of a file this new.
      const child = spawn(path, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 30_000,
      });
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0 && /cloudflared version/i.test(output)));
    } catch {
      resolve(false);
    }
  });
}

export interface DownloadOptions {
  dir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  onProgress?: (received: number, total: number) => void;
  /** How long the download may go without a byte before it gives up. */
  stallMs?: number;
  /** Confirms the file runs on this computer; the default asks it its version. */
  check?: (path: string) => Promise<boolean>;
}

/**
 * Downloads Cloudflare's latest cloudflared into `dir`, checked against the
 * size and SHA-256 digest GitHub publishes for it and run once before it is
 * kept. Resolves to its path.
 */
export async function downloadCloudflared(options: DownloadOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const name = releaseAsset(platform, options.arch ?? process.arch);
  if (!name) throw new InstallFailure(NO_RELEASE);
  const fetcher = options.fetch ?? fetch;
  const signal = options.signal ?? new AbortController().signal;
  const stallMs = options.stallMs ?? 60_000;

  let release: unknown;
  try {
    const response = await fetcher(LATEST_RELEASE, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { accept: "application/vnd.github+json", "user-agent": "OwnBase" },
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    release = await response.json();
  } catch {
    throw new InstallFailure(signal.aborted ? CANCELLED : UNREACHABLE);
  }
  const asset = pickAsset(release, name);

  const target = downloadedCloudflared(options.dir, platform);
  // Windows runs a program by its extension, so the one tried out keeps .exe.
  const staged = join(
    options.dir,
    platform === "win32" ? "cloudflared-new.exe" : "cloudflared-new",
  );
  const archive = name.endsWith(".tgz");
  const fetched = archive ? join(options.dir, "cloudflared-new.tgz") : staged;
  const saving = <T>(work: Promise<T>): Promise<T> =>
    work.catch(() => {
      throw new InstallFailure(CANNOT_SAVE);
    });

  try {
    await saving(mkdir(options.dir, { recursive: true }));
    const stalled = new AbortController();
    let stallTimer: NodeJS.Timeout | undefined;
    const alive = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stalled.abort(), stallMs);
    };
    const hash = createHash("sha256");
    let received = 0;
    const file = await saving(open(fetched, "w", 0o755));
    try {
      alive();
      const response = await fetcher(asset.url, {
        signal: AbortSignal.any([signal, stalled.signal]),
        headers: { "user-agent": "OwnBase" },
      });
      if (!response.ok || !response.body) throw new InstallFailure(UNREACHABLE);
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        alive();
        received += value.byteLength;
        if (received > asset.size) throw new InstallFailure(MISMATCH);
        hash.update(value);
        await saving(file.write(value));
        options.onProgress?.(received, asset.size);
      }
    } catch (error) {
      if (error instanceof InstallFailure) throw error;
      throw new InstallFailure(
        signal.aborted ? CANCELLED : stalled.signal.aborted ? STALLED : UNREACHABLE,
      );
    } finally {
      clearTimeout(stallTimer);
      await file.close().catch(() => undefined);
    }
    if (received !== asset.size || hash.digest("hex") !== asset.sha256)
      throw new InstallFailure(MISMATCH);

    if (archive) {
      let binary: Buffer | null = null;
      try {
        binary = fileInTar(await promisify(gunzip)(await readFile(fetched)), "cloudflared");
      } catch {
        // Said below, the same as an archive without it.
      }
      if (!binary) throw new InstallFailure(MISMATCH);
      await saving(writeFile(staged, binary, { mode: 0o755 }));
    }
    await saving(chmod(staged, 0o755));
    if (signal.aborted) throw new InstallFailure(CANCELLED);
    if (!(await (options.check ?? cloudflaredRuns)(staged)))
      throw new InstallFailure(
        "The downloaded cloudflared does not run on this computer. Install it yourself from Cloudflare, then check again.",
      );
    await saving(rename(staged, target));
    return target;
  } finally {
    // Whatever is left over is half a download or a file that failed its check.
    for (const leftover of new Set([fetched, staged]))
      await rm(leftover, { force: true }).catch(() => undefined);
  }
}

/** The last line a package manager printed worth repeating, without its progress bars. */
function lastWords(output: string): string | null {
  const line = output
    .split(/[\r\n]+/)
    .map((text) => text.replace(/[▀-▟]/g, "").trim())
    .filter((text) => text.length > 3 && !/^[-\\|/\s.]+$/.test(text))
    .at(-1);
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

/** Runs winget or Homebrew to the end, and says how it failed when it does. */
function runPackageManager(
  route: "winget" | "homebrew",
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const name = NAMES[route];
  return new Promise((resolve, reject) => {
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-8_192);
    };
    try {
      const child = spawn(command, route === "winget" ? WINGET_ARGS : ["install", "cloudflared"], {
        env: route === "homebrew" ? { ...env, ...HOMEBREW_ENV } : env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Long enough for a slow connection, short enough that a stuck one ends.
        timeout: 15 * 60_000,
      });
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      child.once("error", () => reject(new Error(`${name} could not be started.`)));
      child.once("exit", (code) => {
        if (code === 0) return resolve();
        // winget's exit codes are HRESULTs, which are looked up in hex.
        const shown =
          code === null
            ? "it was stopped"
            : `exit code ${code > 0xffff || code < 0 ? `0x${(code >>> 0).toString(16).toUpperCase()}` : code}`;
        const words = lastWords(output);
        reject(
          new Error(
            `${name} could not install cloudflared (${shown}${words ? `: ${words}` : ""}).`,
          ),
        );
      });
    } catch {
      reject(new Error(`${name} could not be started.`));
    }
  });
}

export interface InstallerOptions {
  /** OwnBase's own folder for a downloaded cloudflared. */
  dir: string;
  /** Finds cloudflared wherever it is now, the downloaded copy included. */
  find: () => string | null;
  /** Called whenever what `state()` says changes. */
  onChange: () => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (path: string) => boolean;
  /** Replaced in tests; the default runs winget or Homebrew. */
  runPackageManager?: (
    route: "winget" | "homebrew",
    command: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<void>;
  /** Replaced in tests; the default downloads from Cloudflare's releases. */
  download?: (options: DownloadOptions) => Promise<string>;
}

/**
 * Installs cloudflared once at a time, with the package manager this computer
 * has and then by a download, and keeps the window told how it is going.
 */
export function createCloudflaredInstaller(options: InstallerOptions) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const lifetime = new AbortController();
  let installing: Promise<string> | null = null;
  let progress: InstallState | null = null;
  let lookup: { at: number; route: InstallRoute | null } | null = null;

  /** How the next install starts, looked up again at most every few seconds. */
  function route(): InstallRoute | null {
    if (!lookup || Date.now() - lookup.at > 5_000) {
      // A cloudflared this app was pointed at is the only one it will use,
      // so installing another changes nothing.
      const route = env.OWNBASE_CLOUDFLARED
        ? null
        : (findPackageManager(env, options.exists, platform)?.route ??
          (releaseAsset(platform, arch) ? "download" : null));
      lookup = { at: Date.now(), route };
    }
    return lookup.route;
  }

  function report(next: InstallState): void {
    progress = next;
    options.onChange();
  }

  async function run(): Promise<string> {
    const already = options.find();
    if (already) return already;
    if (env.OWNBASE_CLOUDFLARED)
      throw new Error(
        "OWNBASE_CLOUDFLARED names the cloudflared to use, and it is not there. Correct it, then check again.",
      );
    const manager = findPackageManager(env, options.exists, platform);
    let failed: string | null = null;
    if (manager) {
      report({ via: manager.route, installing: true });
      try {
        await (options.runPackageManager ?? runPackageManager)(manager.route, manager.command, env);
        const installed = options.find();
        if (installed) return installed;
        failed = `${NAMES[manager.route]} finished, but OwnBase cannot find the cloudflared it installed.`;
      } catch (error) {
        failed = error instanceof Error ? error.message : String(error);
      }
    }
    if (lifetime.signal.aborted) throw new Error(CANCELLED);
    if (!releaseAsset(platform, arch)) throw new Error(failed ?? NO_RELEASE);
    report({ via: "download", installing: true });
    let percent = -1;
    try {
      return await (options.download ?? downloadCloudflared)({
        dir: options.dir,
        platform,
        arch,
        signal: lifetime.signal,
        onProgress: (received, total) => {
          // Told at each whole percent rather than each chunk, so the window is not flooded.
          const now = Math.floor((received / total) * 100);
          if (now === percent) return;
          percent = now;
          report({ via: "download", installing: true, received, total });
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Both, when a package manager failed first: either could be the one to fix.
      throw new Error(failed ? `${failed} ${message}` : message);
    }
  }

  return {
    /** What the window shows: how installing goes, or would. Null where it cannot. */
    state(): InstallState | null {
      if (progress) return progress;
      const via = route();
      return via ? { via } : null;
    },
    /** Installs cloudflared, or joins the install under way. Resolves to its path. */
    install(): Promise<string> {
      installing ??= run().finally(() => {
        installing = null;
        progress = null;
        lookup = null;
        options.onChange();
      });
      return installing;
    },
    /** Ends a download under way, for quitting. A package manager is left to finish. */
    cancel(): void {
      lifetime.abort();
    },
  };
}
