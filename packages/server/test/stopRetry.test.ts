import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { holdWorkspace, WorkspaceInUseError } from "../src/ownership.js";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

/**
 * A shutdown whose drain fails part-way can be tried again, and the second
 * try finishes the work the first left instead of repeating the same failure
 * (RECHECK-11). Until it has, the workspace stays held: something of this
 * server may still be using the database.
 */
let root: string;
let dataDir: string;
let server: WorkspaceServer | null;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ownbase-stop-retry-"));
  dataDir = join(root, "workspace");
  server = await createWorkspaceServer({ dataDir, host: "127.0.0.1", port: 0, mdns: false });
});

afterEach(async () => {
  await server?.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

const heldBySomeoneElse = () => {
  try {
    holdWorkspace(dataDir, "a test").release();
    return false;
  } catch (error) {
    if (error instanceof WorkspaceInUseError) return true;
    throw error;
  }
};

describe("stopping a workspace server that fails part-way", () => {
  it("keeps the workspace held after the failure, and lets a retry finish the job", async () => {
    const running = server!;
    const close = vi.spyOn(running.gateway, "close");
    close.mockRejectedValueOnce(new Error("could not close the sockets"));

    await expect(running.stop()).rejects.toThrow("could not close the sockets");
    // Nothing was released that something may still be using.
    expect(heldBySomeoneElse()).toBe(true);

    await running.stop();
    expect(close).toHaveBeenCalledTimes(2);
    expect(heldBySomeoneElse()).toBe(false);
    // And a stopped server stays stopped: another stop does nothing more.
    await running.stop();
    expect(close).toHaveBeenCalledTimes(2);
    server = null;

    // The folder opens again.
    server = await createWorkspaceServer({ dataDir, host: "127.0.0.1", port: 0, mdns: false });
    await server.stop();
    server = null;
  });

  it("does not repeat a stage that finished when the database fails to close", async () => {
    const running = server!;
    const close = vi.spyOn(running.gateway, "close");
    const closeDatabase = vi.spyOn(DatabaseSync.prototype, "close");
    closeDatabase.mockImplementationOnce(() => {
      throw new Error("database is locked");
    });

    await expect(running.stop()).rejects.toThrow("database is locked");
    expect(heldBySomeoneElse()).toBe(true);

    await running.stop();
    // The sockets were closed once; only what had not finished ran again.
    expect(close).toHaveBeenCalledTimes(1);
    expect(heldBySomeoneElse()).toBe(false);
    closeDatabase.mockRestore();
    server = null;
  });
});
