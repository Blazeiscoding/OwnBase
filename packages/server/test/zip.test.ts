import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, deflateRawSync } from "node:zlib";
import {
  extractZipEntry,
  readZipDirectory,
  readZipEntries,
  zipArchive,
  type ZipSource,
} from "../src/zip.js";
import { unzipBackup } from "../src/workspaceCopy.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ownbase-zip-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const entry = (name: string, bytes: Buffer): ZipSource => ({
  name,
  size: bytes.length,
  crc32: crc32(bytes),
  open: () => Readable.from([bytes]),
});

async function write(entries: ZipSource[], name = "out.zip", modifiedAt?: number) {
  const archive = zipArchive(entries, modifiedAt);
  const path = join(root, name);
  await pipeline(archive.open(), createWriteStream(path));
  return { path, length: archive.length };
}

/** One deflated entry, made by hand the way a zip tool makes one. */
function deflatedZip(name: string, bytes: Buffer): Buffer {
  const data = deflateRawSync(bytes);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(bytes), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(bytes), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const centralOffset = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

describe("writing a zip", () => {
  it("says its exact length up front, and reads back byte for byte", async () => {
    const files = {
      "manifest.json": Buffer.from('{"format":1}'),
      "workspace.db": Buffer.alloc(70_000, 9),
      "files/01ABC": Buffer.from("an attachment"),
      "files/empty": Buffer.alloc(0),
      "files/naïve café.txt": Buffer.from("a name in UTF-8"),
    };
    const { path, length } = await write(
      Object.entries(files).map(([name, bytes]) => entry(name, bytes)),
    );
    expect(readFileSync(path).length).toBe(length);
    const entries = await readZipEntries(path);
    expect(entries.map((e) => e.name)).toEqual(Object.keys(files));
    for (const e of entries) {
      expect(e.method).toBe(0);
      const to = join(root, `out-${entries.indexOf(e)}`);
      await extractZipEntry(path, e, to);
      expect(readFileSync(to)).toEqual(files[e.name as keyof typeof files]);
    }
  });

  it("dates every entry with the time it is given, as zip tools read it", async () => {
    // Local time, to two seconds: 26 October 2026, 21:03:05 is stored as :04.
    const at = new Date(2026, 9, 26, 21, 3, 5).getTime();
    const { path } = await write(
      [entry("manifest.json", Buffer.from("{}")), entry("workspace.db", Buffer.from("db"))],
      "dated.zip",
      at,
    );
    const zip = readFileSync(path);
    const date = ((2026 - 1980) << 9) | (10 << 5) | 26;
    const time = (21 << 11) | (3 << 5) | 2;
    const stamps: number[][] = [];
    for (const [signature, timeAt] of [
      [0x04034b50, 10],
      [0x02014b50, 12],
    ] as const) {
      const mark = Buffer.alloc(4);
      mark.writeUInt32LE(signature);
      for (let at = zip.indexOf(mark); at >= 0; at = zip.indexOf(mark, at + 4))
        stamps.push([zip.readUInt16LE(at + timeAt), zip.readUInt16LE(at + timeAt + 2)]);
    }
    expect(stamps).toEqual(Array(4).fill([time, date]));

    // Without a time, the earliest a zip can say: 1 January 1980, midnight.
    const undated = readFileSync((await write([entry("a", Buffer.from("a"))], "undated.zip")).path);
    expect([undated.readUInt16LE(10), undated.readUInt16LE(12)]).toEqual([0, (1 << 5) | 1]);
  });

  it("stops with an error when an entry is longer or shorter than it said", async () => {
    for (const [said, actual] of [
      [4, Buffer.from("12345")],
      [6, Buffer.from("12345")],
    ] as const) {
      const archive = zipArchive([
        { name: "a", size: said, crc32: 0, open: () => Readable.from([actual]) },
      ]);
      await expect(
        pipeline(archive.open(), createWriteStream(join(root, `bad-${said}.zip`))),
      ).rejects.toThrow(said < actual.length ? "grew" : "shrank");
    }
  });

  it("refuses names an unzip tool could put outside its folder", () => {
    for (const name of ["../escape", "files/../../escape", "/absolute", "files\\back", ""])
      expect(() => zipArchive([entry(name, Buffer.from("x"))]), name).toThrow(
        "Not a name for a zip entry",
      );
  });

  it("adds ZIP64 records past 65,535 entries", async () => {
    const many = Array.from({ length: 70_000 }, (_, i) => entry(`files/${i}`, Buffer.alloc(0)));
    const { path } = await write(many);
    const entries = await readZipEntries(path);
    expect(entries).toHaveLength(70_000);
    expect(entries.at(-1)!.name).toBe("files/69999");
    // The ordinary end record says "see ZIP64" in its count.
    const tail = readFileSync(path).subarray(-22);
    expect(tail.readUInt16LE(10)).toBe(0xffff);
  });

  it("writes a file past 4 GiB with ZIP64 sizes and offsets that read back", async () => {
    const big = 4 * 1024 ** 3 + 12_345;
    const chunk = Buffer.alloc(1 << 20);
    const after = Buffer.from("after the big one");
    const archive = zipArchive([
      {
        name: "workspace.db",
        size: big,
        crc32: 0,
        open: () =>
          Readable.from(
            (function* () {
              let left = big;
              while (left > 0) {
                const n = Math.min(left, chunk.length);
                yield n === chunk.length ? chunk : chunk.subarray(0, n);
                left -= n;
              }
            })(),
          ),
      },
      entry("manifest.json", after),
    ]);
    // Kept: the first bytes and the last; the zeros in between are only counted.
    let seen = 0;
    const head: Buffer[] = [];
    let tail = Buffer.alloc(0);
    for await (const piece of archive.open()) {
      const bytes = piece as Buffer;
      if (seen < 4096) head.push(Buffer.from(bytes.subarray(0, 4096 - seen)));
      seen += bytes.length;
      tail = Buffer.concat([tail, bytes]).subarray(-(1 << 16));
    }
    expect(seen).toBe(archive.length);
    const start = Buffer.concat(head);
    const tailStart = seen - tail.length;
    const read = async (position: number, length: number) => {
      const out = Buffer.alloc(length);
      for (let i = 0; i < length; i++) {
        const at = position + i;
        if (at < start.length) out[i] = start[at]!;
        else if (at >= tailStart) out[i] = tail[at - tailStart]!;
      }
      return out;
    };
    const entries = await readZipDirectory(read, seen);
    expect(
      entries.map(({ name, size, compressedSize }) => ({ name, size, compressedSize })),
    ).toEqual([
      { name: "workspace.db", size: big, compressedSize: big },
      { name: "manifest.json", size: after.length, compressedSize: after.length },
    ]);
    const second = entries[1]!;
    expect(second.localOffset).toBeGreaterThan(0xffffffff);
    const local = await read(second.localOffset, 30);
    expect(local.readUInt32LE(0)).toBe(0x04034b50);
    const data = await read(
      second.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28),
      after.length,
    );
    expect(data).toEqual(after);
    // The big entry's local header carries its size in a ZIP64 field.
    expect(start.readUInt32LE(18)).toBe(0xffffffff);
    expect(start.readUInt16LE(28)).toBe(20);
  }, 120_000);
});

describe("reading a zip", () => {
  it("reads a deflated entry, as zip tools make them", async () => {
    const bytes = Buffer.from("compressed ".repeat(200));
    const path = join(root, "deflated.zip");
    writeFileSync(path, deflatedZip("workspace.db", bytes));
    const [only] = await readZipEntries(path);
    expect(only).toMatchObject({ name: "workspace.db", method: 8, size: bytes.length });
    await extractZipEntry(path, only!, join(root, "db"));
    expect(readFileSync(join(root, "db"))).toEqual(bytes);
  });

  it("refuses an entry whose bytes do not match its checksum", async () => {
    const { path } = await write([entry("workspace.db", Buffer.from("original bytes"))]);
    const damaged = readFileSync(path);
    const at = 30 + "workspace.db".length;
    damaged[at] = damaged[at]! ^ 0xff;
    writeFileSync(path, damaged);
    const [only] = await readZipEntries(path);
    await expect(extractZipEntry(path, only!, join(root, "db"))).rejects.toThrow("checksum");
  });

  it("refuses what is not a zip, and a zip compressed some other way", async () => {
    const path = join(root, "not.zip");
    writeFileSync(path, "just some text");
    await expect(readZipEntries(path)).rejects.toThrow("not a zip");
    const { path: zip } = await write([entry("workspace.db", Buffer.from("x"))], "method.zip");
    const [only] = await readZipEntries(zip);
    await expect(extractZipEntry(zip, { ...only!, method: 12 }, join(root, "x"))).rejects.toThrow(
      "compressed in a way",
    );
  });
});

describe("unzipping a backup", () => {
  const backup = {
    "manifest.json": Buffer.from("{}"),
    "workspace.db": Buffer.from("database"),
    "files/01ABC": Buffer.from("attachment"),
  };

  it("takes the backup's own files and leaves anything else out", async () => {
    const { path } = await write([
      ...Object.entries(backup).map(([name, bytes]) => entry(name, bytes)),
      entry("__MACOSX/._manifest.json", Buffer.from("finder")),
      entry("notes.txt", Buffer.from("mine")),
      entry("files/nested/deeper", Buffer.from("no")),
    ]);
    const out = join(root, "backup");
    await unzipBackup(path, out);
    expect(readFileSync(join(out, "workspace.db"), "utf8")).toBe("database");
    expect(readFileSync(join(out, "files", "01ABC"), "utf8")).toBe("attachment");
    expect(() => readFileSync(join(out, "notes.txt"))).toThrow();
  });

  it("takes a zip of the backup folder itself, one level down", async () => {
    const { path } = await write(
      Object.entries(backup).map(([name, bytes]) => entry(`backup-2026-10-25/${name}`, bytes)),
    );
    const out = join(root, "backup");
    await unzipBackup(path, out);
    expect(readFileSync(join(out, "manifest.json"), "utf8")).toBe("{}");
  });

  it("refuses a zip without a backup in it, and one naming a file twice", async () => {
    const { path: none } = await write([entry("photo.jpg", Buffer.from("x"))], "none.zip");
    await expect(unzipBackup(none, join(root, "a"))).rejects.toThrow("does not hold");
    const { path: twice } = await write(
      [
        ...Object.entries(backup).map(([name, bytes]) => entry(name, bytes)),
        entry("files/01abc", Buffer.from("same name, other case")),
      ],
      "twice.zip",
    );
    await expect(unzipBackup(twice, join(root, "b"))).rejects.toThrow("same file twice");
  });

  it("never writes into a folder that is already there", async () => {
    const { path } = await write(Object.entries(backup).map(([n, b]) => entry(n, b)));
    await mkdir(join(root, "exists"));
    await expect(unzipBackup(path, join(root, "exists"))).rejects.toThrow();
  });
});
