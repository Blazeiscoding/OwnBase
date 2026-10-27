import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialProtector, SavedCredentialServer } from "../src/main/credentials.js";
import { createSettingsStorage } from "../src/main/settings.js";

/**
 * The desktop settings file and the saved sign-ins inside it, over a fake OS
 * key store. Sign-in tokens are credentials: they must never reach the file,
 * an error or a log as plain text, and a locked key store must never become a
 * reason to write them that way.
 */
const TOKEN = "slk_session_secret_value";
const server: SavedCredentialServer = {
  url: "http://192.168.1.20:8543",
  token: TOKEN,
  workspaceName: "Rocket Team",
  handle: "sam",
  lastUsedAt: 1_700_000_000_000,
};

type FakeKeyStore = CredentialProtector & { available: boolean; key: number };

/** A key store whose "encryption" is reversible only with the same key. */
function keyStore(key = 7): FakeKeyStore {
  const store: FakeKeyStore = {
    available: true,
    key,
    isAvailable: () => store.available,
    encryptString: (value: string) =>
      Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ store.key)),
    decryptString: (value: Buffer) => {
      const text = Buffer.from(value.map((byte) => byte ^ store.key)).toString("utf8");
      // A different key yields bytes that are not the JSON that went in.
      if (!text.startsWith("[")) throw new Error("wrong key");
      return text;
    },
  };
  return store;
}

let dir: string;
let file: string;
const onDisk = () => readFileSync(file, "utf8");
const writeRaw = (value: unknown) =>
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ownbase-settings-"));
  file = join(dir, "settings.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("distinguishes an absent registry key from a present null value for migration", async () => {
  const settings = createSettingsStorage(file, keyStore());
  expect(await settings.get("hostedWorkspaces", { strict: true, distinguishMissing: true })).toBe(
    undefined,
  );
  writeRaw({ hostedWorkspaces: null });
  expect(
    await settings.get("hostedWorkspaces", { strict: true, distinguishMissing: true }),
  ).toBeNull();
});

describe("saved sign-ins in the settings file", () => {
  it("keeps them encrypted on disk and gives them back whole", async () => {
    const settings = createSettingsStorage(file, keyStore());
    await settings.set("servers", [server]);
    expect(onDisk()).not.toContain(TOKEN);
    const stored = JSON.parse(onDisk()).servers;
    expect(Object.keys(stored).sort()).toEqual(["ciphertext", "kind", "version"]);
    expect(stored).toMatchObject({ kind: "ownbase.saved-servers", version: 1 });
    expect(await settings.get("servers")).toEqual([server]);
  });

  it("encrypts sign-ins an earlier version left in plain text the first time they are read", async () => {
    writeRaw({ servers: [server], theme: "light" });
    const settings = createSettingsStorage(file, keyStore());
    expect(await settings.get("servers")).toEqual([server]);
    expect(onDisk()).not.toContain(TOKEN);
    expect(JSON.parse(onDisk()).theme).toBe("light");
    expect(await settings.get("servers")).toEqual([server]);
  });

  it("encrypts them too when some other setting is saved first", async () => {
    writeRaw({ servers: [server] });
    const settings = createSettingsStorage(file, keyStore());
    await settings.set("lastHosted", { folder: "rocket-team" });
    expect(onDisk()).not.toContain(TOKEN);
    expect(await settings.get("servers")).toEqual([server]);
    expect(await settings.get("lastHosted")).toEqual({ folder: "rocket-team" });
  });

  it("writes nothing in plain text while the key store is locked, and says to unlock it", async () => {
    const locked = keyStore();
    locked.available = false;
    const settings = createSettingsStorage(file, locked);
    await expect(settings.set("servers", [server])).rejects.toThrow(
      "OS credential protection is unavailable. Unlock your system key store and try again.",
    );
    expect(() => onDisk()).toThrow();

    // An earlier version's plain-text sign-ins stay where they are rather
    // than being copied, unprotected, into a new file.
    writeRaw({ servers: [server] });
    const before = onDisk();
    await expect(settings.get("servers")).rejects.toThrow(/unavailable/);
    await expect(settings.set("theme", "dark")).rejects.toThrow(/unavailable/);
    expect(onDisk()).toBe(before);
  });

  it("treats a key store that throws when asked the same as a locked one", async () => {
    const broken = keyStore();
    broken.isAvailable = () => {
      throw new Error("keychain daemon crashed");
    };
    const settings = createSettingsStorage(file, broken);
    await expect(settings.set("servers", [server])).rejects.toThrow(/unavailable/);
  });

  it("refuses to overwrite sign-ins it cannot unlock, but can always forget them", async () => {
    await createSettingsStorage(file, keyStore(7)).set("servers", [server]);
    const saved = onDisk();
    // Another system account, or a reinstalled OS, has a different key.
    const elsewhere = createSettingsStorage(file, keyStore(9));
    await expect(elsewhere.get("servers")).rejects.toThrow(
      "Could not unlock saved workspace credentials. Use the original system account and key store, then try again.",
    );
    await expect(elsewhere.set("servers", [{ ...server, token: "another" }])).rejects.toThrow(
      /Could not unlock/,
    );
    expect(onDisk()).toBe(saved);

    await elsewhere.set("servers", []);
    expect(JSON.parse(onDisk()).servers).toEqual([]);
    expect(await elsewhere.get("servers")).toEqual([]);
  });

  it("refuses malformed sign-ins without repeating what was in them", async () => {
    const settings = createSettingsStorage(file, keyStore());
    for (const bad of [
      [{ ...server, token: "" }],
      [{ ...server, url: `http://sam:${TOKEN}@example.org` }],
      [{ ...server, url: `https://example.org/?token=${TOKEN}` }],
      [{ ...server, lastUsedAt: -1 }],
      [{ ...server, url: "ftp://example.org" }],
      { servers: [server] },
    ]) {
      const error = await settings.set("servers", bad).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(TOKEN);
    }
    expect(() => onDisk()).toThrow();
  });

  it("refuses an envelope that was edited by hand", async () => {
    const settings = createSettingsStorage(file, keyStore());
    await settings.set("servers", [server]);
    const stored = JSON.parse(onDisk());
    for (const tampered of [
      { ...stored.servers, extra: true },
      { ...stored.servers, version: 2 },
      { ...stored.servers, ciphertext: "" },
      { ...stored.servers, ciphertext: "not base64!" },
      // Base64 that decodes but is not written canonically.
      { ...stored.servers, ciphertext: "QQ" },
    ]) {
      writeRaw({ servers: tampered });
      await expect(settings.get("servers")).rejects.toThrow(/invalid or use an unsupported format/);
    }
  });
});

describe("the rest of the settings file", () => {
  it("reads nothing from a file that is not JSON, without quoting it", async () => {
    writeRaw(`{"servers": [{"token": "${TOKEN}"`);
    const settings = createSettingsStorage(file, keyStore());
    const error = await settings.get("servers").catch((e: Error) => e);
    expect((error as Error).message).toBe("Could not read settings: the JSON file is invalid.");
    // Ordinary settings fall back to nothing, unless the caller must know.
    expect(await settings.get("theme")).toBeNull();
    await expect(settings.get("theme", { strict: true })).rejects.toThrow(/JSON file is invalid/);
  });

  it("returns nothing for a setting never saved, and for a file not yet made", async () => {
    const settings = createSettingsStorage(file, keyStore());
    expect(await settings.get("theme")).toBeNull();
    expect(await settings.get("servers")).toBeNull();
    await settings.set("theme", "light");
    expect(await settings.get("density")).toBeNull();
  });

  it("applies writes in the order they were asked for", async () => {
    const settings = createSettingsStorage(file, keyStore());
    await Promise.all([
      settings.set("theme", "light"),
      settings.set("servers", [server]),
      settings.set("theme", "dark"),
      settings.set("density", "compact"),
    ]);
    expect(await settings.get("theme")).toBe("dark");
    expect(await settings.get("density")).toBe("compact");
    expect(await settings.get("servers")).toEqual([server]);
  });

  it("refuses a value that cannot be stored, and keeps what was there", async () => {
    const settings = createSettingsStorage(file, keyStore());
    await settings.set("theme", "light");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(settings.set("layout", cyclic)).rejects.toThrow(
      "Could not save settings: a value cannot be stored as JSON.",
    );
    expect(await settings.get("theme")).toBe("light");
  });
});
