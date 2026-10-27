import { describe, expect, it } from "vitest";
import {
  unwrapStoredDrafts,
  unwrapStoredOutbox,
  type StoredOutboxEntry,
} from "@ownbase/client-core";
import type { Platform } from "../src/platform.js";
import {
  mergeWorkspaceDrafts,
  mergeWorkspaceOutbox,
  readWorkspaceDrafts,
  readWorkspaceOutbox,
  readWorkspaceStorage,
  updateWorkspaceStorage,
  workspaceStorageKey,
  writeWorkspaceStorage,
} from "../src/lib/workspaceStorage.js";
import {
  trustWorkspaceAddress,
  workspaceAddressTrustKey,
} from "../src/lib/workspaceAddressTrust.js";
import { sharedDevice } from "./sharedDevice.js";

/**
 * Work kept on the device, keyed by the workspace's ID since clients learned
 * it, and by its address before then. Reading under the new key brings the old
 * value across once, and only for an address this device already trusts for
 * that workspace, so a server that copies a workspace's ID cannot read it.
 */
const home = "http://192.168.1.20:8543";
const tunnel = "https://rocket-team.trycloudflare.com";

function fakePlatform(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  const failing = new Set<string>();
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T>(name: string) => (values.has(name) ? (values.get(name) as T) : null),
      set: async (name: string, value: unknown) => {
        if (failing.has(name)) throw new Error("storage refused");
        if (value === null) values.delete(name);
        else values.set(name, value);
      },
    },
    notify: () => {},
  };
  return { platform, values, failing };
}

describe("a workspace storage key", () => {
  it("needs someone signed in, and uses the address only when the workspace has no ID", () => {
    expect(workspaceStorageKey(home, "W1", null, "drafts")).toBeNull();
    expect(workspaceStorageKey(home, null, "U1", "drafts")).toEqual({
      key: `drafts:${home}:U1`,
    });
    expect(workspaceStorageKey(home, "W 1", "U1", "drafts", "C:1")).toEqual({
      key: "local:v1:W%201:U1:drafts:C%3A1",
      legacyKey: `drafts:${home}:U1:C:1`,
      legacyScope: {
        baseUrl: home,
        workspaceId: "W 1",
        selfId: "U1",
        kind: "drafts",
        suffix: "C:1",
      },
    });
  });
});

describe("reading work kept under an earlier key", () => {
  it("moves it to the workspace's own key once, and retires the old one", async () => {
    const { platform, values } = fakePlatform({ [`drafts:${home}:U1`]: { C1: "half a thought" } });
    const key = workspaceStorageKey(home, "W1", "U1", "drafts")!;
    expect(await readWorkspaceStorage(platform, key)).toEqual({ C1: "half a thought" });
    expect(values.get(key.key)).toEqual({ version: 1, value: { C1: "half a thought" } });
    expect(values.has(`drafts:${home}:U1`)).toBe(false);
    expect(await readWorkspaceStorage(platform, key)).toEqual({ C1: "half a thought" });
  });

  it("remembers that there was nothing, so an old value cannot come back later", async () => {
    const { platform, values } = fakePlatform();
    const key = workspaceStorageKey(home, "W1", "U1", "drafts")!;
    expect(await readWorkspaceStorage(platform, key)).toBeNull();
    expect(values.get(key.key)).toEqual({ version: 1, value: null });
    // Say a stale copy of the old key reappears, from a sync or a second tab.
    values.set(`drafts:${home}:U1`, { C1: "cleared long ago" });
    expect(await readWorkspaceStorage(platform, key)).toBeNull();
  });

  it("keeps the moved value when the old key cannot be removed", async () => {
    const legacy = `drafts:${home}:U1`;
    const { platform, values } = fakePlatform({ [legacy]: { C1: "kept" } });
    // Refusing only the removal: the new key is written first.
    const set = platform.storage.set;
    platform.storage.set = async (name, value) => {
      if (name === legacy && value === null) throw new Error("storage refused");
      return set(name, value);
    };
    const key = workspaceStorageKey(home, "W1", "U1", "drafts")!;
    expect(await readWorkspaceStorage(platform, key)).toEqual({ C1: "kept" });
    expect(values.get(key.key)).toEqual({ version: 1, value: { C1: "kept" } });
  });

  it("does not hand old work to an address this device has not linked to the workspace", async () => {
    const { platform, values } = fakePlatform({ [`drafts:${home}:U1`]: { C1: "private" } });
    // The first address seen for a workspace becomes the trusted one.
    expect(
      await readWorkspaceStorage(platform, workspaceStorageKey(home, "W1", "U1", "drafts")!),
    ).toEqual({ C1: "private" });

    values.set(`notes:${home}:U1`, "from the LAN address");
    const fromTunnel = workspaceStorageKey(tunnel, "W1", "U1", "notes")!;
    await expect(readWorkspaceStorage(platform, fromTunnel)).rejects.toThrow(
      "Approve this workspace address before restoring local work.",
    );
    expect(values.has(fromTunnel.key)).toBe(false);

    // Once someone approves the second address, work kept at the first comes across.
    await trustWorkspaceAddress(platform, "W1", "U1", tunnel);
    expect(await readWorkspaceStorage(platform, fromTunnel)).toBe("from the LAN address");
    expect(values.has(`notes:${home}:U1`)).toBe(false);
  });

  it("keeps both approvals when two windows approve another address at once", async () => {
    const trustKey = workspaceAddressTrustKey("W1", "U1");
    const { values, window } = sharedDevice({ [trustKey]: { version: 1, addresses: [home] } });
    const phone = "http://192.168.1.21:8543";
    await Promise.all([
      trustWorkspaceAddress(window(), "W1", "U1", tunnel),
      trustWorkspaceAddress(window(), "W1", "U1", phone),
    ]);
    expect(values.get(trustKey)).toEqual({ version: 1, addresses: [home, tunnel, phone] });
  });

  it("approves nothing over a list it cannot read, and leaves it as it was", async () => {
    const trustKey = workspaceAddressTrustKey("W1", "U1");
    const damaged = { version: 1, addresses: "not a list" };
    const { values, window } = sharedDevice({ [trustKey]: damaged });
    await expect(trustWorkspaceAddress(window(), "W1", "U1", tunnel)).rejects.toThrow(
      "Could not read trusted workspace addresses.",
    );
    expect(values.get(trustKey)).toBe(damaged);
  });

  it("refuses a stored value in a shape it does not know", async () => {
    const key = workspaceStorageKey(home, "W1", "U1", "drafts")!;
    for (const stored of [{ version: 2, value: 1 }, { value: 1 }, ["a"], "text"]) {
      const { platform } = fakePlatform({ [key.key]: stored });
      await expect(readWorkspaceStorage(platform, key)).rejects.toThrow(
        "Could not read the saved workspace data.",
      );
    }
  });
});

describe("writing work kept on the device", () => {
  it("wraps it under the workspace's key, and leaves an address key as it was", async () => {
    const { platform, values } = fakePlatform();
    const keyed = workspaceStorageKey(home, "W1", "U1", "drafts")!;
    await writeWorkspaceStorage(platform, keyed, { C1: "text" });
    expect(values.get(keyed.key)).toEqual({ version: 1, value: { C1: "text" } });
    const addressed = workspaceStorageKey(home, null, "U1", "drafts")!;
    await writeWorkspaceStorage(platform, addressed, { C1: "text" });
    expect(values.get(addressed.key)).toEqual({ C1: "text" });
    await expect(writeWorkspaceStorage(platform, keyed, undefined)).rejects.toThrow(/undefined/);
  });

  it("orders reads and writes to one key, so a read never sees a value older than a write before it", async () => {
    const { platform } = fakePlatform();
    const key = workspaceStorageKey(home, "W1", "U1", "drafts")!;
    const order = await Promise.all([
      writeWorkspaceStorage(platform, key, "first"),
      readWorkspaceStorage(platform, key),
      writeWorkspaceStorage(platform, key, "second"),
      readWorkspaceStorage(platform, key),
    ]);
    expect([order[1], order[3]]).toEqual(["first", "second"]);
  });

  it("changes what is stored without letting two writers here lose each other's change", async () => {
    const { platform, values } = fakePlatform();
    const keyed = workspaceStorageKey(home, "W1", "U1", "outbox")!;
    await writeWorkspaceStorage(platform, keyed, ["a"]);
    const add = (item: string) => (current: unknown) => [...(current as string[]), item];
    await Promise.all([
      updateWorkspaceStorage(platform, keyed, add("b")),
      updateWorkspaceStorage(platform, keyed, add("c")),
    ]);
    expect(values.get(keyed.key)).toEqual({ version: 1, value: ["a", "b", "c"] });

    const addressed = workspaceStorageKey(home, null, "U1", "outbox")!;
    await updateWorkspaceStorage(platform, addressed, (current) => [current, "d"]);
    expect(values.get(addressed.key)).toEqual([null, "d"]);
    // Something unreadable is replaced rather than stopping every later save.
    values.set(keyed.key, "not an envelope");
    await updateWorkspaceStorage(platform, keyed, (current) => [current, "e"]);
    expect(values.get(keyed.key)).toEqual({ version: 1, value: [null, "e"] });
  });

  it("lets a later write go ahead after one that failed", async () => {
    const { platform, failing } = fakePlatform();
    const key = workspaceStorageKey(home, "W1", "U1", "drafts")!;
    failing.add(key.key);
    await expect(writeWorkspaceStorage(platform, key, "lost")).rejects.toThrow("storage refused");
    failing.clear();
    await writeWorkspaceStorage(platform, key, "saved");
    expect(await readWorkspaceStorage(platform, key)).toBe("saved");
  });
});

const send = (nonce: string, rev: number): StoredOutboxEntry => ({
  nonce,
  channelId: "C1",
  threadRootId: null,
  text: nonce,
  userId: "U1",
  createdAt: 1,
  attachments: [],
  rev,
});

describe("setting up the outbox while another window writes it", () => {
  const key = workspaceStorageKey(home, "W1", "U1", "outbox")!;
  const stored = (values: Map<string, unknown>) =>
    unwrapStoredOutbox(values.get(key.key) ?? null, true)?.entries.map((e) => e.nonce);

  it("keeps a send another window stored after this one found the key empty", async () => {
    const { values, window, pausedWindow } = sharedDevice();
    const b = pausedWindow(key.key);
    const reading = readWorkspaceOutbox(b.platform, key);
    await b.paused;

    const a = window();
    await readWorkspaceOutbox(a, key);
    await mergeWorkspaceOutbox(a, key, { put: [send("accepted-by-a", 10)], remove: [] });
    expect(stored(values)).toEqual(["accepted-by-a"]);

    b.resume();
    expect((await reading).entries.map((e) => e.nonce)).toEqual(["accepted-by-a"]);
    // B writes what it holds, which is nothing of its own.
    await mergeWorkspaceOutbox(b.platform, key, { put: [], remove: [] });
    expect(stored(values)).toEqual(["accepted-by-a"]);
  });

  it("merges an earlier version's outbox into what another window already stored", async () => {
    const legacyKey = `outbox:${home}:U1`;
    const { rev: _rev, ...earlier } = send("queued-before-upgrade", 0);
    const { values, window, pausedWindow } = sharedDevice({ [legacyKey]: [earlier] });
    const b = pausedWindow(key.key);
    const reading = readWorkspaceOutbox(b.platform, key);
    await b.paused;

    const a = window();
    expect((await readWorkspaceOutbox(a, key)).entries.map((e) => e.nonce)).toEqual([
      "queued-before-upgrade",
    ]);
    await mergeWorkspaceOutbox(a, key, { put: [send("accepted-by-a", 10)], remove: [] });

    b.resume();
    await reading;
    await mergeWorkspaceOutbox(b.platform, key, { put: [], remove: [] });
    expect(stored(values)).toEqual(["queued-before-upgrade", "accepted-by-a"]);
    expect(values.has(legacyKey)).toBe(false);
  });

  it("records that there was nothing, and refuses a value that is not an outbox", async () => {
    const { values, window } = sharedDevice();
    expect(await readWorkspaceOutbox(window(), key)).toEqual({
      outbox: 2,
      entries: [],
      removed: [],
    });
    expect(values.get(key.key)).toEqual({
      version: 1,
      value: { outbox: 2, entries: [], removed: [] },
    });

    values.set(key.key, { version: 1, value: "not an outbox" });
    await expect(readWorkspaceOutbox(window(), key)).rejects.toThrow(
      "Could not read the saved outbox.",
    );
    // Left where it was, for a later read to deal with.
    expect(values.get(key.key)).toEqual({ version: 1, value: "not an outbox" });
  });
});

describe("setting up the drafts while another window writes them", () => {
  const key = workspaceStorageKey(home, "W1", "U1", "drafts")!;
  const stored = (values: Map<string, unknown>) =>
    unwrapStoredDrafts(values.get(key.key) ?? null, true);

  it("keeps a draft another window stored after this one found the key empty, read as a whole value (GL-01)", async () => {
    // A whole value used to record absence by writing it over whatever was
    // stored meanwhile; it is now recorded only where nothing is stored.
    const { values, window, pausedWindow } = sharedDevice();
    const b = pausedWindow(key.key);
    const reading = readWorkspaceStorage(b.platform, key);
    await b.paused;
    const a = window();
    await readWorkspaceDrafts(a, key);
    await mergeWorkspaceDrafts(a, key, () => ({ put: { C1: "typed in a" }, remove: [] }));
    b.resume();
    expect(await reading).toEqual({ C1: "typed in a" });
    expect(stored(values)).toEqual({ C1: "typed in a" });
  });

  it("keeps a draft another window stored after this one found the key empty", async () => {
    const { values, window, pausedWindow } = sharedDevice();
    const b = pausedWindow(key.key);
    const reading = readWorkspaceDrafts(b.platform, key);
    await b.paused;

    const a = window();
    await readWorkspaceDrafts(a, key);
    await mergeWorkspaceDrafts(a, key, () => ({ put: { C1: "typed in a" }, remove: [] }));

    b.resume();
    expect(await reading).toEqual({ C1: "typed in a" });
    expect(stored(values)).toEqual({ C1: "typed in a" });
  });

  it("brings an earlier version's drafts across without replacing one written since", async () => {
    const legacyKey = `drafts:${home}:U1`;
    const { values, window, pausedWindow } = sharedDevice({
      [legacyKey]: { C1: "from before", C2: "only from before" },
    });
    const b = pausedWindow(key.key);
    const reading = readWorkspaceDrafts(b.platform, key);
    await b.paused;

    // A brings them across, but cannot retire the old key, then edits one.
    const a = window();
    const set = a.storage.set;
    a.storage.set = async (name, value) => {
      if (name === legacyKey) throw new Error("storage refused");
      return set(name, value);
    };
    await readWorkspaceDrafts(a, key);
    await mergeWorkspaceDrafts(a, key, () => ({ put: { C1: "edited since" }, remove: [] }));

    // B finds the old key still there, and brings across only what is missing.
    b.resume();
    expect(await reading).toEqual({ C1: "edited since", C2: "only from before" });
    expect(stored(values)).toEqual({ C1: "edited since", C2: "only from before" });
  });

  it("records that there was nothing, and refuses a value that is not drafts", async () => {
    const { values, window } = sharedDevice();
    expect(await readWorkspaceDrafts(window(), key)).toEqual({});
    expect(values.get(key.key)).toEqual({ version: 1, value: {} });
    // A stale copy of the old key reappearing is not brought back.
    values.set(`drafts:${home}:U1`, { C1: "cleared long ago" });
    expect(await readWorkspaceDrafts(window(), key)).toEqual({});

    values.set(key.key, { version: 1, value: ["not drafts"] });
    await expect(readWorkspaceDrafts(window(), key)).rejects.toThrow(
      "Could not read the saved drafts.",
    );
    expect(values.get(key.key)).toEqual({ version: 1, value: ["not drafts"] });
  });

  it("writes nothing when a window has changed nothing", async () => {
    const { values, window } = sharedDevice();
    const a = window();
    await readWorkspaceDrafts(a, key);
    values.delete(key.key);
    expect(await mergeWorkspaceDrafts(a, key, () => ({ put: {}, remove: [] }))).toBeNull();
    expect(values.has(key.key)).toBe(false);
  });
});
