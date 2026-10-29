import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  bindAssets,
  identityProblem,
  prepareRelease,
  readTarGzFile,
  sha256,
  tagVersion,
} from "./release-manifest.mjs";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const SCRIPT = fileURLToPath(new URL("./release-manifest.mjs", import.meta.url));

const identity = (over = {}) => ({
  version: "0.2.0",
  revision: REVISION,
  dirty: false,
  inputs: "0a1344b673e188e8",
  builtAt: "2026-10-02T00:00:00.000Z",
  ...over,
});

/** A `.tar.gz` holding `./<name>` files, as `tar -czf … -C dist .` writes one. */
function tarGz(entries) {
  const blocks = [];
  for (const [name, body] of Object.entries(entries)) {
    const data = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(`./${name}`, 0, "utf8");
    header.write("0000644\0", 100);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("ustar\0", 257);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const INSTALLER = "OwnBase Setup 0.2.0.exe";
const DISK_IMAGE = "OwnBase-0.2.0-universal.dmg";
const ARCHIVE = "ownbase-server-0.2.0.tar.gz";

/**
 * A release directory as the jobs stage it: identities for the server, the
 * Windows app and the Mac app, the server archive carrying its identity, the
 * installer and the disk image, each listed with its SHA-256 by the job that
 * tested it.
 */
function release(identities = { server: identity(), desktop: identity(), mac: identity() }) {
  const dir = mkdtempSync(join(tmpdir(), "release-manifest-"));
  for (const [name, value] of Object.entries(identities))
    writeFileSync(join(dir, `${name}.build.json`), JSON.stringify(value));
  writeFileSync(join(dir, INSTALLER), "installer bytes");
  writeFileSync(join(dir, DISK_IMAGE), "disk image bytes");
  writeFileSync(
    join(dir, ARCHIVE),
    tarGz({ "build.json": JSON.stringify(identities.server ?? identity()), "x.js": "server" }),
  );
  bindAssets(dir, "server", [join(dir, ARCHIVE)]);
  bindAssets(dir, "desktop", [join(dir, INSTALLER)]);
  bindAssets(dir, "mac", [join(dir, DISK_IMAGE)]);
  return dir;
}

test("a tag names a version, with or without a pre-release", () => {
  assert.equal(tagVersion("v0.2.0"), "0.2.0");
  assert.equal(tagVersion("v0.2.0-rc.1"), "0.2.0");
  assert.equal(tagVersion("0.2.0"), null);
  assert.equal(tagVersion("v0.2"), null);
  assert.equal(tagVersion("release"), null);
});

test("every published file is hashed, and the notes name the tested revision", () => {
  const dir = release();
  try {
    const { sums, notes, files } = prepareRelease({ dir, revision: REVISION, tag: "v0.2.0" });
    assert.deepEqual(files, [INSTALLER, DISK_IMAGE, ARCHIVE]);
    assert.equal(sums, files.map((file) => `${sha256(join(dir, file))}  ${file}\n`).join(""));
    assert.match(notes, new RegExp(`Built and tested from ${REVISION}`));
    assert.match(notes, /\| desktop \| 0\.2\.0 \| `0123456789ab` \|/);
    assert.match(notes, /\| mac \| 0\.2\.0 \| `0123456789ab` \|/);
    assert.match(notes, /\| server \| 0\.2\.0 \| `0123456789ab` \|/);
    // Signing status is stated as it is.
    assert.match(notes, /not code-signed/);
    assert.match(notes, /Mac app is signed ad hoc[\s\S]*Open Anyway/);
    assert.match(
      prepareRelease({ dir, revision: REVISION, tag: "v0.2.0", signed: true }).notes,
      /is code-signed/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses an artifact built from another commit, changed source, or another version", () => {
  const version = "0.2.0";
  assert.equal(identityProblem("server", identity(), { revision: REVISION, version }), null);
  assert.match(
    identityProblem("server", identity({ revision: OTHER }), { revision: REVISION, version }),
    /server was built from fedcba987654, not 0123456789ab/,
  );
  assert.match(
    identityProblem("desktop", identity({ dirty: true }), { revision: REVISION, version }),
    /uncommitted changes/,
  );
  assert.match(
    identityProblem("desktop", identity({ dirty: null }), { revision: REVISION, version }),
    /could not say/,
  );
  assert.match(
    identityProblem("web", identity({ version: "0.1.0" }), { revision: REVISION, version }),
    /version 0\.1\.0, but the tag names 0\.2\.0/,
  );

  const dir = release({
    server: identity(),
    desktop: identity({ revision: OTHER }),
    mac: identity(),
  });
  try {
    assert.throws(
      () => prepareRelease({ dir, revision: REVISION, tag: "v0.2.0" }),
      /desktop was built from fedcba987654/,
    );
    assert.throws(
      () => prepareRelease({ dir, revision: REVISION, tag: "latest" }),
      /names no version/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a release with no identities or nothing to publish", () => {
  const empty = mkdtempSync(join(tmpdir(), "release-manifest-"));
  try {
    assert.throws(
      () => prepareRelease({ dir: empty, revision: REVISION, tag: "v0.2.0" }),
      /no artifact identity[\s\S]*nothing to publish/,
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("the command writes SHA256SUMS beside the files and the notes where asked", () => {
  const dir = release();
  const notes = join(dir, "..", `notes-${Date.now()}.md`);
  try {
    const run = spawnSync(
      process.execPath,
      [SCRIPT, dir, "--revision", REVISION, "--tag", "v0.2.0", "--notes", notes],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(join(dir, "SHA256SUMS"), "utf8"), run.stdout);
    assert.match(readFileSync(notes, "utf8"), /Built and tested from/);
    // A second run leaves the checksum file out of its own sums.
    const again = spawnSync(
      process.execPath,
      [SCRIPT, dir, "--revision", REVISION, "--tag", "v0.2.0", "--notes", notes],
      { encoding: "utf8" },
    );
    assert.equal(again.stdout, run.stdout);

    const refused = spawnSync(
      process.execPath,
      [SCRIPT, dir, "--revision", OTHER, "--tag", "v0.2.0", "--notes", notes],
      { encoding: "utf8" },
    );
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Not releasing:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(notes, { force: true });
  }
});

test("preparing twice gives the same sums, with notes kept beside the files (F05)", () => {
  const dir = release();
  const notes = join(dir, "notes.md");
  try {
    const run = () =>
      spawnSync(
        process.execPath,
        [SCRIPT, dir, "--revision", REVISION, "--tag", "v0.2.0", "--notes", notes],
        { encoding: "utf8" },
      );
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
    assert.doesNotMatch(first.stdout, /notes\.md|assets\.json|build\.json/);
    // The sums the notes quote are those of the files published.
    for (const line of readFileSync(join(dir, "SHA256SUMS"), "utf8").trim().split("\n")) {
      const [hash, file] = line.split("  ");
      assert.equal(sha256(join(dir, file)), hash);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a file no tested build staged, a changed or swapped one, or a second installer (F05)", () => {
  const prepare = (dir) => () => prepareRelease({ dir, revision: REVISION, tag: "v0.2.0" });
  let dir = release();
  try {
    writeFileSync(join(dir, "old-notes.md"), "left over");
    assert.throws(prepare(dir), /old-notes\.md was not staged by a tested build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = release();
  try {
    writeFileSync(join(dir, INSTALLER), "other installer bytes");
    assert.throws(prepare(dir), /is not the file desktop staged/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = release();
  try {
    writeFileSync(join(dir, "OwnBase Setup 0.1.0.exe"), "older");
    bindAssets(dir, "desktop", [join(dir, INSTALLER), join(dir, "OwnBase Setup 0.1.0.exe")]);
    assert.throws(prepare(dir), /exactly one Windows installer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = release();
  try {
    // An archive carrying another build's identity, rebound to look staged.
    writeFileSync(
      join(dir, ARCHIVE),
      tarGz({ "build.json": JSON.stringify(identity({ inputs: "ffffffffffffffff" })) }),
    );
    bindAssets(dir, "server", [join(dir, ARCHIVE)]);
    assert.throws(prepare(dir), /does not carry the server identity/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = release();
  try {
    rmSync(join(dir, "desktop.assets.json"));
    rmSync(join(dir, INSTALLER));
    assert.throws(prepare(dir), /no Windows installer was staged/);
    writeFileSync(join(dir, "desktop.build.json"), "null");
    assert.throws(prepare(dir), /desktop\.build\.json is not an object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The Mac job's disk image is as required as the installer, and is the
  // universal one it built, not an image for one kind of Mac.
  dir = release();
  try {
    rmSync(join(dir, "mac.assets.json"));
    rmSync(join(dir, DISK_IMAGE));
    assert.throws(prepare(dir), /no Mac disk image was staged/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = release();
  try {
    rmSync(join(dir, DISK_IMAGE));
    writeFileSync(join(dir, "OwnBase-0.2.0-arm64.dmg"), "one kind of Mac");
    bindAssets(dir, "mac", [join(dir, "OwnBase-0.2.0-arm64.dmg")]);
    assert.throws(prepare(dir), /mac must stage exactly one Mac disk image/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads one file out of a server archive", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-manifest-"));
  try {
    writeFileSync(join(dir, "a.tar.gz"), tarGz({ "x.js": "one", "build.json": "{}" }));
    assert.equal(readTarGzFile(join(dir, "a.tar.gz"), "build.json")?.toString(), "{}");
    assert.equal(readTarGzFile(join(dir, "a.tar.gz"), "missing.json"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
