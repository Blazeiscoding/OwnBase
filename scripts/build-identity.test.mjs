import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  ARTIFACTS,
  ROOT,
  SHARED_INPUTS,
  buildIdentity,
  check,
  inputsHash,
  manifestProblem,
  readAsarFile,
  staleness,
  writeBuildIdentity,
} from "./build-identity.mjs";

/** A checkout with the web client's inputs, and nothing else. */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "build-identity-"));
  const put = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  put("package.json", JSON.stringify({ version: "1.2.3" }));
  put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  put("apps/web/src/main.tsx", "export const app = 1;\n");
  put("packages/ui/src/App.tsx", "export const App = () => null;\n");
  put("packages/client-core/src/index.ts", "export {};\n");
  put("packages/protocol/src/index.ts", "export {};\n");
  return { root, put };
}

test("the hash follows the source and nothing a build or test writes", () => {
  const { root, put } = checkout();
  try {
    const inputs = ARTIFACTS.web.inputs;
    const first = inputsHash(inputs, root);
    put("apps/web/dist/assets/index-abc.js", "built");
    put("packages/ui/node_modules/x/index.js", "dependency");
    put("packages/ui/test/App.dom.test.tsx", "a test");
    put("packages/ui/src/App.test.tsx", "a test beside the source");
    put("apps/web/vite.config.ts.timestamp-1700000000000-abc.mjs", "a config being loaded");
    put("apps/web/tsup.config.bundled_x1y2z3.mjs", "a config being loaded");
    put("apps/web/electron.vite.config.1790913675585.mjs", "a config being loaded");
    assert.equal(inputsHash(inputs, root), first);
    // Windows line endings are the same source.
    put("packages/ui/src/App.tsx", "export const App = () => null;\r\n");
    assert.equal(inputsHash(inputs, root), first);
    put("packages/ui/src/App.tsx", "export const App = () => 'changed';\n");
    assert.notEqual(inputsHash(inputs, root), first);
    put("packages/ui/src/App.tsx", "export const App = () => null;\n");
    put("packages/ui/src/New.tsx", "export const New = 1;\n");
    assert.notEqual(inputsHash(inputs, root), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a manifest says the version and, outside git, that the revision is unknown", () => {
  const { root } = checkout();
  try {
    const identity = buildIdentity(ARTIFACTS.web.inputs, root);
    assert.equal(identity.version, "1.2.3");
    assert.equal(identity.inputs, inputsHash(ARTIFACTS.web.inputs, root));
    assert.match(identity.builtAt, /^\d{4}-\d\d-\d\dT/);
    if (!process.env.GITHUB_SHA) {
      assert.equal(identity.revision, "unknown");
      assert.equal(identity.dirty, null);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh build passes; a missing, unreadable or older one names what to rebuild", () => {
  const { root, put } = checkout();
  try {
    assert.match(
      check(["web"], root)[0],
      /no build\.json: build it with `pnpm --filter @ownbase\/web build`/,
    );
    mkdirSync(join(root, "apps/web/dist"), { recursive: true });
    writeBuildIdentity("web", join(root, "apps/web/dist"), root);
    assert.deepEqual(check(["web"], root), []);
    put("packages/client-core/src/index.ts", "export const edited = true;\n");
    const [problem] = check(["web"], root);
    assert.match(problem, /apps\/web\/dist\/build\.json was built from other source/);
    assert.match(problem, /rebuild it with `pnpm --filter @ownbase\/web build`/);
    assert.match(staleness("web", "{not json", root), /unreadable build\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads a manifest out of a real asar archive, as the packaged app carries it", async () => {
  // The same library Electron Builder packs with, as the archive gate's tests load it.
  const pnpm = join(ROOT, "node_modules", ".pnpm");
  const name = readdirSync(pnpm).find((entry) => entry.startsWith("@electron+asar@"));
  const asar = createRequire(join(ROOT, "package.json"))(
    join(pnpm, name, "node_modules", "@electron", "asar"),
  );
  const dir = mkdtempSync(join(tmpdir(), "build-identity-asar-"));
  try {
    mkdirSync(join(dir, "app/out/main"), { recursive: true });
    writeFileSync(join(dir, "app/out/build.json"), '{"inputs":"abc"}\n');
    writeFileSync(join(dir, "app/out/main/index.js"), "main");
    await asar.createPackage(join(dir, "app"), join(dir, "app.asar"));
    assert.equal(readAsarFile(join(dir, "app.asar"), "out/build.json"), '{"inputs":"abc"}\n');
    assert.equal(readAsarFile(join(dir, "app.asar"), "out/missing.json"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every input Turbo rebuilds for, and this script, makes an older build stale (F05)", () => {
  const turbo = JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8"));
  for (const path of turbo.globalDependencies) assert.ok(SHARED_INPUTS.includes(path), path);
  assert.ok(SHARED_INPUTS.includes("scripts/build-identity.mjs"));
  const { root, put } = checkout();
  try {
    for (const path of [
      "pnpm-workspace.yaml",
      ".npmrc",
      ".pnpmfile.cjs",
      "tsconfig.base.json",
      "scripts/build-identity.mjs",
    ]) {
      const before = inputsHash(ARTIFACTS.web.inputs, root);
      put(path, `changed ${path}\n`);
      assert.notEqual(inputsHash(ARTIFACTS.web.inputs, root), before, path);
      mkdirSync(join(root, "apps/web/dist"), { recursive: true });
      writeBuildIdentity("web", join(root, "apps/web/dist"), root);
      put(path, `changed again ${path}\n`);
      assert.match(check(["web"], root)[0] ?? "", /was built from other source/, path);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a binary file is hashed byte for byte, and text by its committed line endings (F05)", () => {
  const { root, put } = checkout();
  try {
    put("packages/ui/src/icon.png", Buffer.from([0x00, 0x0d, 0x0a, 0xff]));
    const crlf = inputsHash(ARTIFACTS.web.inputs, root);
    put("packages/ui/src/icon.png", Buffer.from([0x00, 0x0a, 0xff]));
    assert.notEqual(inputsHash(ARTIFACTS.web.inputs, root), crlf);
    // A file named as text that carries a NUL byte is binary too.
    put("packages/ui/src/data.json", Buffer.from([0x00, 0x0d, 0x0a]));
    const named = inputsHash(ARTIFACTS.web.inputs, root);
    put("packages/ui/src/data.json", Buffer.from([0x00, 0x0a]));
    assert.notEqual(inputsHash(ARTIFACTS.web.inputs, root), named);
    // Named text files without an extension are text as well, on any platform.
    put("packages/ui/LICENSE", "MIT\r\n");
    const license = inputsHash(ARTIFACTS.web.inputs, root);
    put("packages/ui/LICENSE", "MIT\n");
    assert.equal(inputsHash(ARTIFACTS.web.inputs, root), license);
    put("packages/ui/src/style.css", "a {}\r\n");
    const text = inputsHash(ARTIFACTS.web.inputs, root);
    put("packages/ui/src/style.css", "a {}\n");
    assert.equal(inputsHash(ARTIFACTS.web.inputs, root), text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a manifest of the wrong shape names what to rebuild instead of throwing (F05)", () => {
  const { root } = checkout();
  try {
    for (const text of ["null", "7", "[]", '{"revision": 7}', '{"inputs": "nothex"}']) {
      assert.match(staleness("web", text, root), /has a build\.json that .*: rebuild it with/);
    }
    assert.equal(
      manifestProblem({ version: "1", revision: "abc", dirty: false, inputs: "0123456789abcdef" }),
      null,
    );
    assert.match(
      manifestProblem({ version: "1", revision: "abc", dirty: "no", inputs: "0123456789abcdef" }),
      /changes/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
