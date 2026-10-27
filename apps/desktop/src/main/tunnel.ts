import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Where to find Cloudflare's cloudflared: a path set for this app, then PATH,
 * then where its Windows installer and winget put it, then the usual package
 * manager folders elsewhere. Null when it is not installed.
 */
export function findCloudflared(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const configured = env.OWNBASE_CLOUDFLARED;
  if (configured) return exists(configured) ? configured : null;
  const windows = platform === "win32";
  const file = windows ? "cloudflared.exe" : "cloudflared";
  const candidates = (env.PATH ?? env.Path ?? "")
    .split(windows ? ";" : ":")
    .filter(Boolean)
    .map((dir) => join(dir, file));
  if (windows) {
    for (const root of [env["ProgramFiles(x86)"], env.ProgramFiles]) {
      if (root) candidates.push(join(root, "cloudflared", file));
    }
    if (env.LOCALAPPDATA)
      candidates.push(join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", file));
  } else {
    candidates.push(
      "/opt/homebrew/bin/cloudflared",
      "/usr/local/bin/cloudflared",
      "/usr/bin/cloudflared",
    );
  }
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** A workspace reachable from the internet, for as long as the tunnel lasts. */
export interface Tunnel {
  /** The https address anyone can reach the workspace at. */
  url: string;
  /** Ends the tunnel. Resolves once cloudflared has exited. */
  close(): Promise<void>;
  /** Called once, if the tunnel ends without being asked to. */
  onUnexpectedExit(listener: (reason: string) => void): void;
}

/** Opening failed, but its connector is still owned until a later close succeeds (N12). */
export class TunnelCleanupError extends Error {
  constructor(
    message: string,
    readonly tunnel: Tunnel,
  ) {
    super(message);
    this.name = "TunnelCleanupError";
  }
}

/** The address a quick tunnel prints once Cloudflare has handed one out. */
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
/** Printed once Cloudflare's edge can reach the tunnel, so the address works. */
const CONNECTED = /Registered tunnel connection/;

function launch(command: string, args: string[]): ChildProcess {
  // The desktop owns this connector's configuration. A shell used for a
  // different tunnel must not silently supply its token, origin, or routing.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^TUNNEL_/i.test(name)),
  );
  // A script stands in for cloudflared in tests. The app's own executable
  // runs it as Node, so no separate Node install is needed.
  if (/\.[cm]?js$/.test(command)) {
    return spawn(process.execPath, [command, ...args], {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  return spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

/** The line cloudflared gave up on, shortened to something worth showing. */
function lastComplaint(lines: string[]): string | null {
  const line = [...lines]
    .reverse()
    .find(
      (text) =>
        /\b(ERR|error|failed)\b/i.test(text) && !/Configuration file .* was empty/i.test(text),
    );
  if (!line) return null;
  const quoted = line.match(/error="([^"]+)"/)?.[1];
  const text = (quoted ?? line.replace(/^\S+\s+(ERR|INF|WRN)\s+/, "")).trim();
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

const MAX_HEALTH_RESPONSE_BYTES = 4 * 1024;

/** Read only the small JSON document the health endpoint is expected to return. */
async function readHealthResponse(response: Response): Promise<string | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HEALTH_RESPONSE_BYTES) return null;
  if (!response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HEALTH_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The response already failed; cancellation is only best-effort cleanup.
    }
    return null;
  } finally {
    reader.releaseLock();
  }
}

/**
 * What answered, for callers that must tell an address leading somewhere else
 * from one that leads nowhere. "no-answer" covers a refused connection, a
 * timeout, and a redirect, since none of them show who holds the address.
 */
export type HealthAnswer = "this-workspace" | "something-else" | "no-answer";

export async function probeHealth(
  url: string,
  signal: AbortSignal,
  instanceId?: string,
): Promise<HealthAnswer> {
  let response: Response;
  try {
    const address = new URL(url);
    address.searchParams.set("_ownbase", randomUUID());
    response = await fetch(address, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
    });
  } catch {
    return "no-answer";
  }
  // Past here something is listening and replied, so a reply that is not this
  // run means the address reaches another program.
  try {
    if (!response.ok) return "something-else";
    const text = await readHealthResponse(response);
    if (text === null) return "something-else";
    const body = JSON.parse(text) as { status?: unknown; instanceId?: unknown } | null;
    return body?.status === "ok" && (instanceId === undefined || body.instanceId === instanceId)
      ? "this-workspace"
      : "something-else";
  } catch {
    return "something-else";
  }
}

export async function ownBaseIsReachable(
  url: string,
  signal: AbortSignal,
  instanceId?: string,
): Promise<boolean> {
  return (await probeHealth(url, signal, instanceId)) === "this-workspace";
}

/**
 * The address a workspace may be published at, reduced to its origin. Anything
 * that is not a plain public HTTPS hostname is refused, whoever carries the
 * traffic to it.
 */
export function validatePublicAddress(publicUrl: unknown): string {
  try {
    if (typeof publicUrl !== "string" || /\s|\\/.test(publicUrl)) throw new Error();
    const url = new URL(publicUrl);
    const hostname = url.hostname;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      isIP(hostname.replace(/^\[|\]$/g, "")) ||
      !hostname.includes(".") ||
      /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(hostname) ||
      hostname.length > 253 ||
      hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error("Use a public HTTPS hostname without a path, credentials, query, or fragment.");
  }
}

/** Validates configuration without reading the file or including its contents in errors. */
export function validateNamedTunnelConfig(
  publicUrl: unknown,
  tokenFile: unknown,
): { publicUrl: string; tokenFile: string } {
  const origin = validatePublicAddress(publicUrl);
  if (
    typeof tokenFile !== "string" ||
    !tokenFile ||
    /[\x00-\x1f\x7f]/.test(tokenFile) ||
    !isAbsolute(tokenFile)
  )
    throw new Error("Choose an absolute path to the Cloudflare tunnel token file.");
  return { publicUrl: origin, tokenFile };
}

/**
 * The stable public address configured for this app: both settings together,
 * or what is wrong with them. A half-configured pair is an error rather than
 * a quiet fall back to a temporary address, which would publish a different
 * link than the one its owner handed out.
 */
export function readNamedTunnelConfig(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): { publicUrl: string; tokenFile: string } | { error: string } | null {
  const publicUrl = env.OWNBASE_TUNNEL_URL;
  const tokenFile = env.OWNBASE_TUNNEL_TOKEN_FILE;
  if (!publicUrl && !tokenFile) return null;
  try {
    if (!publicUrl || !tokenFile)
      throw new Error(
        "Set both OWNBASE_TUNNEL_URL and OWNBASE_TUNNEL_TOKEN_FILE to publish a stable address.",
      );
    const config = validateNamedTunnelConfig(publicUrl, tokenFile);
    // The file is never read here. Only its presence is checked, so a missing
    // one is corrected before opening rather than reported as a tunnel failure.
    if (!exists(config.tokenFile))
      throw new Error(
        "The Cloudflare tunnel token file is not where OWNBASE_TUNNEL_TOKEN_FILE points.",
      );
    return config;
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** How a workspace reaches the internet at an address that does not change. */
export type PublicAddressConfig =
  /** OwnBase runs Cloudflare's connector for it. */
  | { carrier: "ownbase"; publicUrl: string; tokenFile: string }
  /** Something else already carries it here: a funnel, a proxy, a tunnel run by hand. */
  | { carrier: "elsewhere"; publicUrl: string }
  | { error: string }
  | null;

/**
 * Which stable address to publish, and who carries it. A saved address comes
 * first: someone typed it into this app and can see it there, so an
 * environment variable left over from a script must not quietly beat it.
 */
export function resolvePublicAddress(
  saved: unknown,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): PublicAddressConfig {
  const configured = typeof saved === "string" ? saved.trim() : saved;
  const carried =
    configured !== undefined && configured !== null && configured !== ""
      ? configured
      : env.OWNBASE_PUBLIC_URL;
  if (carried) {
    try {
      return { carrier: "elsewhere", publicUrl: validatePublicAddress(carried) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }
  const named = readNamedTunnelConfig(env, exists);
  if (!named || "error" in named) return named;
  return { carrier: "ownbase", ...named };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Opens a Cloudflare quick tunnel to a port on this computer: no account and
 * nothing to configure, and a new https address each time. Resolves once the
 * address is reachable rather than when it is first printed, since Cloudflare
 * answers with an error page until a connection has registered.
 */
interface TunnelOptions {
  command: string;
  port: number;
  timeoutMs?: number;
  /** Lets a newly provisioned hostname reach DNS before the first lookup can be cached as missing. */
  dnsWarmupMs?: number;
  /** Gives up on opening, ending cloudflared, when aborted. */
  signal?: AbortSignal;
  /** Confirms that the public hostname reaches this running server, not another workspace. */
  instanceId?: string;
  launch?: (command: string, args: string[]) => ChildProcess;
  /** Replaced in tests; the default checks OwnBase's health endpoint through Cloudflare. */
  healthProbe?: (url: string, signal: AbortSignal, instanceId?: string) => Promise<boolean>;
}

export function openQuickTunnel(options: TunnelOptions): Promise<Tunnel> {
  return openTunnel(options);
}

/** Connects an existing, remotely managed tunnel without handling its token contents. */
export async function openNamedTunnel(
  options: TunnelOptions & { publicUrl: string; tokenFile: string; instanceId: string },
): Promise<Tunnel> {
  const config = validateNamedTunnelConfig(options.publicUrl, options.tokenFile);
  validateHostedPort(options.port);
  validateInstanceId(options.instanceId);
  return openTunnel(options, config);
}

/** Checks the workspace's own port, so a stale address cannot look reachable. */
function validateHostedPort(port: unknown): void {
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535)
    throw new Error("The hosted workspace must have a valid listening port.");
}

function validateInstanceId(instanceId: unknown): void {
  if (
    typeof instanceId !== "string" ||
    !instanceId ||
    instanceId.length > 200 ||
    /\s|\p{Cc}/u.test(instanceId)
  )
    throw new Error("The hosted workspace cannot verify its public address. Restart hosting.");
}

/**
 * Publishes an address something else already carries to this workspace: a
 * Tailscale Funnel, a reverse proxy, a tunnel started by hand. OwnBase runs
 * no connector here, so there is no process to watch. It watches the address
 * instead, and gives it up once it stops answering as this workspace.
 */
export async function openConfiguredAddress(options: {
  publicUrl: string;
  port: number;
  instanceId: string;
  /** How long the address has to answer before opening gives up. */
  timeoutMs?: number;
  /** How often an open address is confirmed to still reach this workspace. */
  pollMs?: number;
  /** Checks that may fail in a row before the address is given up. */
  tolerance?: number;
  signal?: AbortSignal;
  healthProbe?: (url: string, signal: AbortSignal, instanceId?: string) => Promise<boolean>;
}): Promise<Tunnel> {
  const address = validatePublicAddress(options.publicUrl);
  validateHostedPort(options.port);
  validateInstanceId(options.instanceId);
  if (options.signal?.aborted) throw new Error("Opening to all was cancelled.");

  const probe = options.healthProbe ?? ownBaseIsReachable;
  const health = `${address}/api/health`;
  // A blip on the way to Cloudflare or Tailscale must not invalidate everyone's
  // links, so an open address is given up only after several checks in a row.
  const pollMs = options.pollMs ?? 30_000;
  const tolerance = options.tolerance ?? 3;
  const lifecycle = new AbortController();
  const onAbort = () => lifecycle.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const reachable = async () => {
    try {
      return await probe(health, lifecycle.signal, options.instanceId);
    } catch {
      return false;
    }
  };

  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  try {
    for (;;) {
      if (options.signal?.aborted) throw new Error("Opening to all was cancelled.");
      if (await reachable()) break;
      if (options.signal?.aborted) throw new Error("Opening to all was cancelled.");
      if (Date.now() >= deadline)
        throw new Error(
          `${address} did not answer as this workspace. Check that whatever carries it is running and sending it to http://127.0.0.1:${options.port}.`,
        );
      await wait(1_000, lifecycle.signal);
    }
  } catch (error) {
    options.signal?.removeEventListener("abort", onAbort);
    lifecycle.abort();
    throw error;
  }

  // The address is this workspace's now. A later abort belongs to closing,
  // which calls close(), so it must not read as the address having failed.
  options.signal?.removeEventListener("abort", onAbort);
  const listeners: ((reason: string) => void)[] = [];
  let unexpectedReason: string | null = null;
  let stopped = false;
  let misses = 0;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    lifecycle.abort();
  };
  const timer = setInterval(() => {
    void (async () => {
      if (stopped || (await reachable())) {
        misses = 0;
        return;
      }
      if (stopped || ++misses < tolerance) return;
      stop();
      unexpectedReason = `${address} stopped answering as this workspace`;
      for (const listener of listeners.splice(0)) listener(unexpectedReason);
    })();
  }, pollMs);
  timer.unref?.();

  return {
    url: address,
    close: async () => stop(),
    onUnexpectedExit: (listener) => {
      if (unexpectedReason) queueMicrotask(() => listener(unexpectedReason!));
      else if (!stopped) listeners.push(listener);
    },
  };
}

function openTunnel(
  options: TunnelOptions,
  named?: { publicUrl: string; tokenFile: string },
): Promise<Tunnel> {
  if (options.signal?.aborted) return Promise.reject(new Error("Opening to all was cancelled."));
  const timeoutMs = options.timeoutMs ?? 75_000;
  const namedFailure =
    "Cloudflare could not connect the saved tunnel. Check its token file, your internet connection, and that cloudflared is version 2025.4.0 or later.";
  // An existing ~/.cloudflared/config.yml disables Quick Tunnels. Give this
  // child an isolated, harmless config so a named-tunnel setup cannot change
  // what the desktop button does.
  let configDir: string;
  try {
    configDir = mkdtempSync(join(tmpdir(), "ownbase-cloudflared-"));
  } catch {
    return Promise.reject(new Error("Could not create a temporary Cloudflare configuration."));
  }
  const configFile = join(configDir, "config.yml");
  let configCleaned = false;
  const cleanupConfig = () => {
    if (configCleaned) return;
    configCleaned = true;
    try {
      rmSync(configDir, { recursive: true, force: true });
    } catch {
      // The operating system can clean a one-line temporary config later.
    }
  };
  try {
    writeFileSync(configFile, "no-autoupdate: true\n", { mode: 0o600 });
  } catch {
    cleanupConfig();
    return Promise.reject(new Error("Could not write the temporary Cloudflare configuration."));
  }
  let child: ChildProcess;
  try {
    child = (options.launch ?? launch)(options.command, [
      "tunnel",
      "--config",
      configFile,
      "--no-autoupdate",
      ...(named
        ? ["run", "--token-file", named.tokenFile]
        : ["--url", `http://127.0.0.1:${options.port}`]),
    ]);
  } catch (error) {
    cleanupConfig();
    return Promise.reject(
      new Error(
        named ? namedFailure : `cloudflared could not be started: ${(error as Error).message}`,
      ),
    );
  }
  const lines: string[] = [];
  let url: string | null = named?.publicUrl ?? null;
  let connected = false;
  let completed = false;
  let failing = false;
  let intentionalExit = false;
  let didExit = child.exitCode !== null || child.signalCode !== null;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  if (didExit) resolveExit();
  child.once("exit", () => {
    didExit = true;
    cleanupConfig();
    resolveExit();
  });
  child.once("error", () => {
    // A spawn failure has no process and therefore no later exit event.
    if (child.pid === undefined) {
      didExit = true;
      cleanupConfig();
      resolveExit();
    }
  });
  const exitWithin = (ms: number): Promise<boolean> => {
    if (didExit) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(didExit), ms);
      void exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  };
  const lifecycle = new AbortController();
  let terminating: Promise<void> | null = null;
  const terminate = (): Promise<void> => {
    if (terminating) return terminating;
    intentionalExit = true;
    lifecycle.abort();
    const attempt = (async () => {
      if (!didExit && child.pid !== undefined) {
        try {
          child.kill();
        } catch {
          // Escalation below still gets a chance.
        }
        await exitWithin(2_000);
      }
      if (!didExit && child.pid !== undefined) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Report a process that still cannot be confirmed dead below.
        }
        await exitWithin(2_000);
      }
      cleanupConfig();
      if (!didExit && child.pid !== undefined)
        throw new Error("cloudflared did not stop after OwnBase closed the public link.");
    })();
    terminating = attempt.catch((error: unknown) => {
      terminating = null;
      throw error;
    });
    return terminating;
  };
  const listeners: ((reason: string) => void)[] = [];
  let unexpectedReason: string | null = null;

  return new Promise<Tunnel>((resolve, reject) => {
    let probeStarted = false;
    const healthProbe = options.healthProbe ?? ownBaseIsReachable;
    const onAbort = () => fail("Opening to all was cancelled.");
    const cleanupOpening = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (message: string) => {
      if (completed || failing) return;
      failing = true;
      cleanupOpening();
      void terminate().then(
        () => {
          completed = true;
          reject(new Error(message));
        },
        (stopError: unknown) => {
          completed = true;
          const detail = stopError instanceof Error ? ` ${stopError.message}` : "";
          reject(
            new TunnelCleanupError(`${message}${detail}`, {
              url: url ?? "",
              close: terminate,
              onUnexpectedExit: (listener) => {
                if (unexpectedReason) queueMicrotask(() => listener(unexpectedReason!));
                else if (!didExit) listeners.push(listener);
              },
            }),
          );
        },
      );
    };
    const timer = setTimeout(
      () =>
        fail(
          named
            ? `The saved Cloudflare address did not reach this workspace. In Cloudflare, point its published application route to http://127.0.0.1:${options.port}, then try again.`
            : url
              ? "Cloudflare gave this workspace an address, but it did not become reachable. Check this computer's internet connection and try again."
              : "Cloudflare did not answer in time. Check this computer's internet connection and try again.",
        ),
      timeoutMs,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const readLines = (parts: string[]) => {
      for (const line of parts) {
        // A connector can include credential contents in an error. Named
        // tunnels never retain raw output for diagnostics or expose it to UI.
        if (!named) {
          lines.push(line);
          if (lines.length > 50) lines.shift();
          url ??= line.match(QUICK_TUNNEL_URL)?.[0] ?? null;
        }
        if (CONNECTED.test(line)) connected = true;
      }
      if (!completed && !failing && !probeStarted && url && connected) {
        probeStarted = true;
        const address = url;
        void (async () => {
          // Cloudflare documents a brief DNS warm-up for new Quick Tunnel
          // hostnames. Looking it up immediately can leave an NXDOMAIN in the
          // operating system cache after the record itself is ready.
          const warmupMs = options.dnsWarmupMs ?? (named || options.healthProbe ? 0 : 10_000);
          if (warmupMs > 0) await wait(warmupMs, lifecycle.signal);
          while (!completed && !failing && !lifecycle.signal.aborted) {
            try {
              if (
                await healthProbe(`${address}/api/health`, lifecycle.signal, options.instanceId)
              ) {
                if (completed || failing || lifecycle.signal.aborted) return;
                completed = true;
                cleanupOpening();
                resolve({
                  url: address,
                  close: terminate,
                  onUnexpectedExit: (listener) => {
                    if (unexpectedReason) queueMicrotask(() => listener(unexpectedReason!));
                    else listeners.push(listener);
                  },
                });
                return;
              }
            } catch {
              if (lifecycle.signal.aborted) return;
            }
            await wait(500, lifecycle.signal);
          }
        })();
      }
    };
    const reader = () => {
      let pending = "";
      return (chunk: Buffer) => {
        const parts = (pending + chunk.toString("utf8")).split(/\r?\n/);
        pending = (parts.pop() ?? "").slice(-16_384);
        readLines(parts);
      };
    };
    child.stdout?.on("data", reader());
    child.stderr?.on("data", reader());

    child.once("error", (error) => {
      if (!intentionalExit)
        fail(
          named ? namedFailure : `cloudflared could not be started: ${(error as Error).message}`,
        );
    });
    child.once("exit", (code) => {
      if (!completed && !failing) {
        const reason = lastComplaint(lines);
        fail(
          named
            ? namedFailure
            : reason
              ? `Cloudflare could not open a link: ${reason}`
              : `cloudflared stopped before opening a link (exit code ${code ?? "unknown"}).`,
        );
        return;
      }
      if (intentionalExit || failing) return;
      const reason = named
        ? "The saved Cloudflare tunnel connector stopped. Check its token file and reconnect."
        : (lastComplaint(lines) ?? `cloudflared exited (code ${code ?? "unknown"})`);
      unexpectedReason = reason;
      for (const listener of listeners.splice(0)) listener(reason);
    });
  });
}
