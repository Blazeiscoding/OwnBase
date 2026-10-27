import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findEarlierNames, findEarlierNamesInRepo } from "./check-product-name.mjs";

const gate = join(dirname(fileURLToPath(import.meta.url)), "check-product-name.mjs");

/** A folder holding `files`. */
function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), "product-name-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

/** A built client holding `files`, beside what every build has. */
const built = (files = {}) =>
  folder({
    "index.html": "<!doctype html><title>OwnBase</title>",
    "assets/index-A1.js": 'const key="ownbase-first-paint";document.title="OwnBase";\n',
    "assets/photo-C3.png": Buffer.from("Tandem in a picture is not text"),
    ...files,
  });

/** A git repository holding `files`, all of them tracked. */
function repository(files) {
  const dir = folder(files);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  return dir;
}

test("passes a build that shows only the current name", () => {
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

test("finds an earlier name a person would read, or code would, where it is", () => {
  const dir = built({
    "assets/index-A1.js": 'x="ok";\nconst t="Sign in to Tandem";\n',
    "manifest.webmanifest": '{ "name": "Gatherline" }',
    "assets/index-B2.css": '.a::after { content: "Tandem" }',
    "assets/keys-C4.js": 'localStorage.getItem("slackoss:servers");\n',
  });
  try {
    assert.deepEqual(findEarlierNames(dir).sort(), [
      'assets/index-A1.js:2: const t="Sign in to Tandem";',
      'assets/index-B2.css:1: .a::after { content: "Tandem" }',
      'assets/keys-C4.js:1: localStorage.getItem("slackoss:servers");',
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

test("finds an earlier name in any tracked text file, in any case", () => {
  const dir = repository({
    "README.md": "# OwnBase\n\nSee https://github.com/Blazeiscoding/Tandem for the code.\n",
    "packages/server/src/config.ts": "const old = process.env.TANDEM_PORT;\n",
    "packages/ui/package.json": '{ "name": "@slackoss/ui" }\n',
    "docs/guide.md": "Links open as gatherline://join.\n",
    "picture.png": Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from("Tandem")]),
  });
  try {
    assert.deepEqual(findEarlierNamesInRepo(dir).sort(), [
      "docs/guide.md:1: Links open as gatherline://join.",
      "packages/server/src/config.ts:1: const old = process.env.TANDEM_PORT;",
      'packages/ui/package.json:1: { "name": "@slackoss/ui" }',
    ]);
    assert.throws(
      () =>
        execFileSync(process.execPath, [gate, "--repo", dir], { encoding: "utf8", stdio: "pipe" }),
      (error) => error.status === 1 && /TANDEM_PORT/.test(String(error.stderr)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("passes a repository that names only OwnBase, untracked files aside", () => {
  const dir = repository({ "README.md": "# OwnBase\n" });
  writeFileSync(join(dir, "notes-from-tandem.txt"), "Tandem, untracked\n");
  try {
    assert.deepEqual(findEarlierNamesInRepo(dir), []);
    assert.match(
      execFileSync(process.execPath, [gate, "--repo", dir], { encoding: "utf8" }),
      /the repository: no earlier/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
