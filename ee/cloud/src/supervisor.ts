import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

/** How to run the OwnBase server: a program and the arguments before its own. */
export interface ServerCommand {
  command: string;
  args: string[];
}

/** One workspace's server, as the supervisor runs it. */
export interface ProcessSpec {
  slug: string;
  port: number;
  /** Where its log goes, `server.log`. */
  folder: string;
  /** The server's own arguments. */
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type ProcessState = "starting" | "running" | "waiting" | "stopped";

export interface ProcessStatus {
  state: ProcessState;
  pid: number | null;
  /** How many times it has been started again after it stopped on its own. */
  restarts: number;
  /** When a waiting server starts again. */
  nextStartAt: number | null;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
}

/** Waits between starts after a server stops on its own, longest last. */
export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
/** A server that ran this long was healthy; the next stop starts the waits over. */
export const STEADY_MS = 60_000;
/** How long a server has to answer its health check after starting. */
export const HEALTHY_WITHIN_MS = 30_000;
/** How long a server has to stop when asked, before it is killed. */
export const STOP_WITHIN_MS = 10_000;

interface Running {
  spec: ProcessSpec;
  child: ChildProcess | null;
  log: WriteStream;
  status: ProcessStatus;
  startedAt: number;
  failures: number;
  timer: NodeJS.Timeout | null;
  wanted: boolean;
}

/**
 * Runs one OwnBase server process per workspace (P7). A server that stops
 * on its own is started again after a wait that grows each time, back to
 * the shortest once it has run steadily. Output goes to the workspace's
 * server.log.
 */
export class Supervisor {
  private readonly running = new Map<string, Running>();

  constructor(
    private readonly server: ServerCommand,
    private readonly log: (message: string) => void = () => {},
  ) {}

  status(slug: string): ProcessStatus {
    return (
      this.running.get(slug)?.status ?? {
        state: "stopped",
        pid: null,
        restarts: 0,
        nextStartAt: null,
        lastExit: null,
      }
    );
  }

  /** Starts a workspace's server and waits until it answers, or throws. */
  async start(spec: ProcessSpec): Promise<void> {
    const existing = this.running.get(spec.slug);
    if (existing?.wanted) return this.healthy(spec.port, () => !existing.wanted);
    mkdirSync(spec.folder, { recursive: true });
    const entry: Running = {
      spec,
      child: null,
      log: createWriteStream(join(spec.folder, "server.log"), { flags: "a" }),
      status: { state: "starting", pid: null, restarts: 0, nextStartAt: null, lastExit: null },
      startedAt: 0,
      failures: 0,
      timer: null,
      wanted: true,
    };
    this.running.set(spec.slug, entry);
    this.launch(entry);
    await this.healthy(spec.port, () => !entry.wanted);
  }

  private launch(entry: Running): void {
    const { spec } = entry;
    entry.timer = null;
    entry.startedAt = Date.now();
    entry.status = { ...entry.status, state: "starting", nextStartAt: null };
    const child = spawn(this.server.command, [...this.server.args, ...spec.args], {
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    entry.child = child;
    entry.status.pid = child.pid ?? null;
    child.stdout?.pipe(entry.log, { end: false });
    child.stderr?.pipe(entry.log, { end: false });
    child.once("spawn", () => {
      if (entry.child === child) entry.status.state = "running";
    });
    child.once("error", (error) => {
      entry.log.write(`\n[control plane] could not start: ${error.message}\n`);
    });
    child.once("exit", (code, signal) => {
      if (entry.child !== child) return;
      entry.child = null;
      entry.status.pid = null;
      entry.status.lastExit = { code, signal, at: Date.now() };
      if (!entry.wanted) {
        entry.status.state = "stopped";
        return;
      }
      // Stopped on its own: wait, then start it again.
      if (Date.now() - entry.startedAt >= STEADY_MS) entry.failures = 0;
      const wait = BACKOFF_MS[Math.min(entry.failures, BACKOFF_MS.length - 1)]!;
      entry.failures++;
      entry.status.state = "waiting";
      entry.status.nextStartAt = Date.now() + wait;
      entry.log.write(
        `\n[control plane] stopped (${signal ?? `exit ${code}`}); starting again in ${wait / 1000} s\n`,
      );
      this.log(
        `${spec.slug} stopped (${signal ?? `exit ${code}`}); starting again in ${wait / 1000} s`,
      );
      entry.timer = setTimeout(() => {
        if (!entry.wanted) return;
        entry.status.restarts++;
        this.launch(entry);
      }, wait);
    });
  }

  /** Stops a workspace's server: asked first, killed if it does not go. */
  async stop(slug: string): Promise<void> {
    const entry = this.running.get(slug);
    if (!entry) return;
    entry.wanted = false;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    const child = entry.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), STOP_WITHIN_MS);
      await exited;
      clearTimeout(killer);
    }
    entry.status = { ...entry.status, state: "stopped", pid: null, nextStartAt: null };
    await new Promise<void>((resolve) => entry.log.end(resolve));
    this.running.delete(slug);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((slug) => this.stop(slug)));
  }

  /** Waits until the server on `port` answers its health check, unless it is stopped first. */
  private async healthy(port: number, stopped: () => boolean): Promise<void> {
    const deadline = Date.now() + HEALTHY_WITHIN_MS;
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      if (stopped()) throw new Error(`the server on port ${port} was stopped before it answered`);
      if (Date.now() > deadline)
        throw new Error(
          `the server on port ${port} did not answer within ${HEALTHY_WITHIN_MS / 1000} s`,
        );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
