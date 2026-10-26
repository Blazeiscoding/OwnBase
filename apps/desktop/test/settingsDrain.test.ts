import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialProtector } from "../src/main/credentials.js";
import { createSettingsStorage } from "../src/main/settings.js";

const controls = vi.hoisted(() => ({
  write: null as null | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs: Parameters<typeof write>) => {
        await controls.write?.();
        return write(...writeArgs);
      };
      return handle;
    },
  };
});

const protector: CredentialProtector = {
  isAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
};
const folders: string[] = [];
function settings() {
  const folder = mkdtempSync(join(tmpdir(), "ownbase-settings-drain-"));
  folders.push(folder);
  const path = join(folder, "settings.json");
  return { store: createSettingsStorage(path, protector), path };
}
function held() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  controls.write = null;
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("draining accepted native settings work", () => {
  it("waits for a delayed atomic write and work accepted while it waits", async () => {
    const { store, path } = settings();
    const first = held();
    const second = held();
    let started = 0;
    controls.write = () => (++started === 1 ? first.promise : second.promise);
    const write1 = store.set("drafts", { C1: "final words" });
    const drain = store.drain();
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await vi.waitFor(() => expect(started).toBe(1));
    const write2 = store.set("outbox", { entries: ["queued send"] });
    first.resolve();
    await write1;
    await vi.waitFor(() => expect(started).toBe(2));
    expect(drained).toBe(false);
    second.resolve();
    await Promise.all([write2, drain]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      drafts: { C1: "final words" },
      outbox: { entries: ["queued send"] },
    });
  });

  it("refuses a failed write until an explicit retry completes", async () => {
    const { store, path } = settings();
    controls.write = async () => {
      throw new Error("disk full");
    };
    const write = store.set("drafts", { C1: "kept in memory" });
    await expect(write).rejects.toThrow("disk full");
    await expect(store.drain()).rejects.toThrow("disk full");
    controls.write = null;
    await store.set("drafts", { C1: "kept in memory" });
    await store.drain();
    expect(JSON.parse(readFileSync(path, "utf8")).drafts).toEqual({ C1: "kept in memory" });
  });
});
