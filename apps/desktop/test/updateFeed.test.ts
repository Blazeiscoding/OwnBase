import { describe, expect, it, vi } from "vitest";
import {
  DOWNLOADS,
  LATEST,
  latestOnR2,
  newerOnR2,
  readLatest,
  windowsFeed,
  type Updater,
} from "../src/main/updateFeed.js";
import { DAY_MS, Updates } from "../src/main/updates.js";

/** latest.json as the Release workflow writes it. */
function latestJson(tag = "v0.2.0-alpha.22") {
  const version = tag.slice(1);
  const files: Record<string, { url: string; size: number }> = {};
  for (const name of [
    `OwnBase-Setup-${version}.exe`,
    `OwnBase-Setup-${version}.exe.blockmap`,
    "latest.yml",
    "SHA256SUMS",
  ])
    files[name] = { url: `https://dl.ownbase.site/${tag}/${encodeURIComponent(name)}`, size: 10 };
  return { tag, files };
}

/** A fetch that answers latest.json with `body`, and remembers every URL asked for. */
function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: string, _init: RequestInit) =>
    typeof body === "string"
      ? new Response(body, { status })
      : new Response(JSON.stringify(body), { status }),
  );
}

describe("newerOnR2", () => {
  it("offers the release latest.json names when it is newer", async () => {
    const fetcher = fakeFetch(latestJson());
    const release = await newerOnR2(fetcher, "0.2.0-alpha.1");
    expect(release?.version).toBe("0.2.0-alpha.22");
    expect(release?.base).toBe("https://dl.ownbase.site/v0.2.0-alpha.22/");
    expect(release?.files["OwnBase-Setup-0.2.0-alpha.22.exe"]?.url).toBe(
      "https://dl.ownbase.site/v0.2.0-alpha.22/OwnBase-Setup-0.2.0-alpha.22.exe",
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toBe("https://dl.ownbase.site/latest.json");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });

  it("offers nothing for the same or an older version", async () => {
    expect(await newerOnR2(fakeFetch(latestJson()), "0.2.0-alpha.22")).toBeNull();
    expect(await newerOnR2(fakeFetch(latestJson()), "0.2.0-alpha.23")).toBeNull();
    expect(await newerOnR2(fakeFetch(latestJson()), "0.2.0")).toBeNull();
    expect(await latestOnR2(fakeFetch(latestJson()), "0.2.0-alpha.21")).toBe("0.2.0-alpha.22");
  });

  it("fails, so nothing is offered, when R2 is down or latest.json is not JSON", async () => {
    await expect(newerOnR2(fakeFetch("Bad gateway", 502), "0.2.0-alpha.1")).rejects.toThrow(
      `${LATEST} answered 502.`,
    );
    await expect(newerOnR2(fakeFetch("<html>"), "0.2.0-alpha.1")).rejects.toThrow(
      `${LATEST} names no version.`,
    );
    const down = vi.fn(async () => {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    });
    await expect(newerOnR2(down, "0.2.0-alpha.1")).rejects.toThrow("ERR_NAME_NOT_RESOLVED");
  });
});

describe("readLatest", () => {
  it("refuses a tag that is not a version", () => {
    for (const tag of [undefined, 22, "latest", "0.2.0", "v0.2.0/../x", "v0.2.0-alpha..1"])
      expect(() => readLatest({ ...latestJson(), tag })).toThrow("names no version");
    expect(() => readLatest(null)).toThrow("names no version");
    expect(() => readLatest({ tag: "v0.2.0" })).toThrow("lists no files");
  });

  it("refuses a file anywhere but the tag's folder on dl.ownbase.site over HTTPS", () => {
    const outside = [
      "https://github.com/Blazeiscoding/OwnBase/releases/download/v0.2.0-alpha.22/x.exe",
      "http://dl.ownbase.site/v0.2.0-alpha.22/x.exe",
      "https://dl.ownbase.site.example.com/v0.2.0-alpha.22/x.exe",
      "https://dl.ownbase.site/v0.2.0-alpha.21/x.exe",
      "https://dl.ownbase.site/v0.2.0-alpha.22/../v0.2.0-alpha.21/x.exe",
      "https://dl.ownbase.site@example.com/v0.2.0-alpha.22/x.exe",
      "not a url",
      42,
    ];
    for (const url of outside) {
      const body = latestJson();
      body.files["x.exe"] = { url: url as string, size: 1 };
      expect(() => readLatest(body), String(url)).toThrow("outside");
    }
    const sizeless = latestJson() as { tag: string; files: Record<string, unknown> };
    sizeless.files["x.exe"] = { url: `${DOWNLOADS}/v0.2.0-alpha.22/x.exe` };
    expect(() => readLatest(sizeless)).toThrow("no size");
  });
});

/** A stand-in for electron-updater's NsisUpdater that serves `feed` as latest.yml. */
function fakeUpdater(feed: { version: string; files: { url: string }[] }) {
  const updater = {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: feed })),
    downloadUpdate: vi.fn(async () => []),
    on: vi.fn(),
    off: vi.fn(),
    quitAndInstall: vi.fn(),
  };
  return { updater, make: vi.fn(async () => updater as unknown as Updater) };
}

const yml = (version = "0.2.0-alpha.22") => ({
  version,
  files: [{ url: `OwnBase-Setup-${version}.exe` }],
});

describe("windowsFeed", () => {
  it("points electron-updater at the folder of the tag latest.json names", async () => {
    const { updater, make } = fakeUpdater(yml());
    const fetcher = fakeFetch(latestJson());
    const feed = windowsFeed(() => {}, fetcher, "0.2.0-alpha.1", make);
    expect(await feed.check()).toBe("0.2.0-alpha.22");
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://dl.ownbase.site/v0.2.0-alpha.22/",
    });
    for (const [url] of fetcher.mock.calls) expect(url.startsWith(`${DOWNLOADS}/`)).toBe(true);
  });

  it("does not load electron-updater while nothing newer is on R2", async () => {
    const { make } = fakeUpdater(yml());
    const feed = windowsFeed(() => {}, fakeFetch(latestJson()), "0.2.0-alpha.22", make);
    expect(await feed.check()).toBeNull();
    expect(make).not.toHaveBeenCalled();
  });

  it("refuses a latest.yml for another version, or naming a file latest.json does not list", async () => {
    const other = windowsFeed(
      () => {},
      fakeFetch(latestJson()),
      "0.2.0-alpha.1",
      fakeUpdater(yml("0.2.0-alpha.21")).make,
    );
    await expect(other.check()).rejects.toThrow("latest.yml is for 0.2.0-alpha.21");
    for (const url of ["../OwnBase-Setup-0.2.0-alpha.22.exe", "evil.exe", "constructor"]) {
      const feed = windowsFeed(
        () => {},
        fakeFetch(latestJson()),
        "0.2.0-alpha.1",
        fakeUpdater({ version: "0.2.0-alpha.22", files: [{ url }] }).make,
      );
      await expect(feed.check(), url).rejects.toThrow("which is not there");
    }
  });

  it("offers no update, and logs why, when latest.json is wrong", async () => {
    const log = vi.fn();
    const { make } = fakeUpdater(yml());
    const body = latestJson();
    body.files["OwnBase-Setup-0.2.0-alpha.22.exe"]!.url =
      "https://github.com/Blazeiscoding/OwnBase/releases/download/v0.2.0-alpha.22/OwnBase-Setup-0.2.0-alpha.22.exe";
    const updates = new Updates({
      mode: "install",
      version: "0.2.0-alpha.1",
      now: () => 10 * DAY_MS,
      settings: { get: async () => undefined, set: async () => {} },
      feed: windowsFeed(log, fakeFetch(body), "0.2.0-alpha.1", make),
      hosting: () => ({ running: false }),
      install: vi.fn(),
      onChange: () => {},
      log,
    });
    await updates.load();
    const status = await updates.check();
    expect(status.newVersion).toBeUndefined();
    expect(make).not.toHaveBeenCalled();
    const [message, error] = log.mock.calls.at(-1)!;
    expect(message).toContain("could not check");
    expect(String(error)).toContain(`${LATEST} lists OwnBase-Setup-0.2.0-alpha.22.exe outside`);
  });
});
