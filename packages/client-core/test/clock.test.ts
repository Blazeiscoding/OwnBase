import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient } from "../src/index.js";

/**
 * Reminders and scheduled messages go at a time this device chose, so the
 * client learns on connecting how far its clock is off the workspace's.
 */
let server: WorkspaceServer;
let base: string;
let dataDir: string;
let token: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-clock-"));
  server = await createWorkspaceServer({ dataDir, port: 0, mdns: false, rateLimits: false });
  base = `http://127.0.0.1:${server.port}`;
  token = (
    await new Api(base).register({ handle: "sam", displayName: "Sam", password: "password123" })
  ).token;
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the workspace's clock", () => {
  it("is unknown until connected, then known to within the time a message takes", async () => {
    const client = new WorkspaceClient(base, token);
    onTestFinished(() => client.destroy());
    expect(client.state.clockSkewMs).toBeNull();
    client.connect();
    await new Promise<void>((resolve) => {
      const stop = client.store.subscribe((s) => {
        if (s.status === "online") {
          stop();
          resolve();
        }
      });
    });
    // One process, one clock: what is left is only the trip.
    expect(client.state.clockSkewMs).not.toBeNull();
    expect(Math.abs(client.state.clockSkewMs!)).toBeLessThan(2_000);
  });
});
