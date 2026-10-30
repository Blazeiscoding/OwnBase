// Check cache invalidation with the installed Turbo version and the real
// workspace graph. All edits happen in a temporary fixture, never the checkout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(join(tmpdir(), "ownbase-ci-cache-"));
const turbo = join(root, "node_modules/turbo/bin/turbo");

function run(command, args, cwd = fixture, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", TURBO_DAEMON: "false", ...env },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error ?? result.stderr ?? result.stdout}`);
  return result.stdout;
}

function taskReport(tasks, env = {}) {
  return JSON.parse(
    run(process.execPath, [turbo, "run", ...tasks, "--dry=json", "--no-daemon"], fixture, env),
  );
}

function hashes(tasks = ["build", "typecheck", "test"], env = {}) {
  const report = taskReport(tasks, env);
  return new Map(
    report.tasks
      .filter((task) => task.command !== "<NONEXISTENT>")
      .map((task) => [task.taskId, task.hash]),
  );
}

const packageTask = (name, task) => `@ownbase/${name}#${task}`;
const builds = [
  packageTask("web", "build"),
  packageTask("desktop", "build"),
  "ownbase-server#build",
];

// Each case checks observable task hashes rather than merely matching config.
const cases = [
  { file: "tsconfig.base.json", changed: "all" },
  { file: "pnpm-workspace.yaml", changed: "all" },
  {
    file: "packages/protocol/src/events.ts",
    changed: [
      ...builds,
      ...["protocol", "server", "client-core", "ui", "desktop"].map((p) => packageTask(p, "test")),
      ...["protocol", "server", "client-core", "ui", "desktop", "web"].map((p) =>
        packageTask(p, "typecheck"),
      ),
      "ownbase-server#typecheck",
    ],
  },
  {
    file: "packages/server/src/server.ts",
    changed: ["server", "client-core", "ui", "desktop"].map((p) => packageTask(p, "test")),
  },
  {
    file: "packages/client-core/src/workspace.ts",
    changed: [...builds, ...["client-core", "ui", "desktop"].map((p) => packageTask(p, "test"))],
  },
  {
    file: "packages/ui/src/theme.css",
    changed: [...builds, packageTask("ui", "test"), packageTask("desktop", "typecheck")],
  },
  {
    file: "tests/fixtures/fake-cloudflared.mjs",
    changed: [packageTask("desktop", "test")],
    unchanged: [...builds, packageTask("server", "test"), packageTask("ui", "test")],
  },
  {
    file: "docs/INTEGRATIONS.md",
    changed: [packageTask("server", "test")],
    unchanged: [...builds, packageTask("client-core", "test"), packageTask("ui", "test")],
  },
  {
    file: "apps/desktop/src/renderer/index.html",
    changed: [
      packageTask("desktop", "build"),
      packageTask("server", "test"),
      packageTask("ui", "test"),
    ],
    unchanged: [packageTask("web", "build")],
  },
  {
    file: "apps/desktop/src/main/index.ts",
    changed: [
      packageTask("desktop", "build"),
      packageTask("desktop", "test"),
      packageTask("ui", "test"),
    ],
    unchanged: [packageTask("web", "build")],
  },
  {
    file: "apps/desktop/src/renderer/public/ownbase.svg",
    changed: [packageTask("desktop", "build"), packageTask("ui", "test")],
    unchanged: [packageTask("web", "build")],
  },
  {
    file: "apps/web/index.html",
    changed: [packageTask("web", "build"), "ownbase-server#build", packageTask("ui", "test")],
    unchanged: [packageTask("desktop", "build")],
  },
  {
    file: "apps/web/public/ownbase.svg",
    changed: [packageTask("web", "build"), "ownbase-server#build", packageTask("ui", "test")],
    unchanged: [packageTask("desktop", "build")],
  },
  // The drawing the marks above are written from; ui's tests check they match it.
  {
    file: "scripts/icon-art.mjs",
    changed: [packageTask("ui", "test")],
    unchanged: [packageTask("web", "build"), packageTask("desktop", "build")],
  },
  // Scripts the pages run that ui's tests read and run themselves.
  {
    file: "apps/web/public/first-paint.js",
    changed: [packageTask("web", "build"), "ownbase-server#build", packageTask("ui", "test")],
    unchanged: [packageTask("desktop", "build")],
  },
  {
    file: "apps/web/public/notification-worker.js",
    changed: [packageTask("web", "build"), "ownbase-server#build", packageTask("ui", "test")],
    unchanged: [packageTask("desktop", "build")],
  },
  {
    file: "apps/desktop/src/renderer/public/first-paint.js",
    changed: [packageTask("desktop", "build"), packageTask("ui", "test")],
    unchanged: [packageTask("web", "build")],
  },
  {
    file: "packages/protocol/test/search.test.ts",
    changed: [packageTask("protocol", "test"), packageTask("protocol", "typecheck")],
    unchanged: builds,
  },
  {
    file: "apps/desktop/test/hosting.test.ts",
    changed: [packageTask("desktop", "test"), packageTask("desktop", "typecheck")],
    unchanged: builds,
  },
];

try {
  const files = run(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "turbo.json",
      "tsconfig.base.json",
      ".npmrc",
      ".pnpmfile.cjs",
      ".gitattributes",
      ".gitignore",
      "apps",
      "packages",
      "tests/fixtures",
      "docs/INTEGRATIONS.md",
      "scripts/icon-art.mjs",
    ],
    root,
  )
    .split("\0")
    .filter(Boolean);
  for (const file of new Set(files)) {
    const target = join(fixture, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, file), target);
  }
  run("git", ["init", "--quiet"]);
  run("git", ["add", "."]);
  const baseline = hashes();
  assert.equal(
    baseline.size,
    15,
    "Expected all seven typechecks, five test tasks and three builds",
  );
  assert.deepEqual(hashes(), baseline, "Repeated dry runs must have stable hashes");
  for (const phase of ["typecheck", "test", "build"]) {
    const phaseHashes = hashes([phase]);
    assert.equal(
      phaseHashes.get(packageTask("web", "build")),
      baseline.get(packageTask("web", "build")),
      `The ${phase} phase must reuse the same web-build hash`,
    );
  }
  const boundedTests = taskReport(["test"], { VITEST_MAX_THREADS: "2", VITEST_MAX_FORKS: "2" });
  for (const task of boundedTests.tasks.filter((task) => task.command !== "<NONEXISTENT>")) {
    assert.deepEqual(
      task.cliArguments,
      [],
      `Worker limits must not add command arguments to ${task.taskId}`,
    );
  }
  assert.equal(
    boundedTests.tasks.find((task) => task.taskId === packageTask("web", "build"))?.hash,
    baseline.get(packageTask("web", "build")),
    "Bounded test workers must not change the dependency's web-build hash",
  );
  const boundedHashes = hashes(undefined, { VITEST_MAX_THREADS: "2", VITEST_MAX_FORKS: "2" });
  const differentWorkers = hashes(undefined, { VITEST_MAX_THREADS: "3", VITEST_MAX_FORKS: "3" });
  for (const [task, hash] of boundedHashes) {
    if (task.endsWith("#test")) {
      assert.notEqual(differentWorkers.get(task), hash, `Worker limits must invalidate ${task}`);
    } else {
      assert.equal(differentWorkers.get(task), hash, `Worker limits must preserve ${task}`);
    }
  }

  let assertions = 0;
  for (const { file, changed, unchanged = [] } of cases) {
    const target = join(fixture, file);
    const original = readFileSync(target);
    try {
      // Whitespace is valid for every probed format, including JSON and YAML.
      writeFileSync(target, Buffer.concat([original, Buffer.from("\n ")]));
      const next = hashes();
      for (const task of changed === "all" ? baseline.keys() : changed) {
        assert(baseline.has(task), `Missing expected task ${task}`);
        assert.notEqual(next.get(task), baseline.get(task), `${file} must invalidate ${task}`);
        assertions++;
      }
      for (const task of unchanged) {
        assert.equal(next.get(task), baseline.get(task), `${file} must preserve unrelated ${task}`);
        assertions++;
      }
    } finally {
      writeFileSync(target, original);
    }
  }
  console.log(
    `CI cache inputs verified: ${cases.length} mutations, ${assertions} task-hash assertions.`,
  );
} finally {
  // Only remove the operation-owned child of the temp directory.
  assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
  assert(basename(fixture).startsWith("ownbase-ci-cache-"));
  rmSync(fixture, { recursive: true, force: true });
}
