import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  describeStartupError,
  envSetting,
  parsePort,
  parsePublicUrl,
  parseWholeNumber,
} from "../src/config.js";
import { createWorkspaceServer } from "../src/server.js";

describe("a port", () => {
  it("is a whole number from 0 to 65535", () => {
    expect(parsePort("0")).toBe(0);
    expect(parsePort("8543")).toBe(8543);
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort(3000)).toBe(3000);
  });

  it("is refused with the flag and the value named, rather than as a stack trace", () => {
    for (const bad of ["abc", "70000", "-1", "1.5", "", "80abc", "0x50"]) {
      expect(() => parsePort(bad), bad).toThrow(ConfigError);
    }
    expect(() => parsePort("abc")).toThrow('--port needs a port number from 0 to 65535, not "abc"');
  });
});

describe("the public address", () => {
  it("accepts an http or https address, with or without a path", () => {
    expect(parsePublicUrl("https://chat.example.com")).toBe("https://chat.example.com");
    expect(parsePublicUrl("http://192.168.1.5:8543/")).toBe("http://192.168.1.5:8543");
    // Published under a path behind a proxy: kept, without a trailing slash
    // that would double up when a URL is built from it.
    expect(parsePublicUrl("https://example.com/chat/")).toBe("https://example.com/chat");
  });

  it("refuses what is not an address, instead of handing it to every app", () => {
    expect(() => parsePublicUrl("not-a-url")).toThrow(/needs a full address/);
    expect(() => parsePublicUrl("chat.example.com")).toThrow(/needs a full address/);
    expect(() => parsePublicUrl("ftp://chat.example.com")).toThrow(/http:\/\/ or https:\/\//);
  });

  it("refuses a password, which would be shown to every app", () => {
    expect(() => parsePublicUrl("https://admin:hunter2@chat.example.com")).toThrow(
      /username or password/,
    );
    // And does not repeat it in the refusal.
    expect(() => parsePublicUrl("https://admin:hunter2@chat.example.com")).not.toThrow(/hunter2/);
  });

  it("refuses a query or a fragment, which would be carried into every URL", () => {
    expect(() => parsePublicUrl("https://chat.example.com/?x=1")).toThrow(/query/);
    expect(() => parsePublicUrl("https://chat.example.com/#top")).toThrow(/fragment/);
  });
});

describe("a count of whole units", () => {
  it("falls back when it was not given", () => {
    expect(parseWholeNumber(undefined, "--retention-days", 0)).toBe(0);
  });

  it("accepts a whole number", () => {
    expect(parseWholeNumber("30", "--retention-days", 0)).toBe(30);
    expect(parseWholeNumber("0", "--retention-days", 7)).toBe(0);
  });

  it("refuses a fraction rather than rounding it behind the host's back", () => {
    // 1.5 used to be announced as 1.5 days and applied as 2.
    expect(() => parseWholeNumber("1.5", "--retention-days", 0)).toThrow(
      '--retention-days needs a whole number of 0 or more, not "1.5"',
    );
    for (const bad of ["-1", "abc", "", "1e3", "99999999999999999999"]) {
      expect(() => parseWholeNumber(bad, "--retention-days", 0), bad).toThrow(ConfigError);
    }
  });
});

describe("settings from the environment", () => {
  const NAMES = [
    "OWNBASE_RETENTION_DAYS_TEST",
    "TANDEM_RETENTION_DAYS_TEST",
    "GATHERLINE_RETENTION_DAYS_TEST",
    "SLACKOSS_RETENTION_DAYS_TEST",
  ] as const;
  afterEach(() => {
    for (const name of NAMES) delete process.env[name];
  });

  it("reads the OwnBase name", () => {
    process.env.OWNBASE_RETENTION_DAYS_TEST = "30";
    expect(envSetting("RETENTION_DAYS_TEST")).toBe("30");
  });

  it("still reads the previous TANDEM_ name", () => {
    process.env.TANDEM_RETENTION_DAYS_TEST = "30";
    expect(envSetting("RETENTION_DAYS_TEST")).toBe("30");
  });

  it("still reads the GATHERLINE_ name before it", () => {
    process.env.GATHERLINE_RETENTION_DAYS_TEST = "30";
    expect(envSetting("RETENTION_DAYS_TEST")).toBe("30");
  });

  it("still reads the first SLACKOSS_ name", () => {
    process.env.SLACKOSS_RETENTION_DAYS_TEST = "30";
    expect(envSetting("RETENTION_DAYS_TEST")).toBe("30");
  });

  it("prefers the newest name, OwnBase, then Tandem, then Gatherline, when more than one is set", () => {
    process.env.OWNBASE_RETENTION_DAYS_TEST = "30";
    process.env.TANDEM_RETENTION_DAYS_TEST = "21";
    process.env.GATHERLINE_RETENTION_DAYS_TEST = "14";
    process.env.SLACKOSS_RETENTION_DAYS_TEST = "7";
    expect(envSetting("RETENTION_DAYS_TEST")).toBe("30");
    delete process.env.OWNBASE_RETENTION_DAYS_TEST;
    expect(envSetting("RETENTION_DAYS_TEST")).toBe("21");
    delete process.env.TANDEM_RETENTION_DAYS_TEST;
    expect(envSetting("RETENTION_DAYS_TEST")).toBe("14");
  });

  it("is undefined when neither is set", () => {
    expect(envSetting("RETENTION_DAYS_TEST")).toBeUndefined();
  });
});

describe("explaining a server that would not start", () => {
  const failure = (code: string) => Object.assign(new Error(`raw ${code}`), { code });

  it("names the port that is taken", () => {
    expect(describeStartupError(failure("EADDRINUSE"), { port: 8543 })).toMatch(
      /^Port 8543 is already in use/,
    );
  });

  it("explains a port this account may not use", () => {
    expect(describeStartupError(failure("EACCES"), { port: 80 })).toMatch(/port 80/);
  });

  it("names a host this machine does not have", () => {
    for (const code of ["ENOTFOUND", "EADDRNOTAVAIL"]) {
      expect(describeStartupError(failure(code), { host: "10.9.9.9" })).toMatch(
        /--host 10\.9\.9\.9: this machine has no such address/,
      );
    }
  });

  it("passes anything else through as its own message", () => {
    expect(describeStartupError(new ConfigError("a setting"), {})).toBe("a setting");
    expect(describeStartupError(new Error("Could not back up"), {})).toBe("Could not back up");
  });
});

describe("the server checks too, for callers other than the CLI", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("refuses a bad address or port before it creates anything", async () => {
    dir = mkdtempSync(join(tmpdir(), "slackoss-config-"));
    await expect(
      createWorkspaceServer({ dataDir: dir, port: 0, mdns: false, publicUrl: "not-a-url" }),
    ).rejects.toThrow(ConfigError);
    await expect(
      createWorkspaceServer({ dataDir: dir, port: 70000, mdns: false, logger: false }),
    ).rejects.toThrow(ConfigError);
    // Refused at the door: no workspace was created on the way to failing.
    expect(existsSync(join(dir, "workspace.db"))).toBe(false);
  });
});
