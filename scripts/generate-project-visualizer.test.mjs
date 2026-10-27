import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = "docs/PROJECT-VISUALIZER.html";
const normalized = (value) => value.replace(/\r\n/g, "\n");
const read = (path, base = root) => normalized(readFileSync(resolve(base, path), "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const git = (base, ...args) =>
  execFileSync("git", args, { cwd: base, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

assert.ok(existsSync(resolve(root, outputPath)), "Run pnpm visualizer:build before these checks.");
const html = read(outputPath);
const dataBlocks = [
  ...html.matchAll(/<script id="project-data" type="application\/json">([\s\S]*?)<\/script>/g),
];
assert.equal(dataBlocks.length, 1, "The page must contain exactly one JSON snapshot.");
const data = JSON.parse(dataBlocks[0][1]);
const byPath = new Map(data.files.map((file) => [file.path, file]));
const catalogs = ["client", "server", "desktop"].map((name) =>
  JSON.parse(read(`docs/visualizer/content/${name}.json`)),
);

test("the snapshot includes tracked inputs, excludes private/build data, and preserves every file", () => {
  const tracked = git(root, "ls-files", "-z").split("\0").filter(Boolean);
  for (const path of tracked) {
    if (path !== outputPath) assert.ok(byPath.has(path), `Missing tracked input: ${path}`);
  }
  assert.equal(byPath.size, data.files.length, "File paths must be unique.");
  assert.ok(!byPath.has(outputPath), "The generated page must not embed itself.");
  assert.ok(
    byPath.has("scripts/generate-project-visualizer.test.mjs"),
    "Include these verification inputs.",
  );
  for (const file of data.files) {
    assert.ok(!/(^|\/)(?:node_modules|\.audit[^/]*)(\/|$)/.test(file.path), file.path);
    assert.ok(!/^apps\/[^/]+\/(?:dist|out|release)\//.test(file.path), file.path);
    const absolute = resolve(root, file.path);
    const withinRoot = relative(root, absolute);
    assert.ok(!isAbsolute(withinRoot) && !withinRoot.startsWith(".."), file.path);
    const raw = readFileSync(absolute);
    assert.equal(file.bytes, raw.length, `${file.path}: byte count`);
    assert.equal(file.hash, sha256(raw), `${file.path}: SHA-256`);
    if (file.source !== null) {
      assert.equal(file.source, normalized(raw.toString("utf8")), `${file.path}: complete source`);
      assert.equal(file.lines, file.source.split("\n").length, `${file.path}: lines`);
    } else {
      assert.equal(file.lines, 0, `${file.path}: binary line count`);
    }
  }
});

test("counts, input digest, declaration positions and reverse references agree with the snapshot", () => {
  assert.deepEqual(
    data.files.map((file) => file.path),
    [...byPath.keys()].sort(),
  );
  assert.equal(data.meta.fileCount, data.files.length);
  assert.equal(data.meta.textCount, data.files.filter((file) => file.source !== null).length);
  assert.equal(
    data.meta.totalLines,
    data.files.reduce((sum, file) => sum + file.lines, 0),
  );
  assert.equal(
    data.meta.symbols,
    data.files.reduce((sum, file) => sum + file.symbols.length, 0),
  );
  assert.equal(
    data.meta.edges,
    data.files.reduce((sum, file) => sum + file.imports.filter((entry) => entry.path).length, 0),
  );
  assert.equal(
    data.meta.inputDigest,
    sha256(data.files.map((file) => `${file.path}\0${file.hash}`).join("\n")),
  );
  for (const file of data.files) {
    for (const symbol of file.symbols) {
      assert.ok(symbol.line >= 1 && symbol.line <= file.lines, `${file.path}: ${symbol.name}`);
      assert.ok(
        symbol.end >= symbol.line && symbol.end <= file.lines,
        `${file.path}: ${symbol.name} end`,
      );
    }
    for (const dependency of file.imports) {
      assert.ok(dependency.line >= 1 && dependency.line <= file.lines, `${file.path}: import line`);
      if (dependency.path) {
        assert.ok(byPath.has(dependency.path), `${file.path} -> ${dependency.path}`);
        assert.ok(
          byPath.get(dependency.path).usedBy.includes(file.path),
          "Missing reverse reference",
        );
      }
    }
    assert.equal(
      new Set(file.usedBy).size,
      file.usedBy.length,
      `${file.path}: duplicate reverse reference`,
    );
    for (const importer of file.usedBy) {
      assert.ok(
        byPath.get(importer)?.imports.some((entry) => entry.path === file.path),
        `${importer} -> ${file.path}`,
      );
    }
  }
});

test("runtime explanations and all guide/evidence references are complete", () => {
  const entries = catalogs.flatMap((catalog) => catalog.entries);
  assert.equal(new Set(entries.map((entry) => entry.path)).size, entries.length);
  const runtime = data.files.filter((file) =>
    /^(?:(?:packages|apps)\/.+|ee|ee\/cloud)\/src\//.test(file.path),
  );
  assert.ok(runtime.length > 0);
  assert.equal(data.meta.runtimeCount, runtime.length);
  assert.equal(data.meta.explainedRuntime, runtime.length);
  for (const file of runtime) {
    assert.equal(file.curated, true, file.path);
    const explanation = entries.find((entry) => entry.path === file.path);
    assert.ok(explanation, `Missing reviewed explanation: ${file.path}`);
    assert.equal(file.summary, explanation.summary);
    assert.deepEqual(file.details, explanation.details);
    assert.ok(file.summary.length > 20 && file.details.length > 0, file.path);
  }
  const references = [
    ...entries.map((entry) => entry.path),
    ...data.guide.areas.map((area) => area.entry),
    ...data.guide.principles.flatMap((principle) => principle.files),
    ...data.guide.validation.map((record) => record.path),
    ...data.flows.flatMap((flow) => flow.steps.flatMap((step) => step.files)),
    ...data.optimizations.flatMap((item) => item.files),
    ...data.optimizations.flatMap((item) => item.evidence.map((evidence) => evidence.path)),
  ];
  for (const path of references) assert.ok(byPath.has(path), `Broken guide reference: ${path}`);
  const ids = [...data.flows, ...data.optimizations].map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "Guide IDs must be unique.");
  // Q01 to Q13 were recorded as open findings. One counts as repaired only
  // with a test to show for it.
  for (let index = 1; index <= 13; index++) {
    const id = `Q${String(index).padStart(2, "0")}`;
    const item = data.optimizations.find((entry) => entry.id === id);
    assert.ok(item, id);
    if (item.status === "follow-up") continue;
    assert.equal(item.status, "implemented", id);
    assert.ok(
      item.evidence.some((evidence) => evidence.path.includes("/test/")),
      `${id} is marked repaired without a test as evidence`,
    );
  }
});

test("workspace subpaths and literal dynamic imports connect to actual local implementations", () => {
  const expectImport = (path, specifier, target, dynamic = false) => {
    const dependency = byPath.get(path)?.imports.find((entry) => entry.specifier === specifier);
    assert.ok(dependency, `${path}: missing ${specifier}`);
    assert.equal(dependency.path, target, `${path}: local resolution`);
    if (dynamic) assert.equal(dependency.dynamic, true, `${path}: dynamic import`);
  };
  expectImport(
    "apps/desktop/src/main/backupWorker.ts",
    "@ownbase/server/backup",
    "packages/server/src/backup.ts",
  );
  expectImport(
    "apps/desktop/src/main/registry.ts",
    "@ownbase/server/ownership",
    "packages/server/src/ownership.ts",
  );
  expectImport(
    "apps/desktop/src/main/draftsStorage.ts",
    "@ownbase/client-core/drafts",
    "packages/client-core/src/drafts.ts",
  );
  expectImport(
    "apps/desktop/src/main/outboxStorage.ts",
    "@ownbase/client-core/outbox",
    "packages/client-core/src/outbox.ts",
  );
  expectImport(
    "apps/desktop/src/main/index.ts",
    "@ownbase/client-core/records",
    "packages/client-core/src/records.ts",
  );
  expectImport(
    "packages/ui/src/components/Composer.tsx",
    "@ownbase/protocol/rest",
    "packages/protocol/src/rest.ts",
    true,
  );
});

test("HTML contains one parseable application script and preserves literal template/dollar tokens", () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, "Only the atlas application is executable.");
  assert.equal(scripts[0][1].trim(), read("docs/visualizer/app.js").trim());
  assert.doesNotThrow(() => new Script(scripts[0][1], { filename: "project-visualizer-app.js" }));
  assert.equal(
    dataBlocks[0][1].includes("<"),
    false,
    "Markup delimiters must be escaped inside JSON.",
  );
  const markers = ["/* VISUALIZER_STYLES */", "/* VISUALIZER_DATA */", "/* VISUALIZER_APP */"];
  for (const marker of markers) {
    assert.ok(
      byPath.get("docs/visualizer/template.html").source.includes(marker),
      `Preserve ${marker}`,
    );
    assert.ok(
      !html.replace(dataBlocks[0][0], "").includes(marker),
      `Unreplaced live marker: ${marker}`,
    );
  }
  for (const token of ["$&", "$'", "$`", "$$"]) {
    const actual = data.files.filter((file) => file.source?.includes(token));
    assert.ok(actual.length > 0, `The fixture must exercise replacement token ${token}`);
    for (const file of actual)
      assert.equal(file.source, read(file.path), `${file.path}: preserve ${token}`);
  }
});

test("freshness survives commit/capture metadata changes but rejects changed source", () => {
  const temporaryRoot = realpathSync(tmpdir());
  const fixture = mkdtempSync(resolve(temporaryRoot, "ownbase-visualizer-check-"));
  const write = (path, contents) => {
    const destination = resolve(fixture, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  };
  const commit = (message) =>
    git(
      fixture,
      "-c",
      "user.name=Visualizer fixture",
      "-c",
      "user.email=visualizer@example.invalid",
      "commit",
      "--quiet",
      "-m",
      message,
    );
  const runGenerator = (...args) =>
    execFileSync(
      process.execPath,
      [resolve(fixture, "scripts/generate-project-visualizer.mjs"), ...args],
      { cwd: fixture, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  try {
    // Change only dependency resolution in this disposable copy; generator logic
    // and all real repository inputs/output/HEAD remain untouched.
    const typescript = pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href;
    write(
      "scripts/generate-project-visualizer.mjs",
      read("scripts/generate-project-visualizer.mjs").replace(
        'import ts from "typescript";',
        () => `import ts from ${JSON.stringify(typescript)};`,
      ),
    );
    write("scripts/serve-project-visualizer.mjs", read("scripts/serve-project-visualizer.mjs"));
    write(
      "scripts/generate-project-visualizer.test.mjs",
      read("scripts/generate-project-visualizer.test.mjs"),
    );
    write("docs/visualizer/template.html", read("docs/visualizer/template.html"));
    write("docs/visualizer/style.css", ".fixture { color: green; }\n");
    write("docs/visualizer/app.js", "(() => { const label = 'fixture application'; })();\n");
    write(
      "docs/visualizer/content/guide.json",
      JSON.stringify({ areas: [], principles: [], validation: [] }),
    );
    write("docs/visualizer/content/optimizations.json", JSON.stringify({ items: [] }));
    for (const area of ["client", "server", "desktop"]) {
      write(
        `docs/visualizer/content/${area}.json`,
        JSON.stringify({
          area,
          overview: "Fixture only",
          entries:
            area === "server"
              ? [
                  {
                    path: "packages/server/src/index.ts",
                    summary: "Synthetic marker fixture",
                    details: ["Not product data."],
                    concepts: [],
                  },
                ]
              : [],
          flows: [],
        }),
      );
    }
    const literal = "$& $' $` $$ /* VISUALIZER_APP */ </script>";
    write("packages/server/src/index.ts", `export const marker = ${JSON.stringify(literal)};\n`);
    git(fixture, "init", "--quiet");
    git(
      fixture,
      "remote",
      "add",
      "origin",
      "https://example.invalid/ownbase-visualizer-fixture.git",
    );
    git(fixture, "-c", "core.autocrlf=false", "add", "packages/server/src/index.ts");
    commit("Initial synthetic source");
    runGenerator();
    const captured = read(outputPath, fixture);
    const capturedData = JSON.parse(
      captured.match(/<script id="project-data" type="application\/json">([\s\S]*?)<\/script>/)[1],
    );
    assert.equal(
      capturedData.files.find((file) => file.path === "packages/server/src/index.ts").source,
      read("packages/server/src/index.ts", fixture),
    );
    assert.match(runGenerator("--check"), /Visualizer is current/);
    git(fixture, "-c", "core.autocrlf=false", "add", ".");
    commit("Commit unchanged atlas inputs and output");
    assert.notEqual(git(fixture, "rev-parse", "HEAD").trim(), capturedData.meta.revision);
    assert.ok(
      git(fixture, "ls-files", "-z").split("\0").filter(Boolean).length - 1 >
        capturedData.meta.trackedCount,
    );
    assert.match(runGenerator("--check"), /Visualizer is current/);
    assert.equal(
      read(outputPath, fixture),
      captured,
      "Freshness checking must not rewrite capture metadata.",
    );
    write(
      "packages/server/src/index.ts",
      `${read("packages/server/src/index.ts", fixture)}export const changed = true;\n`,
    );
    assert.throws(() => runGenerator("--check"), /visualizer is stale/i);
    assert.equal(
      read(outputPath, fixture),
      captured,
      "A refused freshness check must not rewrite the artifact.",
    );
  } finally {
    // Resolve and bound the generated folder before recursive removal; no links
    // to project directories are created in this fixture.
    const target = realpathSync(fixture);
    const withinTemporaryRoot = relative(temporaryRoot, target);
    assert.ok(
      !isAbsolute(withinTemporaryRoot) &&
        !withinTemporaryRoot.startsWith("..") &&
        withinTemporaryRoot.startsWith("ownbase-visualizer-check-"),
    );
    rmSync(target, { recursive: true, force: true });
  }
});
