import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findEarlierNames } from "./check-product-name.mjs";

const gate = join(dirname(fileURLToPath(import.meta.url)), "check-product-name.mjs");

/** A built client holding `files`, beside what every build has. */
function built(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "product-name-"));
  const all = {
    "index.html": "<!doctype html><title>OwnBase</title>",
    "assets/index-A1.js": 'const key="tandem:appearance";document.title="OwnBase";\n',
    "assets/photo-C3.png": Buffer.from("Tandem in a picture is not text"),
    ...files,
  };
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

test("passes a build that shows only the current name and keeps lowercase keys", () => {
  const dir = built({
    "assets/apps-B2.js":
      'const guide="https://github.com/Blazeiscoding/Tandem/blob/main/docs/INTEGRATIONS.md";\n',
  });
  try {
    assert.deepEqual(findEarlierNames(dir), []);
    assert.match(execFileSync(process.execPath, [gate, dir], { encoding: "utf8" }), /no earlier/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finds an earlier name a person would read, where it is", () => {
  const dir = built({
    "assets/index-A1.js": 'x="ok";\nconst t="Sign in to Tandem";\n',
    "manifest.webmanifest": '{ "name": "Gatherline" }',
    "assets/index-B2.css": '.a::after { content: "Tandem" }',
  });
  try {
    assert.deepEqual(findEarlierNames(dir).sort(), [
      'assets/index-A1.js:2: const t="Sign in to Tandem";',
      'assets/index-B2.css:1: .a::after { content: "Tandem" }',
      'manifest.webmanifest:1: { "name": "Gatherline" }',
    ]);
    assert.throws(
      () => execFileSync(process.execPath, [gate, dir], { encoding: "utf8", stdio: "pipe" }),
      (error) => error.status === 1 && /Sign in to Tandem/.test(String(error.stderr)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
