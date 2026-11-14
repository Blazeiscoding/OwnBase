import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { open } from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";

/**
 * Encrypted backups (H04). A backup sealed with a passphrase is one file:
 *
 *   header   what follows, the scrypt salt and cost, a key check, a checksum
 *   parts    AES-256-GCM, each `chunkBytes` of plaintext and a 16-byte tag
 *
 * The parts follow the STREAM construction (Hoang, Reyhanitabar, Rogaway and
 * Vizár, 2015), as age and Tink's streaming AEAD use it: each part's nonce is
 * its position and whether it is the last one. Parts cannot be reordered,
 * dropped, repeated or cut off without the check failing, and no part is
 * larger than GCM's limit for one nonce. The key is unique to the file, since
 * the salt is, so counting nonces from zero repeats none.
 *
 * The salt and the scrypt cost travel in the header, so a later change of
 * cost still opens older files. The header has a plain checksum, which tells
 * a damaged header from a wrong passphrase, and a check made with the key,
 * which tells a wrong passphrase before a single part is read.
 */

/** Plain words at the very start, for someone who opens the file to see what it is. */
const MAGIC = Buffer.from("OwnBase encrypted backup\n", "latin1");
const VERSION = 1;
const SALT_BYTES = 32;
const TAG_BYTES = 16;
const DIGEST_BYTES = 32;
/** magic, version, log2N, r, p, chunk size, salt. */
const FIELDS_BYTES = MAGIC.length + 1 + 3 + 4 + SALT_BYTES;
export const HEADER_BYTES = FIELDS_BYTES + DIGEST_BYTES + DIGEST_BYTES;

/** scrypt's cost: N = 2^log2N. */
export interface ScryptCost {
  log2N: number;
  r: number;
  p: number;
}

/**
 * 2^17 × 8 needs 128 MiB and about half a second, OWASP's suggestion for
 * scrypt. Spent once per file, not per part.
 */
export const DEFAULT_COST: ScryptCost = { log2N: 17, r: 8, p: 1 };
/** 64 KiB, as age uses: little held in memory, a tag for every 64 KiB. */
export const DEFAULT_CHUNK_BYTES = 64 * 1024;

/** What sealing a backup needs. The cost and part size are for tests to make smaller. */
export interface BackupEncryption {
  passphrase: string;
  cost?: ScryptCost;
  chunkBytes?: number;
}

/** A header from a file that was cut, flipped or is not one of ours. */
export class EncryptedBackupError extends Error {
  constructor(
    message: string,
    readonly reason: "damaged" | "passphrase" | "newer" | "not-encrypted",
  ) {
    super(message);
    this.name = "EncryptedBackupError";
  }
}

const damaged = (detail: string) =>
  new EncryptedBackupError(`This encrypted backup is damaged. ${detail}`, "damaged");

/** True when `bytes`, the start of a file, is the start of an encrypted backup. */
export function looksEncrypted(bytes: Buffer): boolean {
  return bytes.length >= MAGIC.length && bytes.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Bounds on a cost read from a file, so a crafted header cannot ask for gigabytes. */
function checkCost(cost: ScryptCost): void {
  const ok =
    Number.isInteger(cost.log2N) &&
    cost.log2N >= 10 &&
    cost.log2N <= 22 &&
    Number.isInteger(cost.r) &&
    cost.r >= 1 &&
    cost.r <= 32 &&
    Number.isInteger(cost.p) &&
    cost.p >= 1 &&
    cost.p <= 16 &&
    128 * 2 ** cost.log2N * cost.r <= 1024 ** 3;
  if (!ok) throw damaged("Its header asks for a key cost OwnBase does not use.");
}

function checkChunkBytes(chunkBytes: number): void {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 16 || chunkBytes > 16 * 1024 * 1024)
    throw damaged("Its header gives a part size OwnBase does not use.");
}

/** The AES key, then the key the header check is made with. */
async function deriveKeys(
  passphrase: string,
  salt: Buffer,
  cost: ScryptCost,
): Promise<{ key: Buffer; check: Buffer }> {
  const N = 2 ** cost.log2N;
  const derived = await new Promise<Buffer>((resolve, reject) =>
    scrypt(
      // The same passphrase typed on macOS and Windows can differ in how
      // accented letters are composed. NFC makes them one.
      Buffer.from(passphrase.normalize("NFC"), "utf8"),
      salt,
      64,
      { N, r: cost.r, p: cost.p, maxmem: 128 * N * cost.r * cost.p + 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
  return { key: derived.subarray(0, 32), check: derived.subarray(32) };
}

interface Header {
  cost: ScryptCost;
  chunkBytes: number;
  salt: Buffer;
  fields: Buffer;
  keyCheck: Buffer;
}

function headerFields(cost: ScryptCost, chunkBytes: number, salt: Buffer): Buffer {
  const fields = Buffer.alloc(FIELDS_BYTES);
  let at = MAGIC.copy(fields, 0);
  fields[at++] = VERSION;
  fields[at++] = cost.log2N;
  fields[at++] = cost.r;
  fields[at++] = cost.p;
  fields.writeUInt32BE(chunkBytes, at);
  at += 4;
  salt.copy(fields, at);
  return fields;
}

function parseHeader(bytes: Buffer): Header {
  if (!looksEncrypted(bytes))
    throw new EncryptedBackupError("This is not an encrypted backup.", "not-encrypted");
  if (bytes.length < HEADER_BYTES) throw damaged("It ends inside its header.");
  const fields = bytes.subarray(0, FIELDS_BYTES);
  const keyCheck = bytes.subarray(FIELDS_BYTES, FIELDS_BYTES + DIGEST_BYTES);
  const checksum = bytes.subarray(FIELDS_BYTES + DIGEST_BYTES, HEADER_BYTES);
  const expected = createHash("sha256")
    .update(bytes.subarray(0, FIELDS_BYTES + DIGEST_BYTES))
    .digest();
  if (!timingSafeEqual(checksum, expected))
    throw damaged("Its header does not match its checksum.");
  let at = MAGIC.length;
  const version = fields[at++]!;
  if (version !== VERSION)
    throw new EncryptedBackupError(
      "A newer version of OwnBase encrypted this backup. Update OwnBase to read it.",
      "newer",
    );
  const cost = { log2N: fields[at++]!, r: fields[at++]!, p: fields[at++]! };
  const chunkBytes = fields.readUInt32BE(at);
  at += 4;
  checkCost(cost);
  checkChunkBytes(chunkBytes);
  return { cost, chunkBytes, salt: fields.subarray(at, at + SALT_BYTES), fields, keyCheck };
}

const keyCheckOf = (check: Buffer, fields: Buffer) =>
  createHmac("sha256", check).update(fields).digest();

/** Each part's nonce: its number, and whether it is the last. */
function nonce(index: bigint, last: boolean): Buffer {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(index, 3);
  iv[11] = last ? 1 : 0;
  return iv;
}

function sealPart(key: Buffer, index: bigint, last: boolean, plain: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce(index, last));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

function openPart(key: Buffer, index: bigint, last: boolean, sealed: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) throw cutShort();
  const decipher = createDecipheriv("aes-256-gcm", key, nonce(index, last));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    // The passphrase was proved right by the header, so this is the file.
    throw damaged(
      `Part ${index + 1n} of it fails its check: a byte changed, or the file was cut short or added to.`,
    );
  }
}

const cutShort = () => damaged("It was cut short.");

/** The encrypted length of `plainBytes`, so an upload can say it before it starts. */
export function encryptedLength(plainBytes: number, chunkBytes = DEFAULT_CHUNK_BYTES): number {
  const parts = Math.max(1, Math.ceil(plainBytes / chunkBytes));
  return HEADER_BYTES + plainBytes + parts * TAG_BYTES;
}

/**
 * A stream that turns the bytes written to it into an encrypted backup:
 * the header first, then the parts. Its key is derived before the first
 * byte goes through.
 */
export async function encryptingStream(encryption: BackupEncryption): Promise<Transform> {
  const cost = encryption.cost ?? DEFAULT_COST;
  const chunkBytes = encryption.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  checkCost(cost);
  checkChunkBytes(chunkBytes);
  const salt = randomBytes(SALT_BYTES);
  const fields = headerFields(cost, chunkBytes, salt);
  const { key, check } = await deriveKeys(encryption.passphrase, salt, cost);
  const keyCheck = keyCheckOf(check, fields);
  const checksum = createHash("sha256").update(fields).update(keyCheck).digest();
  let held: Buffer[] = [];
  let length = 0;
  let index = 0n;
  let started = false;
  const start = (stream: Transform) => {
    if (started) return;
    started = true;
    stream.push(Buffer.concat([fields, keyCheck, checksum]));
  };
  return new Transform({
    transform(this: Transform, chunk: Buffer, _encoding, done: TransformCallback) {
      start(this);
      held.push(chunk);
      length += chunk.length;
      // A whole part is held back until more follows, since the last part,
      // even a whole one, is sealed as the last.
      if (length > chunkBytes) {
        let all = Buffer.concat(held, length);
        while (all.length > chunkBytes) {
          this.push(sealPart(key, index++, false, all.subarray(0, chunkBytes)));
          all = all.subarray(chunkBytes);
        }
        held = [all];
        length = all.length;
      }
      done();
    },
    flush(this: Transform, done: TransformCallback) {
      start(this);
      this.push(sealPart(key, index, true, Buffer.concat(held, length)));
      done();
    },
  });
}

/** Reads and checks a file's header, and derives its key from `passphrase`. */
export async function unlock(headerBytes: Buffer, passphrase: string) {
  const header = parseHeader(headerBytes);
  const { key, check } = await deriveKeys(passphrase, header.salt, header.cost);
  if (!timingSafeEqual(keyCheckOf(check, header.fields), header.keyCheck))
    throw new EncryptedBackupError(
      "The backup passphrase is wrong. This backup was encrypted with a different one.",
      "passphrase",
    );
  return { key, chunkBytes: header.chunkBytes };
}

/**
 * A stream that turns the parts after the header back into plaintext,
 * failing on the first part that does not check. Nothing it passes on is
 * unchecked, but a failure can come after some of it: write it somewhere
 * temporary and use it once the stream has ended without error.
 */
export function decryptingStream(key: Buffer, chunkBytes: number): Transform {
  const sealedBytes = chunkBytes + TAG_BYTES;
  let held: Buffer[] = [];
  let length = 0;
  let index = 0n;
  return new Transform({
    transform(this: Transform, chunk: Buffer, _encoding, done: TransformCallback) {
      held.push(chunk);
      length += chunk.length;
      try {
        if (length > sealedBytes) {
          let all = Buffer.concat(held, length);
          // Strictly more than one part: the one held might be the last.
          while (all.length > sealedBytes) {
            this.push(openPart(key, index++, false, all.subarray(0, sealedBytes)));
            all = all.subarray(sealedBytes);
          }
          held = [all];
          length = all.length;
        }
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(this: Transform, done: TransformCallback) {
      try {
        this.push(openPart(key, index, true, Buffer.concat(held, length)));
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
}

/**
 * An encrypted file read at any position, part by part, without decrypting
 * the rest. Its plaintext length comes from the file's length; reading the
 * last part checks it is the last, so a file cut at a part's edge fails.
 */
export async function openEncryptedFile(path: string, passphrase: string) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, HEADER_BYTES));
    await handle.read(head, 0, head.length, 0);
    const { key, chunkBytes } = await unlock(head, passphrase);
    const sealedBytes = chunkBytes + TAG_BYTES;
    const body = size - HEADER_BYTES;
    const parts = Math.max(1, Math.ceil(body / sealedBytes));
    const plainSize = body - parts * TAG_BYTES;
    const lastPlain = plainSize - (parts - 1) * chunkBytes;
    if (plainSize < 0 || lastPlain < 0 || (lastPlain === 0 && parts > 1)) throw cutShort();
    let cached: { index: number; plain: Buffer } | null = null;
    const part = async (index: number): Promise<Buffer> => {
      if (cached?.index === index) return cached.plain;
      const last = index === parts - 1;
      const sealed = Buffer.alloc(last ? lastPlain + TAG_BYTES : sealedBytes);
      const { bytesRead } = await handle.read(
        sealed,
        0,
        sealed.length,
        HEADER_BYTES + index * sealedBytes,
      );
      if (bytesRead !== sealed.length) throw cutShort();
      const plain = openPart(key, BigInt(index), last, sealed);
      cached = { index, plain };
      return plain;
    };
    return {
      plainSize,
      /** Exactly `length` plaintext bytes from `position`. */
      async read(position: number, length: number): Promise<Buffer> {
        if (position < 0 || position + length > plainSize)
          throw damaged("Its contents point past its end.");
        const out: Buffer[] = [];
        for (let at = position; at < position + length;) {
          const index = Math.floor(at / chunkBytes);
          const plain = await part(index);
          const from = at - index * chunkBytes;
          const take = Math.min(plain.length - from, position + length - at);
          out.push(plain.subarray(from, from + take));
          at += take;
        }
        return Buffer.concat(out, length);
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
