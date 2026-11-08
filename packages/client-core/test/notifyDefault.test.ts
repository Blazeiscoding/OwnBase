import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, ApiError, WorkspaceClient } from "../src/index.js";
import type { WorkspaceState } from "../src/index.js";

/**
 * The account's default for what notifies (v53): changed from one device,
 * known on the others, followed by every conversation not given a level of
 * its own.
 */
let server: WorkspaceServer;
let base: string;
let dataDir: string;
let token: string;
let general: string;

function until(
  client: WorkspaceClient,
  predicate: (s: WorkspaceState) => boolean,
  label = "condition",
  timeoutMs = 5000,
): Promise<WorkspaceState> {
  return new Promise((resolve, reject) => {
    if (predicate(client.state)) return resolve(client.state);
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    const unsubscribe = client.store.subscribe((s) => {
      if (predicate(s)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(s);
      }
    });
  });
}

async function online() {
  const client = new WorkspaceClient(base, token);
  onTestFinished(() => client.destroy());
  client.connect();
  await until(client, (s) => s.status === "online", "connection");
  return client;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-notify-default-"));
  server = await createWorkspaceServer({
    dataDir,
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  base = `http://127.0.0.1:${server.port}`;
  token = (
    await new Api(base).register({ handle: "sam", displayName: "Sam", password: "password123" })
  ).token;
  general = server.store.getChannelByName("general")!.id;
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the default for what notifies", () => {
  it("arrives with the snapshot, and a change reaches the account's other devices", async () => {
    const laptop = await online();
    const phone = await online();
    expect(laptop.state.notifyDefault).toBe("mentions");
    expect(laptop.state.prefs[general]).toMatchObject({ notifyChosen: false });

    expect(await laptop.setNotifyDefault("all")).toBeNull();
    expect(laptop.state.notifyDefault).toBe("all");
    await until(phone, (s) => s.notifyDefault === "all", "the phone hearing of it");
    await laptop.setNotifyDefault("mentions");
    await until(phone, (s) => s.notifyDefault === "mentions", "the change back");
  });

  it("is shown at once, and put back when the server refuses", async () => {
    const client = await online();
    let refuse = () => {};
    vi.spyOn(client.api, "setNotifyDefault").mockImplementation(
      () => new Promise((_, reject) => (refuse = () => reject(new ApiError(500, "internal")))),
    );
    const saving = client.setNotifyDefault("nothing");
    expect(client.state.notifyDefault).toBe("nothing");
    refuse();
    expect(await saving).toBeInstanceOf(ApiError);
    expect(client.state.notifyDefault).toBe("mentions");
  });

  it("is left by a conversation given a level of its own, at once, and taken up again", async () => {
    const client = await online();
    client.setChannelPrefs(general, { notifyLevel: "all" });
    expect(client.state.prefs[general]).toMatchObject({ notifyLevel: "all", notifyChosen: true });
    await until(client, (s) => !s.prefsWrites[general], "the save");
    expect(server.store.getChannelPrefs(general, client.state.self!.id)).toMatchObject({
      notifyChosen: true,
    });
    client.setChannelPrefs(general, { notifyChosen: false });
    await until(client, (s) => !s.prefsWrites[general], "the save back");
    expect(client.state.prefs[general]).toMatchObject({ notifyChosen: false });
  });
});
