import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GATE_MARKER, writeGateReport } from "../src/main/releaseGate.js";

/** What the installed app tells the release gates about its own profile (F05). */
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "ownbase-gate-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the release gate report", () => {
  it("names the profile in use and the marker an earlier version left in it", async () => {
    const userData = temp();
    writeFileSync(join(userData, GATE_MARKER), "kept across upgrade\r\n");
    const out = join(temp(), "report.json");
    await writeGateReport(out, { userData, version: "0.2.0" }, async () => true);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      userData,
      version: "0.2.0",
      revision: null,
      marker: "kept across upgrade",
      settingsReadable: true,
    });
  });

  it("says plainly when the profile is fresh or its settings unreadable", async () => {
    const out = join(temp(), "report.json");
    const report = await writeGateReport(out, { userData: temp(), version: "0.2.0" }, async () => {
      throw new Error("unreadable settings");
    });
    expect(report.marker).toBe(null);
    expect(report.settingsReadable).toBe(false);
  });
});
