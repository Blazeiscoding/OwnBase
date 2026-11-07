import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHostingService, type FolderDialog } from "../src/main/hostingService.js";
import type { SettingsStorage } from "../src/main/settings.js";

function memorySettings(): SettingsStorage {
  const values = new Map<string, unknown>();
  return {
    get: async (key, options) =>
      values.has(key) ? values.get(key) : options?.distinguishMissing ? undefined : null,
    set: async (key, value) => void values.set(key, value),
    update: async (key, change) => {
      const next = change(values.get(key) ?? null);
      values.set(key, next);
      return next;
    },
    drain: async () => {},
  };
}

function service(options: { chosen?: string | null; background?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ownbase-hosting-service-"));
  const dialogs: FolderDialog[] = [];
  const onChange = vi.fn();
  const hosting = createHostingService({
    settings: memorySettings(),
    credentials: {
      isAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
    dataRoot: join(root, "hosted"),
    cloudflaredFolder: join(root, "cloudflared"),
    webDistPath: join(root, "web"),
    // No cloudflared anywhere, and none to install.
    env: { PATH: "" },
    platform: "linux",
    inWorker: () => Promise.reject(new Error("no worker in this test")),
    freeBytes: async () => 1e12,
    openPath: async () => "",
    chooseFolder: async (dialog) => {
      dialogs.push(dialog);
      return options.chosen ?? null;
    },
    backgroundAvailable: () => options.background ?? true,
    loginItem: null,
    onChange,
  });
  return { hosting, dialogs, onChange };
}

const event = {};

describe("the hosting service", () => {
  it("gives the whole status, what only the app knows included", async () => {
    const { hosting } = service({ background: false });
    expect(await hosting.handlers["hosting:status"](event)).toMatchObject({
      running: false,
      phase: "stopped",
      backgroundAvailable: false,
      tunnelAvailable: false,
    });
  });

  it("while OwnBase quits, answers only what reads or stops, and refuses the rest by code", async () => {
    const { hosting } = service();
    hosting.setQuitting(true);
    for (const call of [
      (): unknown => hosting.handlers["hosting:start"](event, { workspaceName: "Rocket Team" }),
      () => hosting.handlers["hosting:setPort"](event, "rocket-team", 9000),
      () => hosting.handlers["hosting:restore"](event),
      () => hosting.handlers["hosting:installCloudflared"](event),
    ])
      await expect(Promise.resolve().then(call)).rejects.toMatchObject({ code: "quitting" });

    await expect(hosting.handlers["hosting:list"](event)).resolves.toEqual({
      workspaces: [],
      unreadable: [],
    });
    await expect(hosting.handlers["hosting:stop"](event)).resolves.toBeUndefined();
    hosting.setQuitting(false);
    await expect(hosting.handlers["hosting:setPort"](event, "rocket-team", 9000)).rejects.toThrow(
      /not in the list/,
    );
  });

  it("asks the system for each folder the way that step needs, and does nothing when none is chosen", async () => {
    const { hosting, dialogs } = service({ chosen: null });
    expect(await hosting.handlers["hosting:backup"](event, "rocket-team")).toBeNull();
    expect(await hosting.handlers["hosting:restore"](event)).toBeNull();
    expect(await hosting.handlers["hosting:restoreOver"](event, "rocket-team", null)).toBeNull();
    expect(
      await hosting.handlers["hosting:setAutoBackup"](
        event,
        "rocket-team",
        { everyDays: 1, keep: 7 },
        true,
      ),
    ).toBeUndefined();
    expect(dialogs.map((dialog) => [dialog.buttonLabel, dialog.create])).toEqual([
      ["Back up here", true],
      ["Restore", false],
      ["Restore", false],
      ["Back up here", true],
    ]);
  });

  it("refuses opening at sign-in where this copy cannot", async () => {
    const { hosting } = service();
    expect(() => hosting.handlers["hosting:openAtLogin:get"](event)).toThrow(
      /installed on Windows or macOS/,
    );
  });
});
