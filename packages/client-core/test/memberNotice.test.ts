import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient, type WorkspaceState } from "../src/index.js";

/**
 * A plan's member notice on the client (P5): the owner's and admins' clients
 * keep what the server's snapshot says, and nobody else's has it.
 */
let server: WorkspaceServer;
let base: string;
const tokens: Record<string, string> = {};
const notice = { members: 1, planName: "Team", upgradeUrl: "https://example.com/plans" };
const serverNotice = { id: "probe:1", tone: "alert" as const, text: "The probe needs you." };

function until(client: WorkspaceClient, predicate: (s: WorkspaceState) => boolean) {
  return new Promise<WorkspaceState>((resolve, reject) => {
    if (predicate(client.state)) return resolve(client.state);
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("timed out waiting for the connection"));
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
  const client = new WorkspaceClient(base, tokens[handle]!);
  onTestFinished(() => client.destroy());
  client.connect();
  await until(client, (s) => s.status === "online");
  return client;
}

beforeAll(async () => {
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    port: 0,
    mdns: false,
    rateLimits: false,
    memberNotice: notice,
    // What an extension, such as ee/'s, tells the owner and admins (P6).
    extensions: [{ name: "probe", notice: () => serverNotice }],
  });
  base = `http://127.0.0.1:${server.port}`;
  for (const handle of ["owner", "sam"]) {
    tokens[handle] = (
      await new Api(base).register({ handle, displayName: handle, password: "password123" })
    ).token;
  }
});

afterAll(async () => {
  await server?.stop();
});

describe("the member notice on the client", () => {
  it("is kept for the owner from the snapshot, and is null for a member", async () => {
    expect((await online("owner")).state.memberNotice).toEqual(notice);
    expect((await online("sam")).state.memberNotice).toBeNull();
  });

  it("keeps the server's notices for the owner, and none for a member", async () => {
    expect((await online("owner")).state.serverNotices).toEqual([serverNotice]);
    expect((await online("sam")).state.serverNotices).toEqual([]);
  });
});
