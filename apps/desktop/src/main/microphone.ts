import { spawn as spawnProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * Microphones the app opens itself on Windows, as other apps there open them
 * (native/OwnBaseMicrophone.cs). Chromium opens a microphone that supports it
 * in raw mode, and Windows leaves the sound effects someone set up (Equalizer
 * APO, a maker's noise removal) out of raw streams, so OwnBase alone heard the
 * microphone without them. Each open microphone is one helper process; its
 * samples go to the page over a MessagePort, which the page hands to an audio
 * worklet, so they never wait on the page's own thread.
 */

/** What Windows lists: every active microphone, and the default one's id. */
export interface SystemMicrophoneList {
  defaultId: string | null;
  microphones: { id: string; name: string }[];
}

export const NO_MICROPHONES: SystemMicrophoneList = { defaultId: null, microphones: [] };

/** An open microphone, as the page is told of it. */
export interface OpenedMicrophone {
  session: number;
  sampleRate: number;
  name: string;
}

/** The main process's end of the port the page reads samples from. */
export interface SamplePort {
  postMessage(message: unknown): void;
  close(): void;
  /** Hears the page's end close: it reloaded, crashed, or let the microphone go. */
  on(event: "close", listener: () => void): unknown;
  start(): void;
}

/** The parts of a helper process this reads. */
export interface HelperProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): boolean;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type SpawnHelper = (path: string, args: string[]) => HelperProcess;

const spawnHelper: SpawnHelper = (path, args) =>
  spawnProcess(path, args, { stdio: "pipe", windowsHide: true });

/** How long the helper may take to list, or to start a microphone. */
const START_MS = 5000;
/** How long a closed helper has to stop by itself before it is killed. */
const STOP_MS = 1000;
/** How long a port stays open after telling the page its microphone went. */
const ENDED_CLOSE_MS = 250;
/** Open microphones one window may hold: a call's, and the check's in settings, with room to change. */
const PER_OWNER = 4;
const MAX_ID = 512;

/** Reads what the helper's `list` printed; anything else is no microphones. */
export function parseMicrophoneList(text: string): SystemMicrophoneList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NO_MICROPHONES;
  }
  if (typeof parsed !== "object" || parsed === null) return NO_MICROPHONES;
  const { default: defaultId, microphones } = parsed as Record<string, unknown>;
  if (!Array.isArray(microphones)) return NO_MICROPHONES;
  const listed = microphones.filter(
    (m): m is { id: string; name: string } =>
      typeof m === "object" &&
      m !== null &&
      isEndpointId((m as { id?: unknown }).id) &&
      typeof (m as { name?: unknown }).name === "string",
  );
  return {
    defaultId: isEndpointId(defaultId) ? defaultId : null,
    microphones: listed.map(({ id, name }) => ({ id, name })),
  };
}

/** A Windows endpoint id as the helper names one, or `default`. */
export function isEndpointId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_ID && !/\p{Cc}/u.test(id);
}

type HelperEvent =
  | { event: "started"; sampleRate: number; channels: number; name: string }
  | { event: "ended"; reason: string }
  | { event: "error"; message: string };

/** One line the helper wrote on stderr, or null for anything it did not mean. */
export function parseEvent(line: string): HelperEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const e = parsed as Record<string, unknown>;
  if (
    e.event === "started" &&
    typeof e.sampleRate === "number" &&
    e.sampleRate >= 8000 &&
    e.sampleRate <= 384000 &&
    typeof e.channels === "number" &&
    typeof e.name === "string"
  )
    return { event: "started", sampleRate: e.sampleRate, channels: e.channels, name: e.name };
  if (e.event === "ended" && typeof e.reason === "string")
    return { event: "ended", reason: e.reason };
  if (e.event === "error" && typeof e.message === "string")
    return { event: "error", message: e.message };
  return null;
}

/** Calls `onLine` for each whole line a stream writes. */
function lines(stream: Readable, onLine: (line: string) => void): void {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      if (line) onLine(line);
    }
  });
}

interface Session {
  owner: number;
  helper: HelperProcess;
  port: SamplePort;
  /** Set once closing was asked for, so the helper stopping is not news to the page. */
  closing: boolean;
}

export class SystemMicrophones {
  private sessions = new Map<number, Session>();
  private nextSession = 1;

  /**
   * `helper` is the helper's path, or null where the app does not open
   * microphones itself: not Windows, the helper missing, or tests that use
   * the browser's fake devices.
   */
  constructor(
    private readonly helper: string | null,
    private readonly spawn: SpawnHelper = spawnHelper,
    private readonly startMs = START_MS,
  ) {}

  /** What Windows lists; none where the app does not open microphones itself, or the helper fails. */
  async list(): Promise<SystemMicrophoneList> {
    if (!this.helper) return NO_MICROPHONES;
    const helper = this.spawn(this.helper, ["list"]);
    return new Promise((resolve) => {
      let out = "";
      const timer = setTimeout(() => {
        helper.kill();
        resolve(NO_MICROPHONES);
      }, this.startMs);
      helper.stdout.setEncoding("utf8");
      helper.stdout.on("data", (chunk: string) => (out += chunk));
      helper.stdin.end();
      helper.on("error", () => {
        clearTimeout(timer);
        resolve(NO_MICROPHONES);
      });
      helper.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? parseMicrophoneList(out) : NO_MICROPHONES);
      });
    });
  }

  /**
   * Opens a microphone for the window `owner`, sending its samples to `port`
   * as mono Float32Arrays at the rate it resolves with, and `{ ended }` if
   * the device goes. Rejects, saying why, when it will not start; the port is
   * closed then.
   */
  open(owner: number, id: string, port: SamplePort): Promise<OpenedMicrophone> {
    if (!this.helper) {
      port.close();
      return Promise.reject(new Error("This app does not open microphones itself here."));
    }
    if (!isEndpointId(id)) {
      port.close();
      return Promise.reject(new Error("Not a microphone."));
    }
    if ([...this.sessions.values()].filter((s) => s.owner === owner).length >= PER_OWNER) {
      port.close();
      return Promise.reject(new Error("Too many microphones are open."));
    }
    const session = this.nextSession++;
    const helper = this.spawn(this.helper, ["capture", id]);
    const entry: Session = { owner, helper, port, closing: false };
    this.sessions.set(session, entry);
    return new Promise((resolve, reject) => {
      let started = false;
      const fail = (message: string) => {
        if (started) return;
        started = true;
        clearTimeout(timer);
        this.drop(session);
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail("The microphone did not start in time."), this.startMs);

      let rest: Buffer = Buffer.alloc(0);
      helper.stdout.on("data", (chunk: Buffer) => {
        const bytes = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        const whole = bytes.length - (bytes.length % 4);
        rest = bytes.subarray(whole);
        if (whole === 0 || entry.closing) return;
        // Copied out, so the samples start on a 4-byte boundary.
        const samples = new Float32Array(whole / 4);
        new Uint8Array(samples.buffer).set(bytes.subarray(0, whole));
        port.postMessage(samples);
      });
      lines(helper.stderr, (line) => {
        const event = parseEvent(line);
        if (!event) return;
        if (event.event === "started" && !started) {
          started = true;
          clearTimeout(timer);
          resolve({ session, sampleRate: event.sampleRate, name: event.name });
        } else if (event.event === "error") {
          fail(`The microphone did not start: ${event.message}.`);
        } else if (event.event === "ended") {
          this.end(session, event.reason);
        }
      });
      helper.on("error", (err) => {
        fail(`The microphone helper did not run: ${err.message}.`);
        this.end(session, "helper-failed");
      });
      helper.on("exit", (code) => {
        fail(`The microphone did not start (${code ?? "stopped"}).`);
        this.end(session, "helper-exited");
      });
      // The page letting its end go is the same as closing.
      port.on("close", () => this.close(owner, session));
      port.start();
    });
  }

  /** Closes one of `owner`'s microphones; one it does not hold is left alone. */
  close(owner: number, session: number): void {
    const entry = this.sessions.get(session);
    if (!entry || entry.owner !== owner) return;
    this.drop(session);
  }

  /** Closes every microphone `owner` holds: its page reloaded, or its window closed. */
  closeOwner(owner: number): void {
    for (const [session, entry] of this.sessions) if (entry.owner === owner) this.drop(session);
  }

  closeAll(): void {
    for (const session of [...this.sessions.keys()]) this.drop(session);
  }

  /** How many microphones are open. */
  get openCount(): number {
    return this.sessions.size;
  }

  /** The device went, or the helper stopped by itself: the page is told, once. */
  private end(session: number, reason: string): void {
    const entry = this.sessions.get(session);
    if (!entry) return;
    if (!entry.closing) {
      try {
        entry.port.postMessage({ ended: reason });
      } catch {
        // The page's end is gone already.
      }
    }
    // A moment for the page to hear why before its end closes.
    this.drop(session, ENDED_CLOSE_MS);
  }

  /** Stops the helper, by closing its input and then for good, and closes the port. */
  private drop(session: number, closeAfterMs = 0): void {
    const entry = this.sessions.get(session);
    if (!entry) return;
    this.sessions.delete(session);
    entry.closing = true;
    entry.helper.stdin.end();
    const kill = setTimeout(() => entry.helper.kill(), STOP_MS);
    kill.unref?.();
    entry.helper.on("exit", () => clearTimeout(kill));
    const close = () => {
      try {
        entry.port.close();
      } catch {
        // Closed already.
      }
    };
    if (closeAfterMs > 0) setTimeout(close, closeAfterMs).unref?.();
    else close();
  }
}
