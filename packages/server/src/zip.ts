import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createInflateRaw } from "node:zlib";

/**
 * Just enough ZIP for a workspace copy (P4), with no dependency: writing
 * stored entries whose sizes and CRCs are known before the first byte, so the
 * length is exact and every unzip tool reads the result, and reading back
 * stored or deflated entries for a restore.
 *
 * ZIP64 records are added only where a size, an offset or the number of
 * entries is past what the original format holds (4 GiB, 65,535 entries), so
 * a small copy is a plain zip and a 25 GB one still opens.
 */

/** One file to put in a zip. */
export interface ZipSource {
  /** The name inside the zip, with forward slashes. */
  name: string;
  size: number;
  crc32: number;
  /** Its bytes, exactly `size` of them. */
  open: () => Readable;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const END64_LOCATOR = 0x07064b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** Names are UTF-8. */
const UTF8 = 0x0800;

/**
 * A time as a zip stores it: local time, to two seconds, 1980 to 2107. Every
 * entry gets the same one, so the same copy always makes the same bytes.
 */
function dosTime(at: number | undefined): { date: number; time: number } {
  if (at === undefined) return { date: (1 << 5) | 1, time: 0 };
  const when = new Date(at);
  const year = Math.min(Math.max(when.getFullYear(), 1980), 2107);
  return {
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
  };
}

/** A file's CRC-32 and size, read in chunks so the event loop is not held. */
export async function fileCrc32(path: string): Promise<{ crc32: number; size: number }> {
  let value = 0;
  let size = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
    value = crc32(chunk as Buffer, value);
    size += (chunk as Buffer).length;
  }
  return { crc32: value, size };
}

type DosTime = ReturnType<typeof dosTime>;

function localHeader(entry: ZipSource, name: Buffer, at: DosTime): Buffer {
  const big = entry.size >= MAX32;
  const extra = big ? Buffer.alloc(20) : Buffer.alloc(0);
  if (big) {
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(BigInt(entry.size), 4);
    extra.writeBigUInt64LE(BigInt(entry.size), 12);
  }
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL, 0);
  header.writeUInt16LE(big ? 45 : 20, 4);
  header.writeUInt16LE(UTF8, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(at.time, 10);
  header.writeUInt16LE(at.date, 12);
  header.writeUInt32LE(entry.crc32 >>> 0, 14);
  header.writeUInt32LE(big ? MAX32 : entry.size, 18);
  header.writeUInt32LE(big ? MAX32 : entry.size, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, name, extra]);
}

function centralHeader(entry: ZipSource, name: Buffer, offset: number, at: DosTime): Buffer {
  const bigSize = entry.size >= MAX32;
  const bigOffset = offset >= MAX32;
  const fields: bigint[] = [];
  if (bigSize) fields.push(BigInt(entry.size), BigInt(entry.size));
  if (bigOffset) fields.push(BigInt(offset));
  const extra = Buffer.alloc(fields.length ? 4 + 8 * fields.length : 0);
  if (fields.length) {
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(8 * fields.length, 2);
    fields.forEach((value, i) => extra.writeBigUInt64LE(value, 4 + 8 * i));
  }
  const zip64 = bigSize || bigOffset;
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL, 0);
  header.writeUInt16LE(45, 4);
  header.writeUInt16LE(zip64 ? 45 : 20, 6);
  header.writeUInt16LE(UTF8, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(at.time, 12);
  header.writeUInt16LE(at.date, 14);
  header.writeUInt32LE(entry.crc32 >>> 0, 16);
  header.writeUInt32LE(bigSize ? MAX32 : entry.size, 20);
  header.writeUInt32LE(bigSize ? MAX32 : entry.size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(bigOffset ? MAX32 : offset, 42);
  return Buffer.concat([header, name, extra]);
}

function endRecords(count: number, centralSize: number, centralOffset: number): Buffer {
  const zip64 = count > MAX16 || centralSize >= MAX32 || centralOffset >= MAX32;
  const parts: Buffer[] = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(END64, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeUInt32LE(0, 16);
    record.writeUInt32LE(0, 20);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(centralSize), 40);
    record.writeBigUInt64LE(BigInt(centralOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(END64_LOCATOR, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(centralOffset + centralSize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(Math.min(count, MAX16), 8);
  end.writeUInt16LE(Math.min(count, MAX16), 10);
  end.writeUInt32LE(zip64 ? MAX32 : centralSize, 12);
  end.writeUInt32LE(zip64 ? MAX32 : centralOffset, 16);
  parts.push(end);
  return Buffer.concat(parts);
}

/** Refuses a name a zip of a workspace copy never needs and an unzip tool could misread. */
function checkedName(name: string): Buffer {
  if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes(".."))
    throw new Error(`Not a name for a zip entry: ${name}`);
  return Buffer.from(name, "utf8");
}

/**
 * A zip of `entries`, in order: its exact length up front, and its bytes each
 * time `open` is called. An entry's bytes are read only when the stream
 * reaches them; one that turns out longer or shorter than it said stops the
 * stream with an error rather than producing a zip that lies. Every entry is
 * dated `modifiedAt` (milliseconds), or 1 January 1980 without one.
 */
export function zipArchive(
  entries: ZipSource[],
  modifiedAt?: number,
): { length: number; open: () => Readable } {
  const names = entries.map((entry) => checkedName(entry.name));
  const at = dosTime(modifiedAt);
  let offset = 0;
  const offsets: number[] = [];
  const locals = entries.map((entry, i) => {
    offsets.push(offset);
    const header = localHeader(entry, names[i]!, at);
    offset += header.length + entry.size;
    return header;
  });
  const centrals = entries.map((entry, i) => centralHeader(entry, names[i]!, offsets[i]!, at));
  const centralSize = centrals.reduce((sum, header) => sum + header.length, 0);
  const end = endRecords(entries.length, centralSize, offset);
  const length = offset + centralSize + end.length;

  async function* bytes(): AsyncGenerator<Buffer> {
    for (const [i, entry] of entries.entries()) {
      yield locals[i]!;
      let sent = 0;
      for await (const chunk of entry.open()) {
        sent += (chunk as Buffer).length;
        if (sent > entry.size) throw new Error(`${entry.name} grew while it was being zipped.`);
        yield chunk as Buffer;
      }
      if (sent !== entry.size) throw new Error(`${entry.name} shrank while it was being zipped.`);
    }
    yield* centrals;
    yield end;
  }
  return { length, open: () => Readable.from(bytes(), { objectMode: false }) };
}

/** One entry as the central directory describes it. */
export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflated; nothing else is read. */
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

async function readAt(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error("The zip ends before it should.");
  return buffer;
}

/** Lists a zip's entries from its central directory, ZIP64 included. */
export async function readZipEntries(path: string): Promise<ZipEntry[]> {
  const { size } = await stat(path);
  const handle = await open(path, "r");
  try {
    return await readZipDirectory((position, length) => readAt(handle, position, length), size);
  } finally {
    await handle.close();
  }
}

/**
 * Reads a zip's central directory through `read`, which returns exactly
 * `length` bytes from `position` of a zip `fileSize` long.
 */
export async function readZipDirectory(
  read: (position: number, length: number) => Promise<Buffer>,
  fileSize: number,
): Promise<ZipEntry[]> {
  {
    const tailLength = Math.min(fileSize, 22 + MAX16);
    const tail = await read(fileSize - tailLength, tailLength);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new Error("This is not a zip file.");
    let count = tail.readUInt16LE(at + 10);
    let centralSize = tail.readUInt32LE(at + 12);
    let centralOffset = tail.readUInt32LE(at + 16);
    if (count === MAX16 || centralSize === MAX32 || centralOffset === MAX32) {
      const locatorAt = fileSize - tailLength + at - 20;
      if (locatorAt < 0) throw new Error("The zip's ZIP64 end is missing.");
      const locator = await read(locatorAt, 20);
      if (locator.readUInt32LE(0) !== END64_LOCATOR)
        throw new Error("The zip's ZIP64 end is missing.");
      const record = await read(Number(locator.readBigUInt64LE(8)), 56);
      if (record.readUInt32LE(0) !== END64) throw new Error("The zip's ZIP64 end is damaged.");
      count = Number(record.readBigUInt64LE(32));
      centralSize = Number(record.readBigUInt64LE(40));
      centralOffset = Number(record.readBigUInt64LE(48));
    }
    if (centralOffset + centralSize > fileSize) throw new Error("The zip's directory is damaged.");
    const central = await read(centralOffset, centralSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > central.length || central.readUInt32LE(p) !== CENTRAL)
        throw new Error("The zip's directory is damaged.");
      const nameLength = central.readUInt16LE(p + 28);
      const extraLength = central.readUInt16LE(p + 30);
      const commentLength = central.readUInt16LE(p + 32);
      let compressedSize = central.readUInt32LE(p + 20);
      let size = central.readUInt32LE(p + 24);
      let localOffset = central.readUInt32LE(p + 42);
      const name = central.toString("utf8", p + 46, p + 46 + nameLength);
      const extra = central.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
      for (let e = 0; e + 4 <= extra.length;) {
        const id = extra.readUInt16LE(e);
        const length = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let field = e + 4;
          const next = () => {
            const value = Number(extra.readBigUInt64LE(field));
            field += 8;
            return value;
          };
          if (size === MAX32) size = next();
          if (compressedSize === MAX32) compressedSize = next();
          if (localOffset === MAX32) localOffset = next();
        }
        e += 4 + length;
      }
      entries.push({
        name,
        method: central.readUInt16LE(p + 10),
        crc32: central.readUInt32LE(p + 16),
        compressedSize,
        size,
        localOffset,
      });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }
}

/**
 * Writes one entry's bytes to `to`, checking its size and CRC. Stored and
 * deflated entries only, which covers what this writes and what the usual
 * zip tools make when someone zips a backup folder by hand.
 */
export async function extractZipEntry(path: string, entry: ZipEntry, to: string): Promise<void> {
  if (entry.method !== 0 && entry.method !== 8)
    throw new Error(`${entry.name} is compressed in a way this cannot read.`);
  const handle = await open(path, "r");
  let start: number;
  try {
    const local = await readAt(handle, entry.localOffset, 30);
    if (local.readUInt32LE(0) !== LOCAL) throw new Error(`${entry.name} is damaged in the zip.`);
    start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  } finally {
    await handle.close();
  }
  let value = 0;
  let written = 0;
  const check = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      value = crc32(chunk, value);
      written += chunk.length;
      if (written > entry.size) done(new Error(`${entry.name} is longer than the zip says.`));
      else done(null, chunk);
    },
  });
  const source =
    entry.compressedSize === 0
      ? Readable.from([])
      : createReadStream(path, { start, end: start + entry.compressedSize - 1 });
  if (entry.method === 8)
    await pipeline(source, createInflateRaw(), check, createWriteStream(to, { flags: "wx" }));
  else await pipeline(source, check, createWriteStream(to, { flags: "wx" }));
  if (written !== entry.size || value >>> 0 !== entry.crc32 >>> 0)
    throw new Error(`${entry.name} does not match its checksum in the zip.`);
}
