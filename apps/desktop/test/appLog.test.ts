import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendLog,
  appLog,
  logTail,
  redactLog,
  serverLogStream,
  uncaughtMonitor,
} from "../src/main/appLog.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ownbase-applog-"));
  file = join(dir, "ownbase.log");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const read = () => readFileSync(file, "utf8");

const SESSION = "9f".repeat(32);
const BOT = `xoxb-${"a1".repeat(24)}`;
const TUNNEL = "eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJhYmNkZWYiLCJzIjoiWm1Wa1kyRmlaR1ZtIn0=";

describe("the app's log file", () => {
  it("adds each line at the end, stamped with the time", async () => {
    const write = appendLog(file);
    await write("first");
    await write("second");
    const lines = read().trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z first$/);
    expect(lines[1]).toMatch(/ second$/);
  });

  it("starts again once it has grown past its limit", async () => {
    const write = appendLog(file, 100);
    await write("x".repeat(120));
    await write("after the cut");
    expect(read()).not.toContain("xxx");
    expect(read()).toMatch(/ after the cut\n$/);
  });

  it("never throws, even where it cannot write", async () => {
    const write = appendLog(join(dir, "no such folder", "ownbase.log"));
    await expect(write("lost")).resolves.toBeUndefined();
  });

  it("writes no sign-in token, claim code, invite, bot token or tunnel token", async () => {
    const write = appendLog(file);
    await write(`request failed: Authorization: Bearer ${SESSION}`);
    await write(`token ${SESSION} expired`);
    await write(`claim it at http://192.168.1.5:8543/?claim=${BOT}`);
    await write("GET /api/invites/ABCD2345 answered 404");
    await write("opened https://chat.example.org/#/join/ABCD2345");
    await write(`fetch https://chat.example.org/api/files/F1?download=${SESSION}&size=2`);
    await write(`{"password":"hunter2-horse","token":"${SESSION}"}`);
    await write(`cloudflared --token ${TUNNEL}`);
    const text = read();
    for (const secret of [SESSION, BOT, TUNNEL, "ABCD2345", "hunter2-horse"])
      expect(text).not.toContain(secret);
    expect(text).toContain("REDACTED");
    // What makes a line worth reading stays.
    expect(text).toContain("GET /api/invites/REDACTED answered 404");
    expect(text).toContain("size=2");
  });
});

describe("redacting a line", () => {
  it("leaves ordinary words, paths and stacks alone", () => {
    const stack =
      "Error: could not save theme\n    at save (file:///C:/Users/sam/AppData/Local/Programs/OwnBase/resources/app.asar/out/main/index.js:306:13)";
    expect(redactLog(stack)).toBe(stack);
    expect(redactLog("searched for q=token in #general")).toBe("searched for q=token in #general");
  });
});

describe("a failure in the main process", () => {
  it("goes to the console and to the log, with the error's stack", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = appLog(file);
    const error = new Error(`could not reach ${SESSION}`);
    await log.error("OwnBase: could not save theme.", error);
    expect(consoleError).toHaveBeenCalledWith("OwnBase: could not save theme.", error);
    const text = read();
    expect(text).toContain("OwnBase: could not save theme. Error: could not reach REDACTED");
    expect(text).toContain("appLog.test.ts");
    expect(text).not.toContain(SESSION);
  });

  it("is written by the uncaught-exception monitor, message and stack, without handling it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const monitor = uncaughtMonitor(appLog(file));
    const error = new TypeError("Cannot read properties of undefined (reading 'id')");
    monitor(error, "uncaughtException");
    const text = read();
    expect(text).toContain(
      "OwnBase: uncaught exception. TypeError: Cannot read properties of undefined (reading 'id')",
    );
    expect(text).toContain("    at ");
    monitor("a string thrown", "unhandledRejection");
    expect(read()).toContain("OwnBase: unhandled rejection. a string thrown");
    // The second is added after the first, not in its place.
    expect(read()).toContain("OwnBase: uncaught exception. TypeError");
  });
});

describe("a hosted workspace's server log", () => {
  const line = (level: number, msg: string) =>
    JSON.stringify({ level, time: 1, pid: 1, hostname: "pc", msg }) + "\n";

  async function feed(...chunks: string[]) {
    const write = appendLog(file);
    const stream = serverLogStream(write);
    for (const chunk of chunks) stream.write(chunk);
    await new Promise<void>((done) => stream.end(done));
    await write.settled();
    return read();
  }

  it("keeps warnings and errors and drops the rest", async () => {
    const text = await feed(
      line(30, "incoming request"),
      line(40, "backup is late"),
      line(50, "could not open the database"),
    );
    expect(text).not.toContain("incoming request");
    expect(text).toContain("backup is late");
    expect(text).toContain("could not open the database");
    expect(text.trimEnd().split("\n")).toHaveLength(2);
  });

  it("writes a line that is not JSON as it is, and lines split across writes whole", async () => {
    const warning = line(40, "split in two");
    const text = await feed("not json at all\n", warning.slice(0, 10), warning.slice(10));
    expect(text).toContain("server: not json at all");
    expect(text).toContain("split in two");
  });

  it("writes no secret a line carries", async () => {
    const text = await feed(line(50, `webhook /hooks/${BOT} failed, bearer ${SESSION}`));
    expect(text).toContain("webhook /hooks/REDACTED failed");
    expect(text).not.toContain(BOT);
    expect(text).not.toContain(SESSION);
  });
});

describe("the end of the log, for Diagnostics", () => {
  it("is the last lines, or nothing when there is no log", async () => {
    expect(await logTail(file, 50)).toEqual([]);
    writeFileSync(file, Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const tail = await logTail(file, 50);
    expect(tail).toHaveLength(50);
    expect(tail[0]).toBe("line 30");
    expect(tail.at(-1)).toBe("line 79");
  });
});
