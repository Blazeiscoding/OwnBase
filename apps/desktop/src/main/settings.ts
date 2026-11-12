import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { SAVED_SIGN_INS_KEY } from "@ownbase/client-core/savedSignIns";
import {
  decodeSavedServers,
  encodeSavedServers,
  validateProtectedServers,
  type CredentialProtector,
} from "./credentials.js";

export interface SettingsStorage {
  get(
    key: string,
    options?: { strict?: boolean; distinguishMissing?: boolean },
  ): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
  /**
   * Reads a setting and writes what `change` makes of it in one turn of the
   * queue every read and write here takes, so no other write can come between
   * the two. Gives back what was written. Not for saved sign-ins.
   */
  update(key: string, change: (current: unknown) => unknown): Promise<unknown>;
  /** Waits for accepted work, including anything queued while waiting; rejects an unfinished failure. */
  drain(): Promise<void>;
}

/** Marks a settings file whose keys were already taken out of the page's file. */
const MOVED_KEY = "movedFromPageSettings";

/**
 * The main process's own settings, which used to share the file the page
 * writes. Before the first read or write, `keys` found in `page` are moved
 * here (one already here wins) and removed there, once: after that the page's
 * file is never read for them, so nothing the page writes under those names
 * reaches the main process. While either file cannot be read, nothing is
 * answered and the move is tried again on the next call.
 */
export function ownSettings(
  own: SettingsStorage,
  page: SettingsStorage,
  keys: readonly string[],
): SettingsStorage {
  let moved: Promise<void> | null = null;
  const move = () =>
    (moved ??= (async () => {
      if ((await own.get(MOVED_KEY, { strict: true })) === true) return;
      for (const key of keys) {
        const value = await page.get(key, { strict: true, distinguishMissing: true });
        if (value === undefined) continue;
        if ((await own.get(key, { strict: true, distinguishMissing: true })) === undefined)
          await own.set(key, value);
        // JSON leaves an undefined value out of the file.
        await page.set(key, undefined);
      }
      await own.set(MOVED_KEY, true);
    })().catch((error: unknown) => {
      moved = null;
      throw error;
    }));
  return {
    get: async (key, options) => (await move(), own.get(key, options)),
    set: async (key, value) => (await move(), own.set(key, value)),
    update: async (key, change) => (await move(), own.update(key, change)),
    drain: () => own.drain(),
  };
}

/** All callers share one queue so a legacy migration cannot race another settings write. */
export function createSettingsStorage(
  filePath: string,
  protector: CredentialProtector,
): SettingsStorage {
  let pending: Promise<unknown> = Promise.resolve();
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = pending.catch(() => {}).then(operation);
    pending = next;
    return next;
  }

  async function read(): Promise<Record<string, unknown>> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(
        "OwnBase could not open its settings file. Check that your account may read it.",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      // JSON syntax errors can quote a plaintext credential from a legacy file.
      throw new Error("OwnBase could not read its settings file because the file is damaged.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("OwnBase could not read its settings file because the file is damaged.");
    return value as Record<string, unknown>;
  }

  async function write(settings: Record<string, unknown>): Promise<void> {
    let contents: string;
    try {
      contents = JSON.stringify(settings, null, 2);
    } catch {
      throw new Error("OwnBase could not save its settings because one value cannot be stored.");
    }
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
  }

  /** Never copy legacy plaintext tokens to a newly written settings file. */
  function protectExisting(settings: Record<string, unknown>): Record<string, unknown> {
    if (!Object.hasOwn(settings, SAVED_SIGN_INS_KEY)) return settings;
    if (Array.isArray(settings[SAVED_SIGN_INS_KEY])) {
      return {
        ...settings,
        [SAVED_SIGN_INS_KEY]: encodeSavedServers(settings[SAVED_SIGN_INS_KEY], protector),
      };
    }
    validateProtectedServers(settings[SAVED_SIGN_INS_KEY]);
    return settings;
  }

  return {
    async drain() {
      for (;;) {
        const accepted = pending;
        await accepted;
        if (accepted === pending) return;
      }
    },
    get(key, options) {
      return serialized(async () => {
        try {
          if (typeof key !== "string") throw new Error("Invalid settings key.");
          const settings = await read();
          if (!Object.hasOwn(settings, key)) return options?.distinguishMissing ? undefined : null;
          if (key !== SAVED_SIGN_INS_KEY)
            return options?.distinguishMissing ? settings[key] : (settings[key] ?? null);
          const servers = decodeSavedServers(settings[SAVED_SIGN_INS_KEY], protector);
          if (
            Array.isArray(settings[SAVED_SIGN_INS_KEY]) &&
            settings[SAVED_SIGN_INS_KEY].length > 0
          ) {
            // Only release the decrypted credentials after migration has succeeded.
            await write(protectExisting(settings));
          }
          return servers;
        } catch (error) {
          if (key === SAVED_SIGN_INS_KEY || options?.strict) throw error;
          return null;
        }
      });
    },
    set(key, value) {
      return serialized(async () => {
        if (typeof key !== "string") throw new Error("Invalid settings key.");
        const settings = await read();
        if (key === SAVED_SIGN_INS_KEY) {
          // An explicit, confirmed forget action must work even with a lost OS key.
          // The renderer must never turn a failed restore into an automatic empty save.
          const forgetting = Array.isArray(value) && value.length === 0;
          if (!forgetting && Object.hasOwn(settings, SAVED_SIGN_INS_KEY))
            decodeSavedServers(settings[SAVED_SIGN_INS_KEY], protector);
          await write({ ...settings, [SAVED_SIGN_INS_KEY]: encodeSavedServers(value, protector) });
        } else {
          await write({ ...protectExisting(settings), [key]: value });
        }
      });
    },
    update(key, change) {
      return serialized(async () => {
        if (typeof key !== "string" || key === SAVED_SIGN_INS_KEY)
          throw new Error("Invalid settings key.");
        const settings = await read();
        const value = change(Object.hasOwn(settings, key) ? settings[key] : null);
        await write({ ...protectExisting(settings), [key]: value });
        return value;
      });
    },
  };
}
