import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupWorkspace, restoreWorkspace } from "../src/backup.js";
import { holdWorkspace } from "../src/ownership.js";
import { createWorkspaceServer } from "../src/server.js";

/**
 * A restore that fails after it has taken the workspace for itself must give
 * it back before it reports the failure, whatever step failed, and leave the
 * workspace as it was (RECHECK-10). This file fails `mkdtemp` on demand, the
 * first thing a restore does once it holds the workspace.
 */
const failNext = { mkdtemp: null as NodeJS.ErrnoException | null };

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fsPromises>();
  return {
    ...actual,
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const error = failNext.mkdtemp;
      failNext.mkdtemp = null;
      if (error) throw error;
      return actual.mkdtemp(...args);
    },
  };
});

let root: string;
let dataDir: string;
let backupDir: string;

const fingerprint = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ownbase-restore-failure-"));
  dataDir = join(root, "workspace");
  backupDir = join(root, "backup");
  const server = await createWorkspaceServer({ dataDir, host: "127.0.0.1", port: 0, mdns: false });
  await fetch(`http://127.0.0.1:${server.port}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "owner", displayName: "Owner", password: "password123" }),
  });
  await server.stop();
  await backupWorkspace({ dataDir, out: backupDir });
});

afterEach(() => {
  failNext.mkdtemp = null;
  rmSync(root, { recursive: true, force: true });
});

describe("a restore that cannot stage its backup", () => {
  it("gives the workspace back and leaves it exactly as it was", async () => {
    const database = join(dataDir, "workspace.db");
    const before = fingerprint(database);
    failNext.mkdtemp = Object.assign(new Error("ENOSPC: no space left on device, mkdtemp"), {
      code: "ENOSPC",
    });

    await expect(restoreWorkspace({ backupDir, dataDir })).rejects.toThrow(/ENOSPC/);

    // Still this process: the hold is back, so another restore or a server may take it.
    const next = holdWorkspace(dataDir, "a test");
    next.release();
    expect(fingerprint(database)).toBe(before);
    expect(readdirSync(root).filter((name) => name.includes(".restoring-"))).toEqual([]);

    // And a restore once space is back goes ahead.
    const { supersededDir } = await restoreWorkspace({ backupDir, dataDir });
    expect(supersededDir && existsSync(supersededDir)).toBe(true);
    expect(existsSync(database)).toBe(true);
  });
});
