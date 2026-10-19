import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JOURNAL_PREFIX,
  LEGACY_PREFIX,
  OWNER_KEY,
  CHANGE_KEY,
  deviceStore,
  type DeviceStore,
  type StoreOp,
} from "../src/lib/deviceStore.js";
import { webPlatform } from "../src/platform.js";

/**
 * The web client's device storage in IndexedDB (F01): each change one
 * transaction every tab waits its turn for, written down first so a page
 * that closes mid-change has it made the next time, and told to other tabs.
 * Each `deviceStore()` here stands for one tab.
 */
beforeEach(() => {
  // A fresh browser profile for each test.
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const draftsOp = (put: Record<string, string>, base?: Record<string, string | null>): StoreOp => ({
  kind: "drafts",
  changes: { put, remove: [], base },
  enveloped: false,
});

async function value(store: DeviceStore, key: string) {
  const raw = await store.read(key);
  return raw === null ? null : JSON.parse(raw);
}

describe("device storage in IndexedDB (F01)", () => {
  it("is used where the browser has it, and keeps nothing in localStorage", async () => {
    const tab = deviceStore();
    expect(await tab.backend).toBe("indexeddb");
    await tab.apply("drafts:k", draftsOp({ C1: "hello" }));
    expect(await value(tab, "drafts:k")).toEqual({ C1: "hello" });
    expect(localStorage.getItem(`${LEGACY_PREFIX}drafts:k`)).toBe(null);
    expect(Object.keys(localStorage).filter((k) => k.startsWith(JOURNAL_PREFIX))).toEqual([]);
  });

  it("keeps both texts when two tabs change one draft from the same text at once", async () => {
    const first = deviceStore();
    const second = deviceStore();
    await Promise.all([first.backend, second.backend]);
    await Promise.all([
      first.apply("drafts:k", draftsOp({ C1: "from the first" }, { C1: null })),
      second.apply("drafts:k", draftsOp({ C1: "from the second" }, { C1: null })),
    ]);
    const stored = (await value(first, "drafts:k")) as { C1: string };
    expect(stored.C1).toContain("from the first");
    expect(stored.C1).toContain("from the second");
  });

  it("loses no tab's change when many arrive at once", async () => {
    const tabs = [deviceStore(), deviceStore(), deviceStore()];
    await Promise.all(tabs.map((tab) => tab.backend));
    await Promise.all(
      tabs.flatMap((tab, t) =>
        Array.from({ length: 20 }, (_, i) =>
          tab.apply("record:k", { kind: "record", changes: { [`tab${t}-${i}`]: "x" } }),
        ),
      ),
    );
    expect(Object.keys((await value(tabs[0]!, "record:k")) as object)).toHaveLength(60);
  });

  it("migrates legacy drafts and preserves both versions from an older fallback", async () => {
    localStorage.setItem(`${LEGACY_PREFIX}drafts:k`, JSON.stringify({ C1: "from before" }));
    const tab = deviceStore();
    expect(await value(tab, "drafts:k")).toEqual({ C1: "from before" });
    expect(localStorage.getItem(`${LEGACY_PREFIX}drafts:k`)).toBe(null);
    // An old fallback may have acknowledged different words. Neither copy is disposable.
    localStorage.setItem(`${LEGACY_PREFIX}drafts:k`, JSON.stringify({ C1: "stale" }));
    await tab.apply("drafts:k", draftsOp({ C2: "new" }));
    expect(await value(tab, "drafts:k")).toEqual({ C1: "stale\n\nfrom before", C2: "new" });
    expect(localStorage.getItem(`${LEGACY_PREFIX}drafts:k`)).toBe(null);
  });

  it("keeps no forgotten sign-in in localStorage", async () => {
    const signIn = [{ url: "http://127.0.0.1:9", token: "test-token-not-a-credential" }];
    localStorage.setItem(`${LEGACY_PREFIX}servers`, JSON.stringify(signIn));
    const tab = deviceStore();
    expect(await value(tab, "servers")).toEqual(signIn);
    await tab.apply("servers", { kind: "set", value: [] });
    expect(await value(deviceStore(), "servers")).toEqual([]);
    expect(JSON.stringify({ ...localStorage })).not.toContain("test-token-not-a-credential");
  });

  it("never fills an emptied key again from localStorage", async () => {
    localStorage.setItem(`${LEGACY_PREFIX}last`, JSON.stringify("C1"));
    const tab = deviceStore();
    await tab.apply("last", { kind: "set", value: null });
    expect(await value(tab, "last")).toBe(null);
    expect(await value(deviceStore(), "last")).toBe(null);
  });

  it("writes a change down before it is made, and crosses it out once stored", async () => {
    const tab = deviceStore();
    await tab.backend;
    const journal = () => Object.keys(localStorage).filter((k) => k.startsWith(JOURNAL_PREFIX));
    const storing = tab.apply("drafts:k", draftsOp({ C1: "last words" }));
    // Already written down, before anything was awaited: a closing page keeps it.
    expect(journal()).toHaveLength(1);
    await storing;
    expect(journal()).toEqual([]);
  });

  it("makes a change the next time when the page closed before it was stored", async () => {
    // What a page that closed mid-change leaves: the change written down, and
    // its transaction never run.
    localStorage.setItem(
      `${JOURNAL_PREFIX}gone:1`,
      JSON.stringify({
        key: "drafts:k",
        op: draftsOp({ C1: "typed as it closed" }),
        at: 1,
        seq: 1,
      }),
    );
    localStorage.setItem(
      `${JOURNAL_PREFIX}gone:2`,
      JSON.stringify({ key: "drafts:k", op: draftsOp({ C2: "and this" }), at: 1, seq: 2 }),
    );
    const next = deviceStore();
    expect(await value(next, "drafts:k")).toEqual({ C1: "typed as it closed", C2: "and this" });
    expect(Object.keys(localStorage).filter((k) => k.startsWith(JOURNAL_PREFIX))).toEqual([]);
    // Made again, as two tabs starting together might: nothing changes.
    localStorage.setItem(
      `${JOURNAL_PREFIX}gone:1`,
      JSON.stringify({
        key: "drafts:k",
        op: draftsOp({ C1: "typed as it closed" }),
        at: 1,
        seq: 1,
      }),
    );
    expect(await value(deviceStore(), "drafts:k")).toEqual({
      C1: "typed as it closed",
      C2: "and this",
    });
  });

  it("never makes a change again over a newer one, when another tab finds it still written down", async () => {
    const tab = deviceStore();
    await tab.backend;
    // What a tab starting meanwhile could find: the first change written
    // down, its transaction not yet finished.
    let found: [string, string][] = [];
    const first = tab.apply("servers", { kind: "set", value: ["a sign-in"] });
    found = Object.keys(localStorage)
      .filter((name) => name.startsWith(JOURNAL_PREFIX))
      .map((name) => [name, localStorage.getItem(name)!]);
    await first;
    // Forgotten since, in the same tab.
    await tab.apply("servers", { kind: "set", value: [] });
    for (const [name, entry] of found) localStorage.setItem(name, entry);

    const starting = deviceStore();
    expect(await value(starting, "servers")).toEqual([]);
    expect(Object.keys(localStorage).filter((k) => k.startsWith(JOURNAL_PREFIX))).toEqual([]);
  });

  it("does not make a change again in its own tab once a starting tab has made it", async () => {
    // Written down by tab t1, still being made there, when another tab starts.
    const typed = draftsOp({ C1: "typed" }, { C1: null });
    localStorage.setItem(
      `${JOURNAL_PREFIX}t1:1`,
      JSON.stringify({ key: "drafts:k", op: typed, at: Date.now(), seq: 1 }),
    );
    const starting = deviceStore();
    await starting.backend;
    await starting.apply("drafts:k", draftsOp({ C1: "edited" }, { C1: "typed" }));
    // Its own transaction comes after: made already, so it is told what is
    // stored, and the draft is not doubled.
    const t1 = deviceStore({ tab: "t1" });
    expect(await t1.apply("drafts:k", typed)).toEqual({ C1: "edited" });
    expect(await value(t1, "drafts:k")).toEqual({ C1: "edited" });
  });

  it("keeps what a database from an earlier client holds when it adds what it lacks", async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("tandem-device", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("values");
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("values", "readwrite");
        tx.objectStore("values").put(JSON.stringify({ C1: "kept" }), "drafts:k");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
      request.onerror = () => reject(request.error);
    });
    const tab = deviceStore();
    expect(await tab.backend).toBe("indexeddb");
    await tab.apply("drafts:k", draftsOp({ C2: "added" }));
    expect(await value(tab, "drafts:k")).toEqual({ C1: "kept", C2: "added" });
  });

  it("tells other tabs what was stored, and not the tab that stored it", async () => {
    const first = deviceStore();
    const second = deviceStore();
    await Promise.all([first.backend, second.backend]);
    const heardFirst = vi.fn();
    const heardSecond = vi.fn();
    first.watch("drafts:k", heardFirst);
    second.watch("drafts:k", heardSecond);
    await first.apply("drafts:k", draftsOp({ C1: "hello" }));
    await vi.waitFor(() => expect(heardSecond).toHaveBeenCalledWith({ C1: "hello" }));
    expect(heardFirst).not.toHaveBeenCalled();
  });
});

describe("the web platform over device storage (F01)", () => {
  it("rejects a strict read of an unreadable value, and a merge replaces it", async () => {
    localStorage.setItem(`${LEGACY_PREFIX}notification-previews`, "{malformed");
    const platform = webPlatform();
    await expect(platform.storage.get("notification-previews", { strict: true })).rejects.toThrow();
    expect(await platform.storage.get("notification-previews")).toBe(null);
    expect(
      await platform.storage.mergeRecord!("notification-previews", { "U1 a": "none" }),
    ).toEqual({ "U1 a": "none" });
  });

  it("keeps every address two tabs approve at once (Q02)", async () => {
    const first = webPlatform();
    const second = webPlatform();
    const home = "http://192.168.1.20:8543";
    await first.storage.initialize!("trust", { version: 1, addresses: [home] });
    const [fromFirst, fromSecond] = await Promise.all([
      first.storage.trustAddress!("trust", "https://rocket-team.trycloudflare.com"),
      second.storage.trustAddress!("trust", "http://192.168.1.21:8543"),
    ]);
    const all = [home, "https://rocket-team.trycloudflare.com", "http://192.168.1.21:8543"];
    expect(await first.storage.get("trust")).toEqual({
      version: 1,
      addresses: expect.arrayContaining(all),
    });
    // Each is told what was stored once its own was added.
    expect(fromFirst).toEqual(expect.arrayContaining([home, all[1]]));
    expect(fromSecond).toEqual(expect.arrayContaining([home, all[2]]));
  });

  it("leaves a trusted list it cannot read as it was, and finishes the change", async () => {
    const platform = webPlatform();
    await platform.storage.set("trust", { version: 1, addresses: "not a list" });
    expect(await platform.storage.trustAddress!("trust", "http://192.168.1.21:8543")).toBeNull();
    expect(await platform.storage.get("trust")).toEqual({ version: 1, addresses: "not a list" });
    // Nothing is left written down to be tried again at every start.
    expect(Object.keys(localStorage).filter((k) => k.startsWith(JOURNAL_PREFIX))).toEqual([]);
  });

  describe("saved sign-ins over plain http, with no navigator.locks", () => {
    const signIn = (port: number, workspaceName: string) => ({
      url: `http://192.168.1.20:${port}`,
      token: `${port}-not-a-credential`,
      workspaceName,
      handle: "sam",
      lastUsedAt: port,
    });
    const rocket = signIn(8543, "Rocket Team");
    const design = signIn(8544, "Design Guild");
    const third = signIn(8545, "Third Place");

    it("keeps every sign-in two tabs make at once", async () => {
      const first = webPlatform();
      const second = webPlatform();
      await first.storage.set("servers", [rocket]);
      const [fromFirst, fromSecond] = await Promise.all([
        first.storage.changeSignIns!("servers", { kind: "use", server: design, held: false }),
        second.storage.changeSignIns!("servers", { kind: "use", server: third, held: false }),
      ]);
      const stored = (await first.storage.get<(typeof rocket)[]>("servers"))!;
      expect(stored.map((s) => s.url).sort()).toEqual([rocket.url, design.url, third.url]);
      // Each is told what was stored once its own change was made.
      expect(fromFirst!.map((s) => s.url)).toContain(design.url);
      expect(fromSecond!.map((s) => s.url)).toContain(third.url);
    });

    it("keeps a sign-in one tab makes while another forgets a different one", async () => {
      const first = webPlatform();
      const second = webPlatform();
      await first.storage.set("servers", [rocket, design]);
      await Promise.all([
        first.storage.changeSignIns!("servers", { kind: "forget", url: design.url }),
        second.storage.changeSignIns!("servers", { kind: "use", server: third, held: false }),
      ]);
      const stored = (await first.storage.get<(typeof rocket)[]>("servers"))!;
      expect(stored.map((s) => s.url).sort()).toEqual([rocket.url, third.url]);
    });

    it("leaves sign-ins it cannot read as they were, and finishes the change", async () => {
      localStorage.setItem(`${LEGACY_PREFIX}servers`, "{malformed");
      const platform = webPlatform();
      const use = { kind: "use", server: design, held: false } as const;
      expect(await platform.storage.changeSignIns!("servers", use)).toBeNull();
      // Still the same text, so a strict read still refuses it.
      await expect(platform.storage.get("servers", { strict: true })).rejects.toThrow();
      expect(Object.keys(localStorage).filter((k) => k.startsWith(JOURNAL_PREFIX))).toEqual([]);

      await platform.storage.set("servers", { not: "a list" });
      expect(await platform.storage.changeSignIns!("servers", use)).toBeNull();
      expect(await platform.storage.get("servers")).toEqual({ not: "a list" });
    });
  });

  it("stores only where nothing is stored, across tabs", async () => {
    const first = webPlatform();
    const second = webPlatform();
    expect(await first.storage.initialize!("k", { from: "first" })).toEqual({ from: "first" });
    expect(await second.storage.initialize!("k", { from: "second" })).toEqual({ from: "first" });
  });
});

describe("without IndexedDB (F01)", () => {
  it("reports a timed-out opening instead of choosing an empty alternative", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Opened, and never answered.
      vi.spyOn(indexedDB, "open").mockReturnValue({} as IDBOpenDBRequest);
      const tab = deviceStore();
      const chosen = expect(tab.backend).rejects.toThrow("did not open");
      await vi.advanceTimersByTimeAsync(5_000);
      await chosen;
      expect(localStorage.getItem(`${LEGACY_PREFIX}drafts:k`)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps values in localStorage as before, written within the call", async () => {
    const saved = globalThis.indexedDB;
    // @ts-expect-error: a browser without it.
    delete globalThis.indexedDB;
    try {
      const tab = deviceStore();
      void tab.apply("drafts:k", draftsOp({ C1: "hello" }));
      expect(JSON.parse(localStorage.getItem(`${LEGACY_PREFIX}drafts:k`)!)).toEqual({
        C1: "hello",
      });
      expect(await tab.backend).toBe("localstorage");
    } finally {
      globalThis.indexedDB = saved;
    }
  });
});
