import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { inspect } from "./check-web-precompressed.mjs";

const gate = join(dirname(fileURLToPath(import.meta.url)), "check-web-precompressed.mjs");
const script = `export const x = ${JSON.stringify("chat ".repeat(500))};\n`;
const style = "body { margin: 0 }\n".repeat(100);

/** A built client with both copies of each large text file, as the build writes it. */
function built(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "web-precompressed-"));
  const all = {
    "index.html": "<!doctype html><title>small</title>",
    "ownbase.svg": "<svg/>",
    "assets/index-A1.js": script,
    "assets/index-A1.js.br": brotliCompressSync(script),
    "assets/index-A1.js.gz": gzipSync(script),
    "assets/index-B2.css": style,
    "assets/index-B2.css.br": brotliCompressSync(style),
    "assets/index-B2.css.gz": gzipSync(style),
    "assets/photo-C3.png": Buffer.alloc(4096, 7),
    ...files,
  };
  for (const [path, body] of Object.entries(all)) {
    if (body === null) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

function run(dir) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [gate, dir], { encoding: "utf8", stdio: "pipe" }),
    };
  } catch (error) {
    return { code: error.status, out: String(error.stdout) + String(error.stderr) };
  }
}

test("a client built with both copies of each large text file passes", () => {
  const dir = built();
  try {
    const { problems, totals } = inspect(dir);
    assert.deepEqual(problems, []);
    // Small files and images are left as they are.
    assert.equal(totals.files, 2);
    assert.ok(totals.br < totals.gz && totals.gz < totals.bytes);
    const { code, out } = run(dir);
    assert.equal(code, 0, out);
    assert.match(out, /2 files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing, stale, corrupt or orphaned copy fails, naming the file", () => {
  const dir = built({
    "assets/index-A1.js.gz": null,
    "assets/index-B2.css.br": brotliCompressSync(style.replace("0", "1")),
    "assets/index-B2.css.gz": Buffer.from("not gzip"),
    "assets/gone-D4.js.br": brotliCompressSync(script),
  });
  try {
    const { problems } = inspect(dir);
    assert.deepEqual(problems.sort(), [
      "assets/gone-D4.js.br: a Brotli copy of a file that is not there",
      "assets/index-A1.js: no gzip copy",
      "assets/index-B2.css.br: decodes to something other than assets/index-B2.css",
      "assets/index-B2.css.gz: not valid gzip",
    ]);
    const { code, out } = run(dir);
    assert.equal(code, 1);
    assert.match(out, /Rebuild the client/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a folder with nothing to compress is not a built client", () => {
  const dir = built({
    "assets/index-A1.js": null,
    "assets/index-A1.js.br": null,
    "assets/index-A1.js.gz": null,
    "assets/index-B2.css": null,
    "assets/index-B2.css.br": null,
    "assets/index-B2.css.gz": null,
  });
  try {
    const { code, out } = run(dir);
    assert.equal(code, 1);
    assert.match(out, /nothing to compress/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
