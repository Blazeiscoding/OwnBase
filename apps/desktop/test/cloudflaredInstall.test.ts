import { afterAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  cloudflaredRuns,
  createCloudflaredInstaller,
  downloadCloudflared,
  fileInTar,
  findPackageManager,
  releaseAsset,
  type DownloadOptions,
} from "../src/main/cloudflaredInstall.js";

const workdir = mkdtempSync(join(tmpdir(), "ownbase-cloudflared-install-"));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));
let folders = 0;
/** An empty folder of its own, for one download. */
const folder = () => join(workdir, `d${folders++}`);

const present =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

/** One file in a ustar archive, as Cloudflare packs the Mac release. */
function tarOf(name: string, contents: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "latin1");
  header.write("0000755\0", 100, "latin1");
  header.write(`${contents.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write("0", 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  const padding = Buffer.alloc(Math.ceil(contents.length / 512) * 512 - contents.length);
  return Buffer.concat([header, contents, padding]);
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * GitHub as the downloader sees it: the latest release, and its file sent in
 * a few pieces. A download that is aborted fails the way fetch fails one.
 */
function fakeGitHub(
  payload: Buffer,
  asset: string,
  overrides: { digest?: string; url?: string; size?: number; stallAfter?: number } = {},
) {
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("https://api.github.com/"))
      return Response.json({
        assets: [
          {
            name: "cloudflared-linux-arm64",
            browser_download_url: "https://github.com/x",
            size: 1,
          },
          {
            name: asset,
            browser_download_url:
              overrides.url ??
              `https://github.com/cloudflare/cloudflared/releases/download/2026.10.6/${asset}`,
            size: overrides.size ?? payload.length,
            digest: overrides.digest ?? `sha256:${sha256(payload)}`,
          },
        ],
      });
    const signal = init?.signal;
    const pieces = [payload.subarray(0, 10), payload.subarray(10, 20), payload.subarray(20)];
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason));
      },
      pull(controller) {
        if (overrides.stallAfter !== undefined && sent >= overrides.stallAfter)
          return new Promise<void>(() => {});
        if (sent === pieces.length) return controller.close();
        controller.enqueue(new Uint8Array(pieces[sent++]!));
      },
    });
    return new Response(body);
  });
  return fetcher as unknown as typeof fetch & typeof fetcher;
}

/** Downloads with everything but GitHub and the trial run real. */
function download(fetcher: typeof fetch, extra: Partial<DownloadOptions> = {}) {
  return downloadCloudflared({
    dir: folder(),
    platform: "linux",
    arch: "x64",
    fetch: fetcher,
    check: async () => true,
    ...extra,
  });
}

describe("finding a package manager to install with", () => {
  it("finds winget on PATH, or where Windows keeps its alias when PATH is short", () => {
    const local = "C:\\Users\\sam\\AppData\\Local";
    const alias = join(local, "Microsoft", "WindowsApps", "winget.exe");
    const onPath = join("C:\\tools", "winget.exe");
    const env = { PATH: "C:\\tools", LOCALAPPDATA: local };
    expect(findPackageManager(env, present(onPath, alias), "win32")).toEqual({
      route: "winget",
      command: onPath,
    });
    expect(findPackageManager(env, present(alias), "win32")).toEqual({
      route: "winget",
      command: alias,
    });
    expect(findPackageManager(env, present(), "win32")).toBeNull();
  });

  it("finds Homebrew where it installs itself, for an app opened from the Dock", () => {
    expect(
      findPackageManager({ PATH: "/usr/bin:/bin" }, present("/opt/homebrew/bin/brew"), "darwin"),
    ).toEqual({ route: "homebrew", command: "/opt/homebrew/bin/brew" });
    expect(
      findPackageManager(
        { PATH: "/usr/bin" },
        present("/home/linuxbrew/.linuxbrew/bin/brew"),
        "linux",
      ),
    ).toEqual({ route: "homebrew", command: "/home/linuxbrew/.linuxbrew/bin/brew" });
    expect(findPackageManager({ PATH: "/usr/bin" }, present(), "linux")).toBeNull();
  });
});

describe("Cloudflare's release for this computer", () => {
  it("picks the file for the platform and processor, x64 for Windows on Arm", () => {
    expect(releaseAsset("win32", "arm64")).toBe("cloudflared-windows-amd64.exe");
    expect(releaseAsset("darwin", "arm64")).toBe("cloudflared-darwin-arm64.tgz");
    expect(releaseAsset("linux", "x64")).toBe("cloudflared-linux-amd64");
    expect(releaseAsset("freebsd", "x64")).toBeNull();
    expect(releaseAsset("darwin", "ia32")).toBeNull();
  });

  it("reads one file out of a tar archive by its name", () => {
    const binary = Buffer.from("the program");
    const archive = Buffer.concat([
      tarOf("README.md", Buffer.alloc(700, "r")),
      tarOf("./cloudflared", binary),
      Buffer.alloc(1024),
    ]);
    expect(fileInTar(archive, "cloudflared")).toEqual(binary);
    expect(fileInTar(archive, "cloudflared-other")).toBeNull();
    // Cut short partway through the file, it is not there.
    expect(fileInTar(archive.subarray(0, 1536 + 5), "cloudflared")).toBeNull();
  });
});

describe("downloading cloudflared", () => {
  const binary = Buffer.from("#!/bin/sh\necho cloudflared version 2026.10.6\n");

  it("keeps the file once it matches GitHub's digest and runs, telling how far it has got", async () => {
    const fetcher = fakeGitHub(binary, "cloudflared-linux-amd64");
    const dir = folder();
    const check = vi.fn(async (path: string) => readFileSync(path).equals(binary));
    const progress: number[] = [];

    const path = await download(fetcher, {
      dir,
      check,
      onProgress: (received, total) => progress.push(received / total),
    });

    expect(path).toBe(join(dir, "cloudflared"));
    expect(readFileSync(path)).toEqual(binary);
    // Tried out under another name, so a failure never replaces a copy that worked.
    expect(check).toHaveBeenCalledWith(join(dir, "cloudflared-new"));
    expect(progress.at(-1)).toBe(1);
    expect(progress.length).toBe(3);
    expect(readdirSync(dir)).toEqual(["cloudflared"]);
    expect(fetcher.mock.calls[1]![0]).toBe(
      "https://github.com/cloudflare/cloudflared/releases/download/2026.10.6/cloudflared-linux-amd64",
    );
  });

  it("takes the program out of the Mac archive", async () => {
    const archive = gzipSync(tarOf("cloudflared", binary));
    const dir = folder();
    const path = await download(fakeGitHub(archive, "cloudflared-darwin-arm64.tgz"), {
      dir,
      platform: "darwin",
      arch: "arm64",
    });
    expect(readFileSync(path)).toEqual(binary);
    expect(readdirSync(dir)).toEqual(["cloudflared"]);
  });

  it("keeps the Windows program's extension while trying it out", async () => {
    const dir = folder();
    const check = vi.fn(async () => true);
    const path = await download(fakeGitHub(binary, "cloudflared-windows-amd64.exe"), {
      dir,
      platform: "win32",
      check,
    });
    expect(path).toBe(join(dir, "cloudflared.exe"));
    expect(check).toHaveBeenCalledWith(join(dir, "cloudflared-new.exe"));
  });

  it("throws away a file that does not match what Cloudflare published", async () => {
    const dir = folder();
    await expect(
      download(
        fakeGitHub(binary, "cloudflared-linux-amd64", { digest: `sha256:${"0".repeat(64)}` }),
        {
          dir,
        },
      ),
    ).rejects.toThrow("did not match the one Cloudflare published");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("stops a download that sends more than GitHub said it would", async () => {
    const dir = folder();
    await expect(
      download(fakeGitHub(binary, "cloudflared-linux-amd64", { size: 15 }), { dir }),
    ).rejects.toThrow("did not match the one Cloudflare published");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("downloads only from Cloudflare's releases on GitHub", async () => {
    const elsewhere = fakeGitHub(binary, "cloudflared-linux-amd64", {
      url: "https://example.com/cloudflare/cloudflared/releases/download/1/cloudflared-linux-amd64",
    });
    await expect(download(elsewhere)).rejects.toThrow("no cloudflared OwnBase can check");
    const unsigned = fakeGitHub(binary, "cloudflared-linux-amd64", { digest: "" });
    await expect(download(unsigned)).rejects.toThrow("no cloudflared OwnBase can check");
    expect(elsewhere).toHaveBeenCalledTimes(1);
    expect(unsigned).toHaveBeenCalledTimes(1);
  });

  it("gives up on a download that stops sending, and says so", async () => {
    const dir = folder();
    await expect(
      download(fakeGitHub(binary, "cloudflared-linux-amd64", { stallAfter: 1 }), {
        dir,
        stallMs: 50,
      }),
    ).rejects.toThrow("The download from GitHub stopped partway");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("says GitHub could not be reached when it cannot", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(download(offline)).rejects.toThrow(
      "OwnBase could not reach Cloudflare's releases on GitHub",
    );
  });

  it("keeps nothing that does not run here", async () => {
    const dir = folder();
    await expect(
      download(fakeGitHub(binary, "cloudflared-linux-amd64"), { dir, check: async () => false }),
    ).rejects.toThrow("does not run on this computer");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("counts as running only a program that answers with cloudflared's version", async () => {
    expect(await cloudflaredRuns(join(workdir, "missing"))).toBe(false);
    // Node answers --version too, but not as cloudflared.
    expect(await cloudflaredRuns(process.execPath)).toBe(false);
  });
});

describe("installing cloudflared", () => {
  const winget = join("C:\\tools", "winget.exe");

  /** An installer on Windows, with the package manager and the download stood in for. */
  function installer(
    options: {
      hasWinget?: boolean;
      env?: NodeJS.ProcessEnv;
      platform?: NodeJS.Platform;
      arch?: string;
      runPackageManager?: () => Promise<void>;
      download?: (options: DownloadOptions) => Promise<string>;
    } = {},
  ) {
    let found: string | null = null;
    const onChange = vi.fn();
    const runPackageManager = vi.fn(
      options.runPackageManager ??
        (async () => {
          found = "C:\\winget\\cloudflared.exe";
        }),
    );
    const download = vi.fn(options.download ?? (async () => "C:\\OwnBase\\cloudflared.exe"));
    const created = createCloudflaredInstaller({
      dir: "C:\\OwnBase\\cloudflared",
      find: () => found,
      onChange,
      env: options.env ?? { PATH: "C:\\tools" },
      platform: options.platform ?? "win32",
      arch: options.arch ?? "x64",
      exists: options.hasWinget === false ? () => false : present(winget),
      runPackageManager,
      download,
    });
    return { installer: created, onChange, runPackageManager, download };
  }

  it("installs with winget when this computer has it, and says so while it does", async () => {
    let finish!: () => void;
    const {
      installer: subject,
      runPackageManager,
      download,
    } = installer({
      runPackageManager: () => new Promise<void>((resolve) => (finish = resolve)),
    });
    expect(subject.state()).toEqual({ via: "winget" });

    const first = subject.install();
    const second = subject.install();
    await vi.waitFor(() => expect(runPackageManager).toHaveBeenCalledTimes(1));
    expect(subject.state()).toEqual({ via: "winget", installing: true });
    expect(runPackageManager).toHaveBeenCalledWith("winget", winget, { PATH: "C:\\tools" });

    finish();
    // winget finished but its cloudflared cannot be found, so it is downloaded.
    expect(await first).toBe("C:\\OwnBase\\cloudflared.exe");
    expect(await second).toBe("C:\\OwnBase\\cloudflared.exe");
    expect(download).toHaveBeenCalledTimes(1);
    expect(subject.state()).toEqual({ via: "winget" });
  });

  it("uses what winget installed without downloading anything", async () => {
    const { installer: subject, download, onChange } = installer();
    expect(await subject.install()).toBe("C:\\winget\\cloudflared.exe");
    expect(download).not.toHaveBeenCalled();
    // Told when it started, and again when it ended.
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("downloads when winget fails, and says both when that fails too", async () => {
    const { installer: subject, download } = installer({
      runPackageManager: async () => {
        throw new Error("winget could not install cloudflared (exit code 0x8A150011).");
      },
      download: async () => {
        throw new Error("The download from GitHub stopped partway.");
      },
    });
    await expect(subject.install()).rejects.toThrow(
      "winget could not install cloudflared (exit code 0x8A150011). The download from GitHub stopped partway.",
    );
    expect(download).toHaveBeenCalledTimes(1);
    expect(subject.state()).toEqual({ via: "winget" });
  });

  it("downloads straight away without a package manager, telling each whole percent", async () => {
    const {
      installer: subject,
      onChange,
      runPackageManager,
    } = installer({
      hasWinget: false,
      download: async ({ onProgress }) => {
        for (const received of [1, 2, 50, 51, 99, 100]) onProgress?.(received, 100);
        return "C:\\OwnBase\\cloudflared.exe";
      },
    });
    const seen: unknown[] = [];
    onChange.mockImplementation(() => seen.push(subject.state()));
    expect(subject.state()).toEqual({ via: "download" });

    await subject.install();

    expect(runPackageManager).not.toHaveBeenCalled();
    expect(seen).toEqual([
      { via: "download", installing: true },
      { via: "download", installing: true, received: 1, total: 100 },
      { via: "download", installing: true, received: 2, total: 100 },
      { via: "download", installing: true, received: 50, total: 100 },
      { via: "download", installing: true, received: 51, total: 100 },
      { via: "download", installing: true, received: 99, total: 100 },
      { via: "download", installing: true, received: 100, total: 100 },
      { via: "download" },
    ]);
  });

  it("offers nothing where neither a package manager nor a release would work", () => {
    expect(installer({ hasWinget: false, platform: "freebsd" }).installer.state()).toBeNull();
  });

  it("leaves a cloudflared the app was pointed at alone", async () => {
    const { installer: subject, runPackageManager } = installer({
      env: { PATH: "C:\\tools", OWNBASE_CLOUDFLARED: "D:\\gone\\cloudflared.exe" },
    });
    expect(subject.state()).toBeNull();
    await expect(subject.install()).rejects.toThrow("OWNBASE_CLOUDFLARED names the cloudflared");
    expect(runPackageManager).not.toHaveBeenCalled();
  });
});
