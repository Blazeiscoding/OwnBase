import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import { Api, WorkspaceClient, type WorkspaceState } from "../src/index.js";

/**
 * Sidebar sections on the client (E8): the list comes with the snapshot and
 * keeps up with the account's other devices; a new order shows at once and
 * one refused shows what the server last said; deleting one lets its
 * conversations go.
 */
let server: WorkspaceServer;
let base: string;
let dataDir: string;
let token: string;

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

async function online() {
  const client = new WorkspaceClient(base, token);
  onTestFinished(() => client.destroy());
  client.connect();
  await until(client, (s) => s.status === "online", "connection");
  return client;
}
const names = (s: WorkspaceState) => (s.sidebarSections ?? []).map((section) => section.name);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "slackoss-client-sections-"));
  server = await createWorkspaceServer({ dataDir, port: 0, mdns: false, rateLimits: false });
  base = `http://127.0.0.1:${server.port}`;
  token = (
    await new Api(base).register({ handle: "alice", displayName: "Alice", password: "password123" })
  ).token;
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("sidebar sections on the client", () => {
  it("come with the snapshot and keep up with the account's other devices", async () => {
    const laptop = await online();
    const phone = await online();
    expect(laptop.state.sidebarSections).toEqual([]);

    const work = await laptop.createSidebarSection("  Work ");
    expect(work).toEqual({ id: expect.any(String), name: "Work" });
    expect(names(laptop.state)).toEqual(["Work"]);
    await until(phone, (s) => names(s).join() === "Work", "the phone to hear it");

    expect(await laptop.renameSidebarSection(work!.id, "Projects")).toBe(true);
    expect(names(laptop.state)).toEqual(["Projects"]);
    await until(phone, (s) => names(s).join() === "Projects", "the rename");

    // A conversation moved in shows there at once, and on the other device.
    const general = Object.values(laptop.state.channels).find((c) => c.name === "general")!;
    laptop.setChannelPrefs(general.id, { sectionId: work!.id, starred: false });
    expect(laptop.state.prefs[general.id]?.sectionId).toBe(work!.id);
    await until(phone, (s) => s.prefs[general.id]?.sectionId === work!.id, "the move");

    // Deleting the section lets it go, here and there.
    expect(await laptop.deleteSidebarSection(work!.id)).toBe(true);
    expect(laptop.state.sidebarSections).toEqual([]);
    await until(
      phone,
      (s) => s.sidebarSections?.length === 0 && s.prefs[general.id]?.sectionId === null,
      "the phone to let it go",
    );
  });

  it("show a new order at once, and what the server last said when it is refused", async () => {
    const laptop = await online();
    const phone = await online();
    const a = (await laptop.createSidebarSection("Alpha"))!;
    const b = (await laptop.createSidebarSection("Beta"))!;
    await until(phone, (s) => names(s).join() === "Alpha,Beta", "the phone's list");

    const ordered = laptop.orderSidebarSections([b.id, a.id]);
    expect(names(laptop.state)).toEqual(["Beta", "Alpha"]);
    expect(await ordered).toBe(true);
    await until(phone, (s) => names(s).join() === "Beta,Alpha", "the phone's order");

    // The phone adds one the laptop has not heard of yet, so the laptop's
    // order leaves one out and is refused: it shows the server's list.
    await new Api(base, token).createSidebarSection("Gamma");
    const stale = laptop.orderSidebarSections([a.id, b.id]);
    expect(await stale).toBe(false);
    await until(laptop, (s) => names(s).join() === "Beta,Alpha,Gamma", "the server's list");

    for (const section of laptop.state.sidebarSections!)
      await laptop.deleteSidebarSection(section.id);
  });

  it("are refused, not invented, where the server refuses", async () => {
    const laptop = await online();
    expect(await laptop.createSidebarSection("   ")).toBeNull();
    expect(await laptop.renameSidebarSection("S_MISSING", "Name")).toBe(false);
    expect(await laptop.deleteSidebarSection("S_MISSING")).toBe(false);
    expect(laptop.state.sidebarSections).toEqual([]);
  });
});
