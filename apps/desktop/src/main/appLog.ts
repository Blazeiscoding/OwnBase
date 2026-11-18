import { appendFileSync, statSync, truncateSync } from "node:fs";
import { appendFile, readFile, stat, truncate } from "node:fs/promises";
import { Writable } from "node:stream";

/**
 * The app's own log, `ownbase.log` in its folder: failures in the main process
 * and warnings from a workspace it hosts, for Diagnostics to show and for
 * whoever is helping to read. A packaged app has no console, so without it a
 * failure there leaves no trace. It is cut back to nothing past this size,
 * like the update log: it is for what happened lately.
 */
export const LOG_LIMIT = 256 * 1024;

const MASK = "REDACTED";

/**
 * What would still work if copied out of a log line, masked; modelled on the
 * server's `redact.ts`. Everything else stays, since the shape of a line is
 * what makes it worth reading.
 */
const SECRETS: [RegExp, string][] = [
  // A bearer token, after its scheme.
  [/\b(Bearer\s+)[^\s"',]+/gi, `$1${MASK}`],
  // Paths whose last segment is the secret: an invite, an incoming webhook,
  // a response_url, and the app's own join links.
  [/(\/api\/invites\/|\/hooks\/|\/api\/commands\/response\/|\/join\/)[^/\s?#"']+/g, `$1${MASK}`],
  // Query parameters that carry a credential, by whole name.
  [/([?&#](?:download|token|ticket|code|secret|claim|invite)=)[^&#\s"']*/gi, `$1${MASK}`],
  // A value given for a field that holds a secret, as JSON or as name=value.
  [
    /(["']?\b(?:password|passphrase|token|secret|claimCode|tunnelToken|ticket)["']?\s*[:=]\s*["']?)[^"'\s,&}]+/gi,
    `$1${MASK}`,
  ],
  // Any long run of token characters: session tokens are 64 hex digits, bot
  // and webhook tokens and claim codes 48 after a prefix, tunnel tokens base64.
  // Paths are not caught, since a slash or a dot ends the run.
  [/[A-Za-z0-9_+=-]{32,}/g, MASK],
];

/** A line with whatever would still work if copied out of it masked. */
export function redactLog(text: string): string {
  return SECRETS.reduce((line, [pattern, mask]) => line.replace(pattern, mask), text);
}

const stamped = (text: string) => `${new Date().toISOString()} ${redactLog(text)}\n`;

export interface LogWriter {
  /** Adds a line, redacted and stamped; resolves once written. Never rejects. */
  (text: string): Promise<void>;
  /** Resolves once every line given so far is written. */
  settled(): Promise<void>;
}

/** Appends lines to `path`, one after another, cutting it back past `limit`. */
export function appendLog(path: string, limit = LOG_LIMIT): LogWriter {
  let writing = Promise.resolve();
  const write = (text: string) => {
    const line = stamped(text);
    writing = writing
      .then(async () => {
        const size = await stat(path).then(
          (info) => info.size,
          () => 0,
        );
        if (size > limit) await truncate(path, 0);
        await appendFile(path, line);
      })
      // A log is not worth failing for.
      .catch(() => {});
    return writing;
  };
  return Object.assign(write, { settled: () => writing });
}

const described = (error: unknown) =>
  error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);

export interface AppLog {
  /** Says what failed on the console and in the log, with the error's stack. */
  error(message: string, error?: unknown): Promise<void>;
  /** The same, written before it returns, for a failure the process may not outlive. */
  errorNow(message: string, error?: unknown): void;
  /** Adds a line as it is, redacted and stamped, in the same queue. */
  write: LogWriter;
  path: string;
}

export function appLog(path: string, limit = LOG_LIMIT): AppLog {
  const write = appendLog(path, limit);
  const text = (message: string, error: unknown) =>
    error === undefined ? message : `${message} ${described(error)}`;
  // The one place the main process writes to its console, which a packaged app does not have.
  const say = (message: string, error: unknown) =>
    console.error(...(error === undefined ? [message] : [message, error]));
  return {
    path,
    write,
    error(message, error) {
      say(message, error);
      return write(text(message, error));
    },
    errorNow(message, error) {
      say(message, error);
      try {
        if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > limit) truncateSync(path, 0);
        appendFileSync(path, stamped(text(message, error)));
      } catch {
        // A log is not worth failing for, least of all while failing.
      }
    },
  };
}

/**
 * For `process.on("uncaughtExceptionMonitor", ...)`: it sees an uncaught
 * exception, or a rejection nothing handled, and writes it down. It handles
 * nothing, so a crash looks exactly as it would without it.
 */
export function uncaughtMonitor(log: AppLog): (error: unknown, origin: string) => void {
  return (error, origin) =>
    log.errorNow(
      origin === "unhandledRejection"
        ? "OwnBase: unhandled rejection."
        : "OwnBase: uncaught exception.",
      error,
    );
}

/** Warnings and errors (pino's level 40 and up); a hosted server's other lines are dropped. */
const WARNING = 40;

/**
 * A stream for a hosted workspace's server (`logger: { stream }`): every log
 * line arrives as one line of JSON, and those that warn or fail are written to
 * the app's log. A line that is not JSON is written as it is.
 */
export function serverLogStream(write: (text: string) => unknown): Writable {
  let partial = "";
  const pass = (line: string) => {
    if (!line.trim()) return;
    let level: unknown;
    try {
      level = (JSON.parse(line) as { level?: unknown }).level;
    } catch {
      level = undefined;
    }
    if (typeof level === "number" && level < WARNING) return;
    void write(`server: ${line}`);
  };
  return new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      const lines = (partial + chunk.toString()).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) pass(line);
      done();
    },
    final(done) {
      pass(partial);
      partial = "";
      done();
    },
  });
}

/** The last `count` lines of the log, for Diagnostics; none when there is no log. */
export async function logTail(path: string, count: number): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(-count);
}
