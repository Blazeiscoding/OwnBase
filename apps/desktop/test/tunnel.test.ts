import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findCloudflared,
  ownBaseIsReachable,
  openConfiguredAddress,
  openNamedTunnel,
  openQuickTunnel,
  probeHealth,
  readNamedTunnelConfig,
  resolvePublicAddress,
  validateNamedTunnelConfig,
  TunnelCleanupError,
  type Tunnel,
} from "../src/main/tunnel.js";

const fake = resolve(import.meta.dirname, "../../../tests/fixtures/fake-cloudflared.mjs");
const healthy = async () => true;

/** Starts the stand-in cloudflared the way the app starts the real one, in a chosen mode. */
function launchAs(mode: string, extra: Record<string, string> = {}) {
  return (_command: string, args: string[]) =>
    spawn(process.execPath, [fake, ...args], {
      env: { ...process.env, FAKE_CLOUDFLARED_MODE: mode, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
}

/** A token file the tests point at; its contents are never read by the app. */
const workdir = mkdtempSync(join(tmpdir(), "ownbase-named-tunnel-"));
const tokenFile = join(workdir, "tunnel-token.txt");
writeFileSync(tokenFile, "eyJhIjoiSECRETtoken");
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

const opened: Tunnel[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const tunnel of opened.splice(0)) await tunnel.close();
});

async function serve(handler: RequestListener): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

it("returns cleanup ownership when opening fails and the child cannot be confirmed stopped", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  try {
    const opening = openQuickTunnel({
      command: "fake-cloudflared",
      port: 8543,
      timeoutMs: 10,
      launch: () => child as unknown as ChildProcess,
    });
    const result = opening.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_010);
    const failure = await result;
    expect(failure).toBeInstanceOf(TunnelCleanupError);
    expect((failure as Error).message).toContain("cloudflared did not stop");
    expect(child.kill.mock.calls).toEqual([[], ["SIGKILL"]]);
    // An eventual exit can be confirmed by the retained handle, without launching another child.
    child.emit("exit", 0, null);
    await (failure as TunnelCleanupError).tunnel.close();
    expect(child.kill).toHaveBeenCalledTimes(2);
  } finally {
    child.emit("exit", 0, null);
    child.stdout.destroy();
    child.stderr.destroy();
    vi.useRealTimers();
  }
});

describe("finding cloudflared", () => {
  const present =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);

  it("takes a path configured for the app, and nothing else when that is missing", () => {
    const env = { OWNBASE_CLOUDFLARED: "D:\\tools\\cloudflared.exe", PATH: "C:\\bin" };
    expect(findCloudflared(env, present("D:\\tools\\cloudflared.exe"), "win32")).toBe(
      "D:\\tools\\cloudflared.exe",
    );
    expect(findCloudflared(env, present(join("C:\\bin", "cloudflared.exe")), "win32")).toBeNull();
  });

  it("looks on PATH first, then where the Windows installer and winget put it", () => {
    const env = {
      PATH: "C:\\bin;C:\\tools",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local",
    };
    const installer = join("C:\\Program Files (x86)", "cloudflared", "cloudflared.exe");
    const winget = join(
      "C:\\Users\\sam\\AppData\\Local",
      "Microsoft",
      "WinGet",
      "Links",
      "cloudflared.exe",
    );
    const onPath = join("C:\\tools", "cloudflared.exe");
    expect(findCloudflared(env, present(installer, winget, onPath), "win32")).toBe(onPath);
    expect(findCloudflared(env, present(installer, winget), "win32")).toBe(installer);
    expect(findCloudflared(env, present(winget), "win32")).toBe(winget);
    expect(findCloudflared(env, present(), "win32")).toBeNull();
  });

  it("finds winget's package folder where it made no link, and OwnBase's own download last", () => {
    const env = { PATH: "C:\\bin", LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" };
    const packaged = join(
      "C:\\Users\\sam\\AppData\\Local",
      "Microsoft",
      "WinGet",
      "Packages",
      "Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe",
      "cloudflared.exe",
    );
    const downloaded = join("C:\\Users\\sam\\AppData\\Roaming\\OwnBase", "cloudflared.exe");
    expect(findCloudflared(env, present(packaged, downloaded), "win32", downloaded)).toBe(packaged);
    expect(findCloudflared(env, present(downloaded), "win32", downloaded)).toBe(downloaded);
    expect(findCloudflared(env, present(downloaded), "win32")).toBeNull();
  });

  it("looks where Homebrew puts it on Linux", () => {
    expect(
      findCloudflared(
        { PATH: "/usr/bin" },
        present("/home/linuxbrew/.linuxbrew/bin/cloudflared"),
        "linux",
      ),
    ).toBe("/home/linuxbrew/.linuxbrew/bin/cloudflared");
  });
});

describe("checking the public workspace identity", () => {
  it("uses a fresh nonce without caching or redirects and requires the exact running instance", async () => {
    const requested: string[] = [];
    const endpoint = await serve((request, response) => {
      requested.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", instanceId: "workspace-run-1" }));
    });
    const actualFetch = globalThis.fetch;
    const options: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      options.push(init ?? {});
      return actualFetch(input, init);
    });
    try {
      const health = `${endpoint.url}/api/health`;
      expect(await ownBaseIsReachable(health, new AbortController().signal, "another-run")).toBe(
        false,
      );
      expect(
        await ownBaseIsReachable(health, new AbortController().signal, "workspace-run-1"),
      ).toBe(true);
      expect(options).toHaveLength(2);
      for (const option of options) {
        expect(option.cache).toBe("no-store");
        expect(option.redirect).toBe("error");
        expect(option.headers).toEqual({ accept: "application/json" });
      }
      const nonces = requested.map((value) =>
        new URL(value, endpoint.url).searchParams.get("_ownbase"),
      );
      expect(nonces[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(nonces[1]).toMatch(/^[0-9a-f-]{36}$/);
      expect(nonces[1]).not.toBe(nonces[0]);
    } finally {
      await endpoint.close();
    }
  });

  it("refuses redirects even when their destination has a valid health response", async () => {
    const endpoint = await serve((request, response) => {
      if (request.url?.startsWith("/api/health")) {
        response.writeHead(302, { location: "/other" });
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", instanceId: "workspace-run-1" }));
    });
    try {
      expect(
        await ownBaseIsReachable(
          `${endpoint.url}/api/health`,
          new AbortController().signal,
          "workspace-run-1",
        ),
      ).toBe(false);
    } finally {
      await endpoint.close();
    }
  });

  it("refuses malformed and oversized health documents", async () => {
    let request = 0;
    const endpoint = await serve((_incoming, response) => {
      response.setHeader("content-type", "application/json");
      if (request++ === 0) {
        response.end("{");
        return;
      }
      // Chunked whitespace keeps Content-Length absent and would still be
      // valid JSON without the response-size limit.
      response.write(" ".repeat(5_000));
      response.end(JSON.stringify({ status: "ok", instanceId: "workspace-run-1" }));
    });
    try {
      const health = `${endpoint.url}/api/health`;
      expect(
        await ownBaseIsReachable(health, new AbortController().signal, "workspace-run-1"),
      ).toBe(false);
      expect(
        await ownBaseIsReachable(health, new AbortController().signal, "workspace-run-1"),
      ).toBe(false);
    } finally {
      await endpoint.close();
    }
  });

  it("separates an address that leads elsewhere from one that leads nowhere", async () => {
    const endpoint = await serve((request, response) => {
      if (request.url?.startsWith("/api/health")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "ok", instanceId: "workspace-run-1" }));
        return;
      }
      response.end("not the workspace");
    });
    const health = `${endpoint.url}/api/health`;
    const signal = () => new AbortController().signal;
    try {
      expect(await probeHealth(health, signal(), "workspace-run-1")).toBe("this-workspace");
      // Answering, but as another run and then as another program entirely.
      expect(await probeHealth(health, signal(), "a-different-run")).toBe("something-else");
      expect(await probeHealth(`${endpoint.url}/elsewhere`, signal(), "workspace-run-1")).toBe(
        "something-else",
      );
    } finally {
      await endpoint.close();
    }

    // Nothing is listening now. That says nothing about who owns the port, so
    // a caller must be able to stay quiet rather than name a program.
    expect(await probeHealth(health, signal(), "workspace-run-1")).toBe("no-answer");
    expect(await ownBaseIsReachable(health, signal(), "workspace-run-1")).toBe(false);
  });
});

describe("opening a quick tunnel", () => {
  it("resolves with the address once a connection has registered, pointed at the workspace's port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ownbase-tunnel-"));
    try {
      const argsFile = join(dir, "args.json");
      const tunnel = await openQuickTunnel({
        command: "cloudflared",
        port: 8543,
        launch: launchAs("open", { FAKE_CLOUDFLARED_ARGS: argsFile }),
        healthProbe: healthy,
      });
      opened.push(tunnel);
      expect(tunnel.url).toBe("https://fake-open-to-all.trycloudflare.com");
      const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
      expect(args[0]).toBe("tunnel");
      expect(args[1]).toBe("--config");
      expect(args[2]).toMatch(/ownbase-cloudflared-.+[\\/]config\.yml$/);
      expect(args.slice(3)).toEqual(["--no-autoupdate", "--url", "http://127.0.0.1:8543"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs a script standing in for cloudflared with the app's own executable", async () => {
    const tunnel = await openQuickTunnel({ command: fake, port: 8543, healthProbe: healthy });
    opened.push(tunnel);
    expect(tunnel.url).toBe("https://fake-open-to-all.trycloudflare.com");
  });

  it("does not expose the address until OwnBase answers through Cloudflare", async () => {
    let makeHealthy!: () => void;
    const ready = new Promise<void>((resolve) => {
      makeHealthy = resolve;
    });
    const probes: string[] = [];
    let openedYet = false;
    const opening = openQuickTunnel({
      command: "cloudflared",
      port: 8543,
      launch: launchAs("open"),
      healthProbe: async (url) => {
        probes.push(url);
        await ready;
        return true;
      },
    }).then((tunnel) => {
      openedYet = true;
      return tunnel;
    });
    await expect
      .poll(() => probes)
      .toEqual(["https://fake-open-to-all.trycloudflare.com/api/health"]);
    expect(openedYet).toBe(false);
    makeHealthy();
    const tunnel = await opening;
    opened.push(tunnel);
    expect(openedYet).toBe(true);
  });

  it("says why when Cloudflare refuses the tunnel", async () => {
    await expect(
      openQuickTunnel({ command: "cloudflared", port: 8543, launch: launchAs("refused") }),
    ).rejects.toThrow(
      "Cloudflare could not open a link: failed to request quick Tunnel: 429 Too Many Requests",
    );
  });

  it("gives up, and ends cloudflared, when the address never becomes reachable", async () => {
    let child: ReturnType<ReturnType<typeof launchAs>> | undefined;
    const launch = launchAs("no-connect");
    await expect(
      openQuickTunnel({
        command: "cloudflared",
        port: 8543,
        timeoutMs: 1500,
        launch: (command, args) => (child = launch(command, args)),
      }),
    ).rejects.toThrow(/gave this workspace an address, but it did not become reachable/);
    await expect.poll(() => child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  });

  it("says so when cloudflared cannot be started at all", async () => {
    await expect(
      openQuickTunnel({ command: join(tmpdir(), "no-such-cloudflared.exe"), port: 8543 }),
    ).rejects.toThrow(/cloudflared could not be started/);
  });

  it("reports a tunnel that ends on its own, and not one it was asked to close", async () => {
    const dropped = await openQuickTunnel({
      command: "cloudflared",
      port: 8543,
      launch: launchAs("drop"),
      healthProbe: healthy,
    });
    const reasons: string[] = [];
    await new Promise((resolve) => setTimeout(resolve, 300));
    dropped.onUnexpectedExit((reason) => reasons.push(reason));
    await expect.poll(() => reasons).toEqual(["the tunnel was closed by the test"]);

    const closed = await openQuickTunnel({
      command: "cloudflared",
      port: 8543,
      launch: launchAs("open"),
      healthProbe: healthy,
    });
    const quiet: string[] = [];
    closed.onUnexpectedExit((reason) => quiet.push(reason));
    await closed.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(quiet).toEqual([]);
  });
});

describe("a stable address configured for this app", () => {
  it("accepts a plain public https origin with an absolute token file", () => {
    expect(validateNamedTunnelConfig("https://chat.example.org", tokenFile)).toEqual({
      publicUrl: "https://chat.example.org",
      tokenFile,
    });
  });

  it("refuses anything but a public address the workspace can be published at", () => {
    for (const address of [
      "http://chat.example.org",
      "https://chat.example.org/team",
      "https://sam:pass@chat.example.org",
      "https://chat.example.org?ref=1",
      "https://chat.example.org#top",
      "https://chat.example.org ",
      "https://localhost",
      "https://ownbase",
      "https://chat.example.local",
      "https://office.internal",
      "https://192.0.2.10",
      "https://[2001:db8::1]",
      42,
    ])
      expect(() => validateNamedTunnelConfig(address, tokenFile)).toThrow(/public HTTPS hostname/);
  });

  it("refuses a token file that is not an absolute path", () => {
    for (const file of ["tunnel-token.txt", "", resolve(`token\u0000.txt`), 7])
      expect(() => validateNamedTunnelConfig("https://chat.example.org", file)).toThrow(
        /absolute path/,
      );
  });
});

describe("reading the configured stable address", () => {
  const present =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);

  it("is absent until one of its settings is present", () => {
    expect(readNamedTunnelConfig({}, present())).toBeNull();
    expect(readNamedTunnelConfig({ OWNBASE_TUNNEL_URL: "" }, present())).toBeNull();
  });

  it("takes both settings together", () => {
    const expected = { publicUrl: "https://chat.example.org", tokenFile };
    expect(
      readNamedTunnelConfig(
        {
          OWNBASE_TUNNEL_URL: "https://chat.example.org",
          OWNBASE_TUNNEL_TOKEN_FILE: tokenFile,
        },
        present(tokenFile),
      ),
    ).toEqual(expected);
  });

  it("explains a half-configured pair rather than quietly opening a temporary address", () => {
    expect(
      readNamedTunnelConfig({ OWNBASE_TUNNEL_URL: "https://chat.example.org" }, present()),
    ).toEqual({ error: expect.stringMatching(/Set both/) });
    expect(
      readNamedTunnelConfig({ OWNBASE_TUNNEL_TOKEN_FILE: tokenFile }, present(tokenFile)),
    ).toEqual({ error: expect.stringMatching(/Set both/) });
  });

  it("reports a token file that is not there, and an address that cannot be used", () => {
    expect(
      readNamedTunnelConfig(
        {
          OWNBASE_TUNNEL_URL: "https://chat.example.org",
          OWNBASE_TUNNEL_TOKEN_FILE: tokenFile,
        },
        present(),
      ),
    ).toEqual({ error: expect.stringMatching(/token file is not where/) });
    expect(
      readNamedTunnelConfig(
        {
          OWNBASE_TUNNEL_URL: "http://chat.example.org",
          OWNBASE_TUNNEL_TOKEN_FILE: tokenFile,
        },
        present(tokenFile),
      ),
    ).toEqual({ error: expect.stringMatching(/public HTTPS hostname/) });
  });
});

describe("opening a configured stable tunnel", () => {
  const publicUrl = "https://chat.example.org";

  it("runs the saved connector from its token file at the configured address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ownbase-tunnel-"));
    try {
      const argsFile = join(dir, "args.json");
      const tunnel = await openNamedTunnel({
        command: "cloudflared",
        port: 8543,
        publicUrl,
        tokenFile,
        instanceId: "workspace-run-1",
        launch: launchAs("named", { FAKE_CLOUDFLARED_ARGS: argsFile }),
        healthProbe: healthy,
      });
      opened.push(tunnel);
      expect(tunnel.url).toBe(publicUrl);
      const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
      expect(args[0]).toBe("tunnel");
      expect(args[2]).toMatch(/ownbase-cloudflared-.+[\\/]config\.yml$/);
      // The token stays a file cloudflared reads; the app never handles it.
      expect(args.slice(3)).toEqual(["--no-autoupdate", "run", "--token-file", tokenFile]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for this workspace, rather than another, to answer at that address", async () => {
    const probes: { url: string; instanceId?: string }[] = [];
    const tunnel = await openNamedTunnel({
      command: "cloudflared",
      port: 8543,
      publicUrl,
      tokenFile,
      instanceId: "workspace-run-1",
      launch: launchAs("named"),
      healthProbe: async (url, _signal, instanceId) => {
        probes.push({ url, instanceId });
        return instanceId === "workspace-run-1";
      },
    });
    opened.push(tunnel);
    expect(probes).toEqual([
      { url: "https://chat.example.org/api/health", instanceId: "workspace-run-1" },
    ]);
  });

  it("says which route to correct when the address reaches something else", async () => {
    await expect(
      openNamedTunnel({
        command: "cloudflared",
        port: 8543,
        publicUrl,
        tokenFile,
        instanceId: "workspace-run-1",
        timeoutMs: 1000,
        launch: launchAs("named"),
        healthProbe: async () => false,
      }),
    ).rejects.toThrow(/point its published application route to http:\/\/127\.0\.0\.1:8543/);
  });

  it("keeps the connector's own output, which can quote its token, out of what it reports", async () => {
    const failure = await openNamedTunnel({
      command: "cloudflared",
      port: 8543,
      publicUrl,
      tokenFile,
      instanceId: "workspace-run-1",
      launch: launchAs("token-bad", { FAKE_CLOUDFLARED_TOKEN: "eyJhIjoiSECRETtoken" }),
      healthProbe: healthy,
    }).then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(failure?.message).toMatch(/Cloudflare could not connect the saved tunnel/);
    expect(failure?.message).not.toMatch(/SECRET/);
  });

  it("refuses configuration it cannot use before starting a connector", async () => {
    let started = false;
    const launch = () => {
      started = true;
      throw new Error("no connector should be started");
    };
    const base = { command: "cloudflared", port: 8543, publicUrl, tokenFile, launch };
    await expect(
      openNamedTunnel({ ...base, publicUrl: "http://chat.example.org", instanceId: "run" }),
    ).rejects.toThrow(/public HTTPS hostname/);
    await expect(openNamedTunnel({ ...base, port: 70000, instanceId: "run" })).rejects.toThrow(
      /valid listening port/,
    );
    await expect(openNamedTunnel({ ...base, instanceId: "" })).rejects.toThrow(
      /cannot verify its public address/,
    );
    expect(started).toBe(false);
  });
});

describe("choosing which stable address to publish", () => {
  const present =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);
  const named = {
    OWNBASE_TUNNEL_URL: "https://chat.example.org",
    OWNBASE_TUNNEL_TOKEN_FILE: tokenFile,
  };

  it("is absent when nothing is configured anywhere", () => {
    expect(resolvePublicAddress(null, {}, present())).toBeNull();
    expect(resolvePublicAddress("   ", {}, present())).toBeNull();
  });

  it("takes a saved address over one left in the environment", () => {
    const saved = resolvePublicAddress(
      "  https://box.tail1234.ts.net  ",
      { ...named, OWNBASE_PUBLIC_URL: "https://stale.example.org" },
      present(tokenFile),
    );
    expect(saved).toEqual({ carrier: "elsewhere", publicUrl: "https://box.tail1234.ts.net" });
  });

  it("takes an address from the environment when none is saved", () => {
    expect(
      resolvePublicAddress(null, { OWNBASE_PUBLIC_URL: "https://box.tail1234.ts.net" }, present()),
    ).toEqual({ carrier: "elsewhere", publicUrl: "https://box.tail1234.ts.net" });
  });

  it("falls back to the tunnel OwnBase runs itself", () => {
    expect(resolvePublicAddress(null, named, present(tokenFile))).toEqual({
      carrier: "ownbase",
      publicUrl: "https://chat.example.org",
      tokenFile,
    });
  });

  it("reports a saved address that cannot be published, rather than ignoring it", () => {
    expect(resolvePublicAddress("http://box.tail1234.ts.net", named, present(tokenFile))).toEqual({
      error: expect.stringMatching(/public HTTPS hostname/),
    });
    expect(resolvePublicAddress(42, {}, present())).toEqual({
      error: expect.stringMatching(/public HTTPS hostname/),
    });
  });
});

describe("publishing an address something else carries", () => {
  const funnel = "https://box.tail1234.ts.net";

  it("publishes it once it answers as this workspace, starting nothing", async () => {
    const probes: { url: string; instanceId?: string }[] = [];
    const tunnel = await openConfiguredAddress({
      publicUrl: funnel,
      port: 8543,
      instanceId: "workspace-run-1",
      healthProbe: async (url, _signal, instanceId) => {
        probes.push({ url, instanceId });
        return instanceId === "workspace-run-1";
      },
    });
    opened.push(tunnel);
    expect(tunnel.url).toBe(funnel);
    expect(probes).toEqual([
      { url: "https://box.tail1234.ts.net/api/health", instanceId: "workspace-run-1" },
    ]);
  });

  it("says what to check when the address never answers", async () => {
    await expect(
      openConfiguredAddress({
        publicUrl: funnel,
        port: 8543,
        instanceId: "workspace-run-1",
        timeoutMs: 200,
        healthProbe: async () => false,
      }),
    ).rejects.toThrow(/did not answer as this workspace.+http:\/\/127\.0\.0\.1:8543/s);
  });

  it("refuses what it cannot publish before waiting on anything", async () => {
    const base = {
      publicUrl: funnel,
      port: 8543,
      instanceId: "run",
      healthProbe: async () => true,
    };
    await expect(
      openConfiguredAddress({ ...base, publicUrl: "http://box.tail1234.ts.net" }),
    ).rejects.toThrow(/public HTTPS hostname/);
    await expect(openConfiguredAddress({ ...base, port: 0 })).rejects.toThrow(
      /valid listening port/,
    );
    await expect(openConfiguredAddress({ ...base, instanceId: "" })).rejects.toThrow(
      /cannot verify its public address/,
    );
  });

  it("gives the address up only after consecutive failures, resetting after a recovery", async () => {
    const answers = [true, false, false, true, false, false, false];
    const checks: boolean[] = [];
    const tunnel = await openConfiguredAddress({
      publicUrl: funnel,
      port: 8543,
      instanceId: "workspace-run-1",
      pollMs: 5,
      tolerance: 3,
      healthProbe: async () => {
        const healthy = answers.shift() ?? true;
        checks.push(healthy);
        return healthy;
      },
    });
    opened.push(tunnel);
    const reasons: string[] = [];
    tunnel.onUnexpectedExit((reason) => reasons.push(reason));

    await expect.poll(() => reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/stopped answering as this workspace/);
    expect(checks.slice(0, 7)).toEqual([true, false, false, true, false, false, false]);
  });
});
