// The image's dependency stage is reused by a source-only edit and redone by a
// lockfile edit (REV-08). Run after a build in the same buildx builder, from
// the repository root; the files it edits are put back however it ends.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

// BuildKit applies SOURCE_DATE_EPOCH to every stage, so it is part of each
// step's cache key. CI dates the image by its commit; these builds pass the
// same value, or nothing the earlier build cached would match.
const epoch = process.env.SOURCE_DATE_EPOCH
  ? ["--build-arg", `SOURCE_DATE_EPOCH=${process.env.SOURCE_DATE_EPOCH}`]
  : [];

/** Builds `target` and says whether `pnpm fetch` came from the cache, and how long it took. */
function build(target) {
  const began = Date.now();
  const run = spawnSync(
    "docker",
    [
      "buildx",
      "build",
      "-f",
      "docker/Dockerfile",
      "--target",
      target,
      ...epoch,
      "--progress=plain",
      ".",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const log = `${run.stdout}\n${run.stderr}`;
  assert.equal(
    run.status,
    0,
    `docker buildx build --target ${target} failed:\n${log.slice(-4000)}`,
  );
  // BuildKit may name the stage with its platform (`[linux/amd64 deps 3/4]`),
  // since the stage runs on the build machine's own.
  const step = log.match(/^(#\d+) \[(?:\S+ )?deps \d+\/\d+\] RUN pnpm fetch$/m)?.[1];
  assert(step, `no "RUN pnpm fetch" step in the build output:\n${log.slice(-4000)}`);
  return {
    fetchCached: log.split("\n").some((line) => line.trim() === `${step} CACHED`),
    seconds: Math.round((Date.now() - began) / 100) / 10,
  };
}

/** Runs `work` with `path` edited by `change`, then puts the file back. */
function edited(path, change, work) {
  const original = readFileSync(path, "utf8");
  writeFileSync(path, change(original));
  try {
    return work();
  } finally {
    writeFileSync(path, original);
  }
}

const sourceEdit = edited(
  "packages/server/src/version.ts",
  (text) => `${text}\n// A source-only edit.\n`,
  () => build("build"),
);
assert(sourceEdit.fetchCached, "a source-only edit fetched the dependencies again");
console.log(`source-only edit: dependencies reused, rebuilt in ${sourceEdit.seconds} s`);

const lockEdit = edited(
  "pnpm-lock.yaml",
  (text) => `${text}\n# A lockfile edit.\n`,
  () => build("deps"),
);
assert(!lockEdit.fetchCached, "a lockfile edit reused the dependencies fetched for the old one");
console.log(`lockfile edit: dependencies fetched again in ${lockEdit.seconds} s`);
