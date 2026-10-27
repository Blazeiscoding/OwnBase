import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient, type WorkspaceState } from "../src/index.js";

/**
 * Blocking and reporting on the client (E12): a block reaches every device
 * of the account and silences whoever it names; a report reaches the admins'
 * count, which the queue's answers bring back down.
 */
let server: WorkspaceServer;
let base: string;
let dataDir: string;
const accounts: Record<string, { token: string; id: string }> = {};

function until(
  client: WorkspaceClient,
  predicate: (s: WorkspaceState) => boolean,
  label = "condition",
): Promise<WorkspaceState> {
  return new Promise((resolve, reject) => {
    if (predicate(client.state)) return resolve(client.state);
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${label}`));
    }, 5000);
    const unsubscribe = client.store.subscribe((s) => {
      if (predicate(s)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(s);
      }
    });
  });
}

async function online(handle: string) {
  const client = new WorkspaceClient(base, accounts[handle]!.token);
  onTestFinished(() => client.destroy());
  client.connect();
  await until(client, (s) => s.status === "online", "connection");
  return client;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-client-moderation-"));
  server = await createWorkspaceServer({ dataDir, port: 0, mdns: false, rateLimits: false });
  base = `http://127.0.0.1:${server.port}`;
  for (const handle of ["owner", "maya", "sam"]) {
    const made = await new Api(base).register({
      handle,
      displayName: handle,
      password: "password123",
    });
    accounts[handle] = { token: made.token, id: made.user.id };
  }
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("blocking on the client", () => {
  it("keeps the list on every device of the account", async () => {
    const laptop = await online("maya");
    const phone = await online("maya");
    expect(laptop.state.blocked).toEqual([]);
    expect(await laptop.setBlocked(accounts.sam!.id, true)).toBe(true);
    expect(laptop.state.blocked).toEqual([accounts.sam!.id]);
    await until(phone, (s) => s.blocked?.includes(accounts.sam!.id) === true, "the other device");
    // A device coming online later has it from the snapshot.
    const tablet = await online("maya");
    expect(tablet.state.blocked).toEqual([accounts.sam!.id]);
    // The answer is kept as well, for a device whose socket is not up yet.
    const offline = new WorkspaceClient(base, accounts.maya!.token);
    onTestFinished(() => offline.destroy());
    expect(await offline.setBlocked(accounts.owner!.id, true)).toBe(true);
    expect(offline.state.blocked).toEqual([accounts.sam!.id, accounts.owner!.id]);
    expect(await offline.setBlocked(accounts.owner!.id, false)).toBe(true);
    expect(await phone.setBlocked(accounts.sam!.id, false)).toBe(true);
    await until(laptop, (s) => s.blocked?.length === 0, "unblocked everywhere");
    // Refused, it says so and keeps what it had.
    expect(await laptop.setBlocked(accounts.maya!.id, true)).toBe(false);
    expect(laptop.state.blocked).toEqual([]);
  });
});

describe("reporting on the client", () => {
  it("raises the admins' count and no one else's, and the queue's answer lowers it", async () => {
    const admin = await online("owner");
    const member = await online("sam");
    expect(admin.state.openReports).toBe(0);
    expect(member.state.openReports).toBeNull();
    const general = server.store.getChannelByName("general")!.id;
    const maya = new Api(base, accounts.maya!.token);
    const { message } = await maya.sendMessage(general, { text: "rude words" });

    await member.api.reportMessage(message.id, "harassment", "  not the first time ");
    await until(admin, (s) => s.openReports === 1, "the report counted");
    const { reports } = await admin.api.listReports();
    expect(reports).toMatchObject([
      { messageId: message.id, reports: [{ reason: "harassment", note: "not the first time" }] },
    ]);
    await admin.api.resolveReport(message.id, "dismiss");
    await until(admin, (s) => s.openReports === 0, "the report settled");
    expect(member.state.openReports).toBeNull();
  });
});
