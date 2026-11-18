import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REPORT_WHERE,
  bugReportUrl,
  reportSystem,
  reportVersion,
  reportWhere,
} from "../src/lib/reportProblem.js";

const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const DESKTOP_APP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) OwnBase/0.2.0 Chrome/152.0.0.0 Electron/45.0.0 Safari/537.36";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";
const MAC_FIREFOX =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.0; rv:150.0) Gecko/20100101 Firefox/150.0";

/** The bug form's fields, read from the form itself, so a renamed one fails here. */
function bugForm() {
  const yml = readFileSync(
    new URL("../../../.github/ISSUE_TEMPLATE/bug_report.yml", import.meta.url),
    "utf8",
  );
  const ids = [...yml.matchAll(/^\s+id: (\S+)$/gm)].map((m) => m[1]);
  const where = yml.slice(
    yml.indexOf("id: where"),
    yml.indexOf("validations", yml.indexOf("id: where")),
  );
  const options = [...where.matchAll(/^\s+- (.+)$/gm)].map((m) => m[1]!.trim());
  return { ids, options };
}

describe("the link to the bug form", () => {
  it("fills the version, where and system fields, encoded", () => {
    const url = new URL(
      bugReportUrl({
        version: "Server: v0.2.0-alpha.37, protocol 2, build abc1234 & more",
        where: "Desktop app",
        system: "Windows, desktop app",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/Blazeiscoding/OwnBase/issues/new",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      template: "bug_report.yml",
      version: "Server: v0.2.0-alpha.37, protocol 2, build abc1234 & more",
      where: "Desktop app",
      system: "Windows, desktop app",
    });
    // Nothing else from the report travels in the address.
    expect([...url.searchParams.keys()]).toHaveLength(4);
  });

  it("names only fields and options the form has", () => {
    const { ids, options } = bugForm();
    expect(ids).toEqual(expect.arrayContaining(["version", "where", "system"]));
    for (const where of REPORT_WHERE) expect(options).toContain(where);
  });
});

describe("where the problem is", () => {
  it("is the desktop app, a phone's browser or a web browser", () => {
    expect(reportWhere("desktop", DESKTOP_APP)).toBe("Desktop app");
    expect(reportWhere("web", WINDOWS)).toBe("In a web browser");
    expect(reportWhere("web", MAC_FIREFOX)).toBe("In a web browser");
    expect(reportWhere("web", ANDROID)).toBe("On a phone's browser");
    expect(reportWhere("web", IPHONE)).toBe("On a phone's browser");
  });
});

describe("the system", () => {
  it("names the operating system and the browser, or the desktop app", () => {
    expect(reportSystem("desktop", DESKTOP_APP)).toBe("Windows, desktop app");
    expect(reportSystem("web", WINDOWS)).toBe("Windows, Chrome");
    expect(reportSystem("web", ANDROID)).toBe("Android, Chrome");
    expect(reportSystem("web", IPHONE)).toBe("iOS, Safari");
    expect(reportSystem("web", MAC_FIREFOX)).toBe("macOS, Firefox");
    expect(reportSystem("web", "Something unheard of")).toBe("a browser");
  });
});

describe("the version", () => {
  const report = [
    "OwnBase diagnostics",
    "Taken: 2026-11-18T10:00:00.000Z",
    "App: desktop app, protocol 2, build abc1234",
    "Server: v0.2.0-alpha.37, protocol 2, build def5678",
    "Address: https://chat.example.org",
  ].join("\n");

  it("is the report's Server line, as the form asks", () => {
    expect(reportVersion(report)).toBe("Server: v0.2.0-alpha.37, protocol 2, build def5678");
  });

  it("is the app's own line when no server answered", () => {
    const unreachable = report.replace(
      /^Server: .*$/m,
      "Server: not reachable (Could not reach the workspace)",
    );
    expect(reportVersion(unreachable)).toBe("App: desktop app, protocol 2, build abc1234");
  });
});
