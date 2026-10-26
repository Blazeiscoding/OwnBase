import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDraftChanges, unwrapStoredDrafts } from "@slackoss/client-core/drafts";
import type { CredentialProtector } from "../src/main/credentials.js";
import { mergeDraftsSetting } from "../src/main/draftsStorage.js";
import { createSettingsStorage, type SettingsStorage } from "../src/main/settings.js";

/**
 * The drafts every window on one account shares, stored in the settings file
 * (RECHECK-04). A window's changed drafts are merged in the main process, one
 * window at a time, so a draft typed in one conversation is not lost to
 * another window's write about a different one.
 */
const keys: CredentialProtector = {
  isAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8"),
  decryptString: (value) => value.toString("utf8"),
};

const KEY = "local:v1:W1:U1:drafts";

let dir: string;
let settings: SettingsStorage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ownbase-drafts-"));
  settings = createSettingsStorage(join(dir, "settings.json"), keys);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stored = async () => unwrapStoredDrafts(await settings.get(KEY), true);

describe("drafts written from two windows at the same moment", () => {
  it("are lost by windows reading and writing all the drafts themselves", async () => {
    const readThenWrite = async (key: string, text: string) => {
      const current = await settings.get(KEY);
      const { value } = applyDraftChanges(current, { put: { [key]: text }, remove: [] }, true);
      await settings.set(KEY, value);
    };
    await Promise.all([readThenWrite("C1", "first window"), readThenWrite("C2", "second window")]);
    expect(await stored()).toEqual({ C2: "second window" });
  });

  it("are both kept when merged here", async () => {
    const [first, second] = await Promise.all([
      mergeDraftsSetting(settings, KEY, { put: { C1: "first window" }, remove: [] }, true),
      mergeDraftsSetting(settings, KEY, { put: { C2: "second window" }, remove: [] }, true),
    ]);
    expect(await stored()).toEqual({ C1: "first window", C2: "second window" });
    // Each window hears what was stored once its own change was in.
    expect(first.drafts).toEqual({ C1: "first window" });
    expect(second.value).toEqual({ version: 1, value: second.drafts });
  });

  it("keep a draft one window cleared against another's unrelated write", async () => {
    await mergeDraftsSetting(
      settings,
      KEY,
      { put: { C1: "ready", C2: "other" }, remove: [] },
      true,
    );
    await Promise.all([
      mergeDraftsSetting(settings, KEY, { put: {}, remove: ["C1"] }, true),
      mergeDraftsSetting(settings, KEY, { put: { C2: "edited" }, remove: [] }, true),
    ]);
    expect(await stored()).toEqual({ C2: "edited" });
  });
});

describe("what a window may write here", () => {
  it("refuses changes that are not drafts', and the saved sign-ins key", async () => {
    await expect(
      mergeDraftsSetting(settings, KEY, { put: { C1: 3 }, remove: [] } as never, true),
    ).rejects.toThrow("Invalid draft changes.");
    await expect(
      mergeDraftsSetting(settings, "servers", { put: {}, remove: [] }, false),
    ).rejects.toThrow("Invalid settings key.");
    expect(await settings.get("servers")).toBeNull();
  });
});
