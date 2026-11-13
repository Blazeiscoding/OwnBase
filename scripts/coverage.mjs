// How much of each package's source its own unit tests run, one line a
// package, then the largest source files that no package's tests reach. The
// number is there to find code no test reaches, not to pass: there is no
// threshold on purpose, since a gate makes people write tests for the number.
//
//   pnpm coverage [package directory...]
//
// With no arguments it runs every workspace package whose tests are vitest,
// one after another. Each run's raw report lands in coverage/<package>/
// (.gitignore lists coverage/).
//
// A package's line counts only its own tests, but client-core is mostly run by
// the UI's tests, so the list at the end counts a line as reached when any
// package's tests ran it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const LARGEST = 10;
const UNDER = 50;
const SOURCE = "src/**/*.{ts,tsx,mts,js,mjs}";

function workspaceDirs() {
  const listed = spawnSync("git", ["ls-files", "packages/*/package.json", "apps/*/package.json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const dirs = listed.stdout
    .split("\n")
    // Only direct children: git's `*` also matches fixtures further down.
    .filter((file) => file.split("/").length === 3)
    .map((file) => file.replace(/\/package\.json$/, ""));
  dirs.push("ee", "ee/cloud");
  return dirs.filter((dir) => {
    const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
    return /\bvitest\b/.test(pkg.scripts?.test ?? "");
  });
}

/** Istanbul's file coverage reduced to counts, lines as istanbul counts them. */
function counts(file) {
  const lines = new Map();
  for (const [id, location] of Object.entries(file.statementMap)) {
    const line = location.start.line;
    lines.set(line, (lines.get(line) ?? 0) + file.s[id]);
  }
  const branches = Object.values(file.b).flat();
  const functions = Object.values(file.f);
  return {
    lines: { covered: [...lines.values()].filter((hits) => hits > 0).length, total: lines.size },
    branches: { covered: branches.filter((hits) => hits > 0).length, total: branches.length },
    functions: { covered: functions.filter((hits) => hits > 0).length, total: functions.length },
  };
}

/** Adds one run's hits into another's, when both mapped the file the same way. */
function merge(into, from) {
  const same = (a, b) => Object.keys(a).length === Object.keys(b).length;
  if (!same(into.statementMap, from.statementMap) || !same(into.fnMap, from.fnMap)) {
    return counts(from).lines.covered > counts(into).lines.covered ? from : into;
  }
  for (const id of Object.keys(into.s)) into.s[id] += from.s[id];
  for (const id of Object.keys(into.f)) into.f[id] += from.f[id];
  for (const id of Object.keys(into.b)) {
    into.b[id] = into.b[id].map((hits, i) => hits + (from.b[id]?.[i] ?? 0));
  }
  return into;
}

const percent = ({ covered, total }) => (total === 0 ? 100 : (100 * covered) / total);
const format = (metric) => `${percent(metric).toFixed(1)}%`.padStart(6);
const posix = (path) => path.replaceAll("\\", "/");

const all = workspaceDirs();
const dirs = process.argv.length > 2 ? process.argv.slice(2) : all;
const reached = new Map();
let failed = false;

for (const dir of dirs) {
  const cwd = join(ROOT, dir);
  const name = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).name;
  const reports = join(ROOT, "coverage", dir.replaceAll("/", "-"));
  rmSync(reports, { recursive: true, force: true });
  // Vitest reports only the files a test loaded unless told where source
  // is, and the files nothing loads are the ones this is for. Every package's
  // source is listed so a run also says what it reached elsewhere.
  const include = all.map(
    (other) => `--coverage.include=${posix(relative(cwd, join(ROOT, other)) || ".")}/${SOURCE}`,
  );
  const run = spawnSync(
    process.execPath,
    [
      join(cwd, "node_modules/vitest/vitest.mjs"),
      "run",
      "--coverage.enabled",
      "--coverage.provider=v8",
      ...include,
      "--coverage.exclude=**/*.d.ts",
      "--coverage.allowExternal",
      "--coverage.reporter=json",
      "--coverage.reportOnFailure",
      `--coverage.reportsDirectory=${reports}`,
    ],
    { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const report = join(reports, "coverage-final.json");
  if (!existsSync(report)) {
    console.error(`${name}: no coverage written (exit ${run.status})`);
    console.error((run.stdout + run.stderr).split("\n").slice(-40).join("\n"));
    failed = true;
    continue;
  }
  const total = {
    lines: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
  };
  let files = 0;
  let under = 0;
  for (const [path, file] of Object.entries(JSON.parse(readFileSync(report, "utf8")))) {
    const key = posix(relative(ROOT, path));
    reached.set(key, reached.has(key) ? merge(reached.get(key), file) : file);
    if (!key.startsWith(`${dir}/src/`)) continue;
    const own = counts(file);
    for (const metric of Object.keys(total)) {
      total[metric].covered += own[metric].covered;
      total[metric].total += own[metric].total;
    }
    files += 1;
    if (percent(own.lines) < UNDER) under += 1;
  }
  const testsFailed = run.status === 0 ? "" : `, tests FAILED (exit ${run.status})`;
  if (testsFailed) failed = true;
  console.log(
    `${name.padEnd(22)} lines ${format(total.lines)}  branches ${format(total.branches)}  ` +
      `functions ${format(total.functions)}  ${files} files, ${under} under ${UNDER}%${testsFailed}`,
  );
}

const largest = [...reached]
  .map(([file, coverage]) => ({
    file,
    size: readFileSync(join(ROOT, file), "utf8").split("\n").length,
    covered: percent(counts(coverage).lines),
  }))
  .filter((entry) => entry.covered < UNDER)
  .sort((a, b) => b.size - a.size)
  .slice(0, LARGEST);
if (largest.length > 0) {
  console.log(`\nLargest source files under ${UNDER}% of lines reached by the tests run:`);
  for (const { file, size, covered } of largest) {
    console.log(`${String(size).padStart(6)} lines  ${covered.toFixed(1).padStart(5)}%  ${file}`);
  }
}
if (failed) process.exit(1);
