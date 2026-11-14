import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BackupManifest } from "./backup.js";
import {
  decryptingStream,
  encryptingStream,
  EncryptedBackupError,
  HEADER_BYTES,
  looksEncrypted,
  openEncryptedFile,
  unlock,
  type BackupEncryption,
} from "./encryption.js";
import { backupZipEntries, withBackupFolder } from "./workspaceCopy.js";
import { readZipDirectory, zipArchive } from "./zip.js";

/**
 * A backup sealed with a passphrase: the zip a downloaded copy or an offsite
 * copy is, encrypted as one file (`encryption.ts`). One file and not a folder
 * of encrypted files, so nothing about the workspace shows, not even how
 * many attachments it has or their sizes, and an offsite copy is that file
 * as it is.
 */

/** How an encrypted backup's name ends; scheduled ones are `backup-<time>Z.encrypted`. */
export const ENCRYPTED_SUFFIX = ".encrypted";

/** True when the file at `path` starts the way an encrypted backup does. */
export async function isEncryptedBackup(path: string): Promise<boolean> {
  if (!(await stat(path)).isFile()) return false;
  const handle = await open(path, "r");
  try {
    const start = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(start, 0, start.length, 0);
    return looksEncrypted(start.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** Sums what goes by. */
function digesting() {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  return { stream, hash, bytes: () => bytes };
}

/**
 * Seals the verified backup folder `dir` into the new file `file`, then
 * reads the whole file back and checks it decrypts to the same bytes. A
 * scheduled backup is kept only once that has passed, so nothing is kept
 * that nobody proved can be read.
 */
export async function sealBackup(
  dir: string,
  file: string,
  createdAt: number,
  encryption: BackupEncryption,
): Promise<void> {
  const zip = zipArchive(await backupZipEntries(dir), createdAt);
  const sent = digesting();
  await pipeline(
    zip.open(),
    sent.stream,
    await encryptingStream(encryption),
    createWriteStream(file, { flags: "wx" }),
  );
  const back = createHash("sha256");
  let backBytes = 0;
  await decryptFile(
    file,
    encryption.passphrase,
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        back.update(chunk);
        backBytes += chunk.length;
        done();
      },
    }),
  );
  if (
    sent.bytes() !== zip.length ||
    backBytes !== zip.length ||
    back.digest("hex") !== sent.hash.digest("hex")
  )
    throw new Error("The encrypted backup does not read back as it was written. It was not kept.");
}

/** Decrypts `file` through `into`, checking every part. */
async function decryptFile(
  file: string,
  passphrase: string,
  into: NodeJS.WritableStream,
): Promise<void> {
  const head = Buffer.alloc(HEADER_BYTES);
  const handle = await open(file, "r");
  let bytesRead: number;
  try {
    ({ bytesRead } = await handle.read(head, 0, head.length, 0));
  } finally {
    await handle.close();
  }
  const { key, chunkBytes } = await unlock(head.subarray(0, bytesRead), passphrase);
  await pipeline(
    createReadStream(file, { start: HEADER_BYTES }),
    decryptingStream(key, chunkBytes),
    into,
  );
}

/**
 * The manifest inside an encrypted backup, read without decrypting the rest:
 * the zip's directory, then its manifest entry, a few parts in all.
 */
export async function readSealedManifest(
  file: string,
  passphrase: string,
): Promise<BackupManifest> {
  const sealed = await openEncryptedFile(file, passphrase);
  try {
    const entries = await readZipDirectory(sealed.read, sealed.plainSize);
    const entry = entries.find((e) => e.name === "manifest.json");
    if (!entry || entry.method !== 0) throw new Error("This encrypted backup holds no manifest.");
    const local = await sealed.read(entry.localOffset, 30);
    const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    return JSON.parse(
      (await sealed.read(start, entry.compressedSize)).toString("utf8"),
    ) as BackupManifest;
  } finally {
    await sealed.close();
  }
}

/** Said when an encrypted backup is given and no passphrase is. */
export const PASSPHRASE_NEEDED =
  "This backup is encrypted. Give its passphrase in OWNBASE_BACKUP_PASSPHRASE, or the path of a file holding it with --backup-passphrase-file.";

/**
 * Runs `use` on the backup at `from`: a backup folder, a zip of one, or an
 * encrypted backup. An encrypted one is decrypted beside itself into a zip,
 * every part checked before the zip is opened, so a wrong passphrase or a
 * damaged file stops here, before anything is restored. What was decrypted
 * is removed afterwards, whatever `use` does.
 */
export async function withAnyBackupFolder<T>(
  from: string,
  passphrase: string | undefined,
  use: (dir: string, info: { encrypted: boolean }) => Promise<T>,
): Promise<T> {
  if (!(await isEncryptedBackup(from)))
    return withBackupFolder(from, (dir) => use(dir, { encrypted: false }));
  if (passphrase === undefined) throw new EncryptedBackupError(PASSPHRASE_NEEDED, "passphrase");
  const scratch = await mkdtemp(join(dirname(from), ".ownbase-decrypt-"));
  try {
    const zip = join(scratch, `${basename(from)}.zip`);
    await decryptFile(from, passphrase, createWriteStream(zip, { flags: "wx" }));
    return await withBackupFolder(zip, (dir) => use(dir, { encrypted: true }));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
