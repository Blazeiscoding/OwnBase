import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findForbidden, inventory, listAsar, listFolder } from "./check-desktop-archive.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const gate = join(root, "scripts", "check-desktop-archive.mjs");

/** The files a clean package has: built output and its third-party dependencies. */
const clean = {
  "package.json": "{}",
  "out/main/index.js": "main",
  "out/preload/index.cjs": "preload",
  "node_modules/fastify/package.json": "{}",
  "node_modules/fastify/lib/server.js": "server",
  "node_modules/@fastify/cors/index.js": "cors",
};
/** What the deep investigation found in a local archive (REV-12), one of each. */
const forbidden = {
  "node_modules/@ownbase/server/src/server.ts": "source",
  "node_modules/@ownbase/server/data/workspace.db": "db",
  "node_modules/@ownbase/server/data/workspace.db-wal": "wal",
  "node_modules/@ownbase/server/data/workspace.db-shm": "shm",
  "node_modules/other/data/files/01K00000000000000000000000": "attachment",
  "node_modules/other/.turbo/turbo-test.log": "log",
  "node_modules/other/debug.log": "log",
  "node_modules/other/.env.local": "secret",
  "node_modules/other/pre-upgrade/workspace.db": "copy",
  "node_modules/zod/src/v4/core/core.ts": "dependency source",
  "node_modules/zod/v4/core/index.d.cts": "declarations",
};

function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), "desktop-archive-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

/** An archive written by the same library Electron Builder packs with. */
async function archive(files) {
  const require = createRequire(join(root, "package.json"));
  const pnpm = join(root, "node_modules", ".pnpm");
  const name = readdirSync(pnpm).find((entry) => entry.startsWith("@electron+asar@"));
  const asar = require(join(pnpm, name, "node_modules", "@electron", "asar"));
  const source = folder(files);
  const out = join(mkdtempSync(join(tmpdir(), "desktop-archive-out-")), "app.asar");
  await asar.createPackage(source, out);
  return { source, out };
}

const run = (target) => {
  try {
    return {
      code: 0,
      output: execFileSync(process.execPath, [gate, target], { encoding: "utf8", stdio: "pipe" }),
    };
  } catch (error) {
    return { code: error.status, output: `${error.stdout}${error.stderr}` };
  }
};

test("reads an archive's files and sizes as Electron's own library wrote them", async () => {
  const { source, out } = await archive(clean);
  try {
    const listed = listAsar(out)
      .map(({ path, size }) => [path, size])
      .sort();
    const expected = Object.entries(clean)
      .map(([path, body]) => [path, body.length])
      .sort();
    assert.deepEqual(listed, expected);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dirname(out), { recursive: true, force: true });
  }
});

test("passes a clean package and says what is in it", async () => {
  const { source, out } = await archive(clean);
  try {
    const result = run(out);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /6 files/);
    assert.match(result.output, /2 dependencies/);
    assert.match(result.output, /Nothing forbidden\./);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dirname(out), { recursive: true, force: true });
  }
});

test("fails a package carrying workspace data, logs or workspace source, naming each", async () => {
  const { source, out } = await archive({ ...clean, ...forbidden });
  try {
    const result = run(out);
    assert.equal(result.code, 1);
    for (const path of Object.keys(forbidden)) assert.ok(result.output.includes(path), path);
    assert.match(result.output, /11 forbidden files/);
    assert.ok(!result.output.includes("out/main/index.js:"));
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dirname(out), { recursive: true, force: true });
  }
});

test("checks an unpacked app folder the same way", () => {
  const dir = folder({ ...clean, ...forbidden });
  try {
    const found = findForbidden(listFolder(dir)).map((file) => file.path);
    assert.deepEqual(found.sort(), Object.keys(forbidden).sort());
    assert.equal(inventory(listFolder(dir)).files, Object.keys(clean).length + 11);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not mistake ordinary dependency files for forbidden ones", () => {
  const ordinary = [
    "node_modules/zod/v4/core/regexes.js",
    "node_modules/zod/index.cjs",
    "node_modules/some-lib/tsconfig.json",
    "node_modules/some-lib/lib/parts.js",
    "node_modules/fastify/lib/logger.js",
    "node_modules/ws/lib/receiver.js",
    "node_modules/some-lib/data/schema.json",
    "node_modules/some-lib/dbutils.js",
    "out/main/backupWorker-abc.js",
  ].map((path) => ({ path, size: 1, unpacked: false }));
  assert.deepEqual(findForbidden(ordinary), []);
});
