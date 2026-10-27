/**
 * Which source an artifact was built from (IMP-08). Each build writes a
 * `build.json` beside what it built: the version, the git revision and
 * whether the tree had changes then, and a hash of the files that went into
 * it. The hash is of the files themselves, not of git, so it means the same
 * in a container without `.git` and catches an edit nobody committed.
 *
 *   node scripts/build-identity.mjs check web server desktop
 *
 * compares each named artifact's `build.json` with the checkout and exits 1,
 * naming what to rebuild, when one is missing or was built from other files.
 * Tests run against what was built, so they check it is what is checked out.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Files every build reads, whatever it builds (F05): what Turbo's cache
 * already counts as every task's input (`globalDependencies`: the TypeScript
 * base config and pnpm's workspace and install settings), the manifest and
 * lockfile, and this script, which writes the identity into each build. One
 * list, read from the build configuration, so a change that makes Turbo
 * build again also makes an older build stale here.
 */
export const SHARED_INPUTS = [
  ...new Set([
    "package.json",
    "pnpm-lock.yaml",
    ...JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8")).globalDependencies,
    "scripts/build-identity.mjs",
  ]),
];

/**
 * Formats hashed as text, with Windows line endings read as committed ones,
 * so a Windows checkout hashes like the rest. Everything else, images and
 * fonts above all, is hashed byte for byte: reading `0d 0a` as `0a` in a
 * binary file would let a changed asset pass as the same (F05).
 */
const TEXT =
  /\.([cm]?[jt]sx?|json|jsonc|md|css|html?|ya?ml|svg|txt|xml|map|webmanifest|ps1|sh|nsh|cjs|mjs)$|(^|\/)(\.npmrc|\.gitattributes|\.gitignore|LICENSE)$/i;

/**
 * The bytes a file is hashed as. `name` is its path from the root with `/`
 * separators, so a Windows path's backslashes decide nothing.
 */
function contents(path, name) {
  const bytes = readFileSync(path);
  // A NUL byte is binary whatever the name says, as git decides.
  if (!TEXT.test(name) || bytes.subarray(0, 8000).includes(0)) return bytes;
  return Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
}

/** Where each artifact's manifest is, and which source folders go into it. */
export const ARTIFACTS = {
  web: {
    manifest: "apps/web/dist/build.json",
    inputs: ["apps/web", "packages/ui", "packages/client-core", "packages/protocol"],
    rebuild: "pnpm --filter @ownbase/web build",
  },
  server: {
    manifest: "apps/server-cli/dist/build.json",
    inputs: ["apps/server-cli", "ee", "packages/server", "packages/protocol"],
    rebuild: "pnpm --filter ownbase-server build",
  },
  desktop: {
    manifest: "apps/desktop/out/build.json",
    inputs: [
      "apps/desktop",
      "packages/ui",
      "packages/client-core",
      "packages/protocol",
      "packages/server",
    ],
    rebuild: "pnpm --filter @ownbase/desktop build",
  },
};

/** Never inputs: what builds write, dependencies, and tests, which no artifact contains. */
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "release",
  ".turbo",
  "test",
  "data",
  "test-results",
]);
// Bundlers load a TypeScript config by writing it out as JavaScript beside
// itself for a moment (`tsup.config.bundled_….mjs`, `vite.config.ts.timestamp-….mjs`,
// `electron.vite.config.1790913675585.mjs`), which is exactly when a build
// reads its own identity.
const SKIPPED_FILE =
  /\.(test|spec)\.[cm]?[jt]sx?$|\.tsbuildinfo$|^\.DS_Store$|\.bundled_[^/]*\.[cm]?js$|\.timestamp-[^/]*\.[cm]?js$|\.config\.\d+\.[cm]?js$/;

function* files(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* files(join(dir, entry.name));
    } else if (entry.isFile() && !SKIPPED_FILE.test(entry.name)) yield join(dir, entry.name);
  }
}

/** A hash of every input file's path and bytes, the same on any platform. */
export function inputsHash(inputs, root = ROOT) {
  const paths = [
    ...SHARED_INPUTS.map((path) => join(root, path)).filter((path) => existsSync(path)),
    ...inputs.flatMap((input) => [...files(join(root, input))]),
  ]
    .map((path) => relative(root, path).split(sep).join("/"))
    .sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(contents(join(root, path), path));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function git(args, root) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The identity an artifact built from `inputs` gets now. */
export function buildIdentity(inputs, root = ROOT) {
  const revision = process.env.GITHUB_SHA || git(["rev-parse", "HEAD"], root);
  const status = git(["status", "--porcelain", "--", ...SHARED_INPUTS, ...inputs], root);
  // What the hash leaves out, a bundler's config of the moment above all,
  // is no change to the source either.
  const changed =
    status === null
      ? null
      : status
          .split("\n")
          .filter((line) => line && !SKIPPED_FILE.test(line.slice(3).split("/").at(-1) ?? ""))
          .join("\n");
  return {
    version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    revision: revision ?? "unknown",
    // Null when there is no git to ask, as in a container build.
    dirty: changed === null ? null : changed.length > 0,
    inputs: inputsHash(inputs, root),
    builtAt: new Date().toISOString(),
  };
}

/** Writes `build.json` for `artifact` into `dir`, and returns what it wrote. */
export function writeBuildIdentity(artifact, dir, root = ROOT) {
  const identity = buildIdentity(ARTIFACTS[artifact].inputs, root);
  writeFileSync(join(dir, "build.json"), JSON.stringify(identity, null, 2) + "\n");
  return identity;
}

/** One file out of an asar archive, read from its header: no Electron needed. */
export function readAsarFile(archive, path) {
  const fd = openSync(archive, "r");
  try {
    const prefix = Buffer.alloc(16);
    readSync(fd, prefix, 0, 16, 0);
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    readSync(fd, json, 0, jsonSize, 16);
    let node = JSON.parse(json.toString("utf8"));
    for (const part of path.split("/")) node = node?.files?.[part];
    if (!node || node.files || node.unpacked) return null;
    const content = Buffer.alloc(Number(node.size));
    readSync(fd, content, 0, content.length, 8 + headerSize + Number(node.offset));
    return content.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * What is wrong with the shape of a parsed `build.json`, or null: valid JSON
 * that is not one (`null`, a number revision) must say so, not throw (F05).
 */
export function manifestProblem(built) {
  if (built === null || typeof built !== "object" || Array.isArray(built))
    return "is not an object";
  if (typeof built.inputs !== "string" || !/^[0-9a-f]{16}$/.test(built.inputs))
    return "names no source inputs";
  if (typeof built.revision !== "string") return "names no revision";
  if (typeof built.version !== "string") return "names no version";
  if (built.dirty !== true && built.dirty !== false && built.dirty !== null)
    return "does not say whether the source had changes";
  return null;
}

/** What is wrong with one built manifest against the checkout, or null. */
export function staleness(artifact, manifestText, root = ROOT) {
  const { inputs, rebuild } = ARTIFACTS[artifact];
  if (manifestText === null) return `has no build.json: build it with \`${rebuild}\``;
  let built;
  try {
    built = JSON.parse(manifestText);
  } catch {
    return `has an unreadable build.json: rebuild it with \`${rebuild}\``;
  }
  const shape = manifestProblem(built);
  if (shape) return `has a build.json that ${shape}: rebuild it with \`${rebuild}\``;
  const now = inputsHash(inputs, root);
  if (built.inputs !== now)
    return `was built from other source (${built.revision?.slice(0, 12)}${built.dirty ? ", with changes" : ""}, inputs ${built.inputs}; the checkout's are ${now}): rebuild it with \`${rebuild}\``;
  return null;
}

/**
 * Where each artifact the tests use keeps its manifests; `archive:path` is a
 * file inside an asar archive.
 */
const CHECKS = {
  web: [["web", "apps/web/dist/build.json"]],
  // The CLI ships the browser client beside it, built separately.
  server: [
    ["server", "apps/server-cli/dist/build.json"],
    ["web", "apps/server-cli/dist/web/build.json"],
  ],
  // The tests launch the package, so its archive is what must match.
  desktop: [
    ["desktop", "apps/desktop/release/win-unpacked/resources/app.asar:out/build.json"],
    ["web", "apps/desktop/release/win-unpacked/resources/web/build.json"],
  ],
};

function readManifest(where, root) {
  const [file, inside] = where.split(":");
  const path = join(root, file);
  if (!existsSync(path)) return null;
  return inside ? readAsarFile(path, inside) : readFileSync(path, "utf8");
}

/** Every problem with the named artifacts, one line each. */
export function check(names, root = ROOT) {
  const problems = [];
  for (const name of names) {
    if (!CHECKS[name]) throw new Error(`no artifact called ${name}`);
    for (const [artifact, where] of CHECKS[name]) {
      const problem = staleness(artifact, readManifest(where, root), root);
      if (problem) problems.push(`${where.replace(":", " → ")} ${problem}`);
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, ...names] = process.argv.slice(2);
  if (command === "check") {
    const problems = check(names);
    if (problems.length > 0) {
      console.error("These were not built from the checkout, so tests would not test it:");
      for (const problem of problems) console.error(`  ${problem}`);
      process.exit(1);
    }
    console.log(`Built from the checkout: ${names.join(", ")}`);
  } else if (command === "write") {
    const [artifact, dir] = names;
    console.log(JSON.stringify(writeBuildIdentity(artifact, resolve(dir))));
  } else {
    console.error(
      "usage: build-identity.mjs check <web|server|desktop>... | write <artifact> <dir>",
    );
    process.exit(2);
  }
}
