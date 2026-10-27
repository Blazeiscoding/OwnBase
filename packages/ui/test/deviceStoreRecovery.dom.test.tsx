import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformContext } from "../src/context.js";
import {
  deviceStore,
  CHANGE_KEY,
  JOURNAL_PREFIX,
  LEGACY_PREFIX,
  OWNER_KEY,
} from "../src/lib/deviceStore.js";
import { previewFor, useNotificationPreviews } from "../src/lib/notificationPreview.js";
import { webPlatform } from "../src/platform.js";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const drafts = (text: string) => ({
  kind: "drafts" as const,
  changes: { put: { C1: text }, remove: [] },
  enveloped: false,
});
const journal = () => Object.keys(localStorage).filter((key) => key.startsWith(JOURNAL_PREFIX));
const account = "http://127.0.0.1:9 U1";

describe("device storage ownership and recovery (N02)", () => {
  it("keeps notifications private and sign-ins unreadable during opening failure, then retries in place", async () => {
    const healthy = webPlatform();
    await healthy.storage.mergeRecord!("notification-previews", { [account]: "none" });
    await healthy.storage.set("servers", [
      { url: "http://127.0.0.1:9", token: "synthetic-sign-in" },
    ]);
    const fault = vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new Error("opening refused");
    });
    const platform = webPlatform();
    let state!: ReturnType<typeof useNotificationPreviews>;
    function Reader() {
      state = useNotificationPreviews();
      return null;
    }
    render(
      <PlatformContext.Provider value={platform}>
        <Reader />
      </PlatformContext.Provider>,
    );
    await waitFor(() => expect(state.loaded).toBe(true));
    expect(state.unreadable).toBe(true);
    expect(state.error).toBeTruthy();
    expect(previewFor(state, account)).toBe("none");
    await expect(platform.storage.get("servers", { strict: true })).rejects.toThrow(
      "opening refused",
    );
    expect(localStorage.getItem(LEGACY_PREFIX + "servers")).toBeNull();
    fault.mockRestore();
    expect(await platform.storage.get("servers", { strict: true })).toEqual([
      { url: "http://127.0.0.1:9", token: "synthetic-sign-in" },
    ]);
    expect(await platform.storage.get("notification-previews", { strict: true })).toEqual({
      [account]: "none",
    });
  });

  it("rejects an alternative write, keeps its journal and recovers every word after reopening", async () => {
    const healthy = deviceStore();
    await healthy.apply("drafts:k", drafts("before failure"));
    const fault = vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new Error("opening refused");
    });
    const recovering = deviceStore();
    await expect(recovering.backend).rejects.toThrow();
    await expect(recovering.apply("drafts:k", drafts("during failure"))).rejects.toThrow();
    expect(journal()).toHaveLength(1);
    expect(localStorage.getItem(LEGACY_PREFIX + "drafts:k")).toBeNull();
    fault.mockRestore();
    expect(JSON.parse((await recovering.read("drafts:k"))!)).toEqual({ C1: "during failure" });
    expect(journal()).toEqual([]);
    await recovering.apply("drafts:k", drafts("after recovery"));
    expect(JSON.parse((await deviceStore().read("drafts:k"))!)).toEqual({ C1: "after recovery" });
  });

  it("does not expire a failed journal while storage is unavailable", async () => {
    const tab = deviceStore();
    await tab.backend;
    const fault = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(() => {
      throw new Error("transaction refused");
    });
    await expect(tab.apply("drafts:k", drafts("unsaved words"))).rejects.toThrow();
    const name = journal()[0]!;
    const entry = JSON.parse(localStorage.getItem(name)!);
    localStorage.setItem(name, JSON.stringify({ ...entry, at: 1 }));
    await expect(tab.read("drafts:k")).rejects.toThrow();
    expect(localStorage.getItem(name)).not.toBeNull();
    fault.mockRestore();
    expect(JSON.parse((await tab.read("drafts:k"))!)).toEqual({ C1: "unsaved words" });
  });

  it("keeps IndexedDB without BroadcastChannel and refreshes its watchers via invalidation", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const first = deviceStore();
    const second = deviceStore();
    await first.apply("notification-previews", { kind: "record", changes: { [account]: "none" } });
    expect(await second.backend).toBe("indexeddb");
    expect(JSON.parse((await second.read("notification-previews"))!)).toEqual({
      [account]: "none",
    });
    const heard = vi.fn();
    const stop = second.watch("notification-previews", heard);
    await first.apply("notification-previews", {
      kind: "record",
      changes: { [account]: "sender" },
    });
    const notice = localStorage.getItem(CHANGE_KEY)!;
    expect(notice).not.toContain("sender");
    window.dispatchEvent(
      new StorageEvent("storage", { key: CHANGE_KEY, newValue: notice, storageArea: localStorage }),
    );
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith({ [account]: "sender" }));
    stop();
  });

  it("refuses migration when ownership cannot be persisted, then retries without losing legacy data", async () => {
    localStorage.setItem(LEGACY_PREFIX + "drafts:k", JSON.stringify({ C1: "legacy words" }));
    const original = Storage.prototype.setItem;
    const fault = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key === OWNER_KEY) throw new DOMException("Full", "QuotaExceededError");
      return original.call(this, key, value);
    });
    const tab = deviceStore();
    await expect(tab.backend).rejects.toThrow("Full");
    await expect(tab.read("drafts:k")).rejects.toThrow("Full");
    expect(localStorage.getItem(LEGACY_PREFIX + "drafts:k")).toContain("legacy words");
    fault.mockRestore();
    expect(JSON.parse((await tab.read("drafts:k"))!)).toEqual({ C1: "legacy words" });
    expect(localStorage.getItem(OWNER_KEY)).toBe("indexeddb");
  });

  it("does not let a local-only tab acknowledge writes after another tab adopts IndexedDB", async () => {
    const factory = indexedDB;
    vi.stubGlobal("indexedDB", undefined);
    const local = deviceStore();
    await local.apply("drafts:k", drafts("local words"));
    vi.stubGlobal("indexedDB", factory);
    const indexed = deviceStore();
    expect(JSON.parse((await indexed.read("drafts:k"))!)).toEqual({ C1: "local words" });
    expect(localStorage.getItem(OWNER_KEY)).toBe("indexeddb");
    await expect(local.apply("drafts:k", drafts("unacknowledged"))).rejects.toThrow("unavailable");
    vi.stubGlobal("indexedDB", undefined);
    const unavailable = deviceStore();
    await expect(unavailable.backend).rejects.toThrow("unavailable");
    await expect(unavailable.read("drafts:k")).rejects.toThrow("unavailable");
  });

  it("reports an actual blocked upgrade, then recovers its private value without a reload", async () => {
    const held = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ownbase-device", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("values");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = held.transaction("values", "readwrite");
      tx.objectStore("values").put(JSON.stringify({ [account]: "none" }), "notification-previews");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const tab = deviceStore();
    try {
      await expect(tab.backend).rejects.toThrow("older tab");
    } finally {
      held.close();
    }
    expect(JSON.parse((await tab.read("notification-previews"))!)).toEqual({ [account]: "none" });
  });

  it("makes an old local-only window private when ownership moves, ignoring stale legacy notices", async () => {
    const factory = indexedDB;
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("BroadcastChannel", undefined);
    const local = webPlatform();
    let state!: ReturnType<typeof useNotificationPreviews>;
    function Reader() {
      state = useNotificationPreviews();
      return null;
    }
    render(
      <PlatformContext.Provider value={local}>
        <Reader />
      </PlatformContext.Provider>,
    );
    await waitFor(() => expect(state.loaded).toBe(true));
    expect(previewFor(state, account)).toBe("full");
    vi.stubGlobal("indexedDB", factory);
    const indexed = deviceStore();
    await indexed.apply("notification-previews", {
      kind: "record",
      changes: { [account]: "none" },
    });
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: OWNER_KEY,
        newValue: "indexeddb",
        storageArea: localStorage,
      }),
    );
    await waitFor(() => expect(state.unreadable).toBe(true));
    const stale = JSON.stringify({ [account]: "full" });
    localStorage.setItem(LEGACY_PREFIX + "notification-previews", stale);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: LEGACY_PREFIX + "notification-previews",
        newValue: stale,
        storageArea: localStorage,
      }),
    );
    expect(previewFor(state, account)).toBe("none");
    expect(state.unreadable).toBe(true);
  });

  it("recovers both acknowledged enveloped draft versions left by the previous fallback", async () => {
    const key = "local:v1:W1:U1:drafts";
    const tab = deviceStore();
    await tab.apply(key, { kind: "set", value: { version: 1, value: { C1: "database words" } } });
    localStorage.setItem(
      LEGACY_PREFIX + key,
      JSON.stringify({ version: 1, value: { C1: "fallback words", C2: "another conversation" } }),
    );
    expect(JSON.parse((await tab.read(key))!)).toEqual({
      version: 1,
      value: { C1: "fallback words\n\ndatabase words", C2: "another conversation" },
    });
    expect(localStorage.getItem(LEGACY_PREFIX + key)).toBeNull();
    expect(await tab.read(key)).toBe(await deviceStore().read(key));
  });

  it("reconciles outbox tombstones instead of reviving an already-removed send", async () => {
    const tab = deviceStore();
    const entry = {
      nonce: "n1",
      channelId: "C1",
      threadRootId: null,
      text: "fixture",
      userId: "U1",
      createdAt: 1,
      attachments: [],
      rev: 1,
    };
    await tab.apply("outbox:k", {
      kind: "outbox",
      changes: { put: [entry], remove: [] },
      enveloped: false,
    });
    localStorage.setItem(
      LEGACY_PREFIX + "outbox:k",
      JSON.stringify({ outbox: 2, entries: [], removed: [{ nonce: "n1", rev: 2 }] }),
    );
    const recovered = JSON.parse((await tab.read("outbox:k"))!);
    expect(recovered.entries).toEqual([]);
    expect(recovered.removed).toContainEqual({ nonce: "n1", rev: 2 });
    expect(localStorage.getItem(LEGACY_PREFIX + "outbox:k")).toBeNull();
  });

  it("takes the more private old-backend choice while preserving other account choices", async () => {
    const tab = deviceStore();
    await tab.apply("notification-previews", {
      kind: "record",
      changes: { [account]: "none", "other U2": "sender" },
    });
    localStorage.setItem(
      LEGACY_PREFIX + "notification-previews",
      JSON.stringify({ [account]: "full", "new U3": "none" }),
    );
    expect(JSON.parse((await tab.read("notification-previews"))!)).toEqual({
      [account]: "none",
      "other U2": "sender",
      "new U3": "none",
    });
  });

  it("retains an unrecognized conflicting copy until explicit replacement retires it", async () => {
    const tab = deviceStore();
    await tab.apply("servers", { kind: "set", value: [] });
    localStorage.setItem(LEGACY_PREFIX + "servers", JSON.stringify(["an old fallback"]));
    expect(await tab.read("servers")).toBe("[]");
    expect(localStorage.getItem(LEGACY_PREFIX + "servers")).not.toBeNull();
    await tab.apply("servers", { kind: "set", value: [] });
    expect(localStorage.getItem(LEGACY_PREFIX + "servers")).toBeNull();
  });

  it("keeps deduplication for an old unretired journal so a forgotten sign-in stays forgotten", async () => {
    const first = deviceStore({ tab: "old-tab" });
    await first.backend;
    const change = first.apply("servers", { kind: "set", value: ["synthetic sign-in"] });
    const name = journal()[0]!;
    const entry = localStorage.getItem(name)!;
    await change;
    await first.apply("servers", { kind: "set", value: [] });
    localStorage.setItem(name, entry);
    const future = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 40 * 24 * 60 * 60 * 1000);
    const other = deviceStore();
    await other.backend;
    // Emulate a localStorage retirement failure by restoring its same copy.
    localStorage.setItem(name, entry);
    await other.apply("servers", { kind: "set", value: [] });
    expect(await deviceStore().read("servers")).toBe("[]");
    future.mockRestore();
  });
});
