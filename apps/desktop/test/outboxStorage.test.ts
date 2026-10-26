import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOutboxChanges,
  readStoredOutbox,
  unwrapStoredOutbox,
  type StoredOutboxEntry,
} from "@slackoss/client-core/outbox";
import type { CredentialProtector } from "../src/main/credentials.js";
import { mergeOutboxSetting } from "../src/main/outboxStorage.js";
import { createSettingsStorage, type SettingsStorage } from "../src/main/settings.js";

/**
 * The outbox every window on one account shares, stored in the settings file.
 * A window's changes are merged in the main process, one at a time, so no
 * window can write over a send another has just stored.
 */
const keys: CredentialProtector = {
  isAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8"),
  decryptString: (value) => value.toString("utf8"),
};

const KEY = "local:v1:W1:U1:outbox";

function entry(nonce: string, rev: number): StoredOutboxEntry {
  return {
    nonce,
    channelId: "C1",
    threadRootId: null,
    text: `sent from ${nonce}`,
    userId: "U1",
    createdAt: 1,
    attachments: [],
    rev,
  };
}

let dir: string;
let settings: SettingsStorage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ownbase-outbox-"));
  settings = createSettingsStorage(join(dir, "settings.json"), keys);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const storedNonces = async () =>
  unwrapStoredOutbox(await settings.get(KEY), true)!.entries.map((e) => e.nonce);

describe("sends queued in two windows at the same moment", () => {
  it("are lost by windows reading and writing the whole outbox themselves", async () => {
    // How windows wrote before: each read over IPC, merged, and wrote back.
    const readThenWrite = async (nonce: string) => {
      const stored = await settings.get(KEY);
      const { value } = applyOutboxChanges(stored, { put: [entry(nonce, 1)], remove: [] }, true);
      await settings.set(KEY, value);
    };
    await Promise.all([readThenWrite("first-window"), readThenWrite("second-window")]);
    expect(await storedNonces()).toEqual(["second-window"]);
  });

  it("are both kept when merged here", async () => {
    const [first, second] = await Promise.all([
      mergeOutboxSetting(settings, KEY, { put: [entry("first-window", 1)], remove: [] }, true),
      mergeOutboxSetting(settings, KEY, { put: [entry("second-window", 2)], remove: [] }, true),
    ]);
    expect(await storedNonces()).toEqual(["first-window", "second-window"]);
    // Each window hears what was stored once its own change was in.
    expect(first.outbox.entries.map((e) => e.nonce)).toEqual(["first-window"]);
    expect(second.value).toEqual({ version: 1, value: second.outbox });
  });

  it("keep a removal against a window still holding the send", async () => {
    await mergeOutboxSetting(settings, KEY, { put: [entry("A", 1)], remove: [] }, true);
    await Promise.all([
      mergeOutboxSetting(settings, KEY, { put: [], remove: [{ nonce: "A", rev: 5 }] }, true),
      mergeOutboxSetting(settings, KEY, { put: [entry("A", 1), entry("B", 6)], remove: [] }, true),
    ]);
    expect(await storedNonces()).toEqual(["B"]);
  });
});

describe("what a window may send here", () => {
  it("refuses changes that are not an outbox's, and the saved sign-ins key", async () => {
    await expect(mergeOutboxSetting(settings, KEY, { put: "all" } as never, true)).rejects.toThrow(
      "Invalid outbox changes.",
    );
    await expect(
      mergeOutboxSetting(settings, "servers", { put: [], remove: [] }, false),
    ).rejects.toThrow("Invalid settings key.");
    expect(await settings.get("servers")).toBeNull();
  });

  it("replaces an unreadable outbox with what the window sends, in the shape it asked for", async () => {
    await settings.set("outbox:http://host:8543:U1", "not an outbox");
    await mergeOutboxSetting(
      settings,
      "outbox:http://host:8543:U1",
      { put: [entry("A", 1)], remove: [] },
      false,
    );
    expect(readStoredOutbox(await settings.get("outbox:http://host:8543:U1"))!.entries).toEqual([
      entry("A", 1),
    ]);
  });
});
