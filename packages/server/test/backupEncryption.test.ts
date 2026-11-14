import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  decryptingStream,
  encryptedLength,
  encryptingStream,
  EncryptedBackupError,
  HEADER_BYTES,
  openEncryptedFile,
  unlock,
  type BackupEncryption,
} from "../src/backups/encryption.js";

/** Cheap enough for a test to derive hundreds of keys. */
const CHEAP = { log2N: 10, r: 8, p: 1 };
const PASSPHRASE = "correct horse battery staple";
const encryption = (extra: Partial<BackupEncryption> = {}): BackupEncryption => ({
  passphrase: PASSPHRASE,
  cost: CHEAP,
  chunkBytes: 16,
  ...extra,
});

async function collect(source: Readable, ...through: NodeJS.ReadWriteStream[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline([
    source,
    ...through,
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    }),
  ] as never);
  return Buffer.concat(chunks);
}

/** Fed in uneven pieces, so part edges never line up with what arrives. */
const uneven = (bytes: Buffer) => {
  const pieces: Buffer[] = [];
  for (let at = 0, size = 1; at < bytes.length; at += size, size = (size % 7) + 1)
    pieces.push(bytes.subarray(at, at + size));
  return Readable.from(pieces);
};

async function seal(plain: Buffer, extra: Partial<BackupEncryption> = {}): Promise<Buffer> {
  return collect(uneven(plain), await encryptingStream(encryption(extra)));
}

async function unseal(sealed: Buffer, passphrase = PASSPHRASE): Promise<Buffer> {
  const { key, chunkBytes } = await unlock(sealed.subarray(0, HEADER_BYTES), passphrase);
  return collect(uneven(sealed.subarray(HEADER_BYTES)), decryptingStream(key, chunkBytes));
}

/** Why opening failed: a wrong passphrase, damage, or something else. */
async function failure(sealed: Buffer, passphrase = PASSPHRASE): Promise<string> {
  try {
    await unseal(sealed, passphrase);
  } catch (error) {
    return error instanceof EncryptedBackupError ? error.reason : String(error);
  }
  return "opened";
}

const text = (n: number) =>
  Buffer.from(Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join(""));

describe("an encrypted backup", () => {
  it.each([0, 1, 15, 16, 17, 32, 100, 1000])(
    "opens to the same %i bytes, at the length it said",
    async (n) => {
      const plain = text(n);
      const sealed = await seal(plain);
      expect(sealed.length).toBe(encryptedLength(n, 16));
      expect((await unseal(sealed)).equals(plain)).toBe(true);
    },
  );

  it("holds none of the plaintext, and two of the same differ", async () => {
    const plain = Buffer.from("the launch date is secret. invoice-2026.pdf ".repeat(20));
    const a = await seal(plain, { chunkBytes: 64 * 1024 });
    const b = await seal(plain, { chunkBytes: 64 * 1024 });
    expect(a.includes(Buffer.from("secret"))).toBe(false);
    expect(a.includes(Buffer.from("invoice"))).toBe(false);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(0, 25).toString("latin1")).toBe("OwnBase encrypted backup\n");
  });

  it("says the passphrase is wrong, and nothing about damage", async () => {
    const sealed = await seal(text(40));
    expect(await failure(sealed, "correct horse battery stapler")).toBe("passphrase");
    await expect(unseal(sealed, "wrong")).rejects.toThrow("The backup passphrase is wrong");
  });

  it("takes the same passphrase however its accents were typed", async () => {
    const sealed = await seal(text(40), { passphrase: "café au lait tous les jours" });
    expect((await unseal(sealed, "café au lait tous les jours")).equals(text(40))).toBe(true);
  });

  it("fails on one flipped byte anywhere, and never calls it a wrong passphrase", async () => {
    const sealed = await seal(text(50));
    const seen = new Set<string>();
    for (let i = 0; i < sealed.length; i++) {
      const flipped = Buffer.from(sealed);
      flipped[i]! ^= 0x01;
      const why = await failure(flipped);
      expect(why, `byte ${i}`).not.toBe("opened");
      expect(why, `byte ${i}`).not.toBe("passphrase");
      seen.add(why);
    }
    // The magic words stop being ours; everything else is damage.
    expect([...seen].sort()).toEqual(["damaged", "not-encrypted"]);
  });

  it("fails when cut short at any point, or when something is added", async () => {
    const sealed = await seal(text(50));
    const cuts = [0, 10, HEADER_BYTES - 1, HEADER_BYTES, HEADER_BYTES + 5];
    // Every part's edge, where a cut leaves only whole parts behind.
    for (let at = HEADER_BYTES + 32; at < sealed.length; at += 32) cuts.push(at);
    cuts.push(sealed.length - 1);
    for (const at of cuts) {
      const why = await failure(sealed.subarray(0, at));
      expect(why, `cut at ${at}`).not.toBe("opened");
      expect(why, `cut at ${at}`).not.toBe("passphrase");
    }
    expect(await failure(Buffer.concat([sealed, Buffer.from([0])]))).toBe("damaged");
    const twice = Buffer.concat([sealed, sealed.subarray(HEADER_BYTES)]);
    expect(await failure(twice)).toBe("damaged");
  });

  it("fails when its parts are swapped, dropped or repeated", async () => {
    const sealed = await seal(text(64));
    const header = sealed.subarray(0, HEADER_BYTES);
    const parts = [0, 1, 2, 3].map((i) =>
      sealed.subarray(HEADER_BYTES + i * 32, HEADER_BYTES + (i + 1) * 32),
    );
    const last = sealed.subarray(HEADER_BYTES + 4 * 32);
    const variants = [
      [parts[1], parts[0], parts[2], parts[3], last],
      [parts[0], parts[2], parts[3], last],
      [parts[0], parts[0], parts[1], parts[2], parts[3], last],
      // The last part moved earlier, so a cut there looks whole.
      [parts[0], last],
    ];
    for (const variant of variants) {
      expect(await failure(Buffer.concat([header, ...(variant as Buffer[])]))).toBe("damaged");
    }
  });

  it("refuses a header from a newer OwnBase, or one asking for a huge key cost", async () => {
    const { createHash } = await import("node:crypto");
    const sealed = await seal(text(10));
    const rewrite = (at: number, value: number) => {
      const copy = Buffer.from(sealed);
      copy[at] = value;
      // Keep the checksum right, so only the field is wrong.
      createHash("sha256")
        .update(copy.subarray(0, HEADER_BYTES - 32))
        .digest()
        .copy(copy, HEADER_BYTES - 32);
      return copy;
    };
    expect(await failure(rewrite(25, 2))).toBe("newer");
    expect(await failure(rewrite(26, 40))).toBe("damaged");
  });
});

describe("reading an encrypted file in place", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ownbase-sealed-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads any range without decrypting the rest", async () => {
    const plain = text(200);
    const file = join(root, "b.encrypted");
    writeFileSync(file, await seal(plain));
    const sealed = await openEncryptedFile(file, PASSPHRASE);
    try {
      expect(sealed.plainSize).toBe(200);
      expect((await sealed.read(0, 200)).equals(plain)).toBe(true);
      expect((await sealed.read(30, 50)).equals(plain.subarray(30, 80))).toBe(true);
      expect((await sealed.read(199, 1)).equals(plain.subarray(199))).toBe(true);
    } finally {
      await sealed.close();
    }
  });

  it("notices a file cut at a part's edge when it reads the end", async () => {
    const file = join(root, "b.encrypted");
    const whole = await seal(text(64));
    writeFileSync(file, whole.subarray(0, HEADER_BYTES + 3 * 32));
    const sealed = await openEncryptedFile(file, PASSPHRASE);
    try {
      await expect(sealed.read(0, sealed.plainSize)).rejects.toThrow("damaged");
    } finally {
      await sealed.close();
    }
  });

  it("refuses the wrong passphrase before reading anything", async () => {
    const file = join(root, "b.encrypted");
    writeFileSync(file, await seal(text(64)));
    await expect(openEncryptedFile(file, "not the passphrase")).rejects.toThrow(
      "The backup passphrase is wrong",
    );
  });
});
