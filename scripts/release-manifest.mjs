/**
 * Prepares a release from what a release run built and tested (IMP-08): the
 * SHA-256 of every file it publishes, and notes naming the revision each was
 * built from. It refuses an artifact built from any other commit, from changed
 * source, or from a version the tag does not name, so a downloaded build
 * always identifies the revision its tests ran against.
 *
 *   node scripts/release-manifest.mjs <dir> --revision <sha> --tag <tag> --notes <file> [--signed]
 *   node scripts/release-manifest.mjs bind <dir> <artifact> <file>...
 *
 * In <dir>, each `<artifact>.build.json` is the identity an artifact was built
 * with, and each `<artifact>.assets.json` lists, with their SHA-256, the files
 * the job that built and tested that artifact staged for publishing (`bind`
 * writes it there and then). Exactly those files are published (F05): one
 * server archive and one installer, each bound to its tested identity; any
 * other file, a swapped or changed one, or a second installer is refused.
 * `SHA256SUMS` is written into <dir>, the notes to <file>, which is never
 * itself counted as a file to publish, so preparing twice gives the same sums.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { manifestProblem } from "./build-identity.mjs";

const IDENTITY = /^(.+)\.build\.json$/;
const BINDING = /^(.+)\.assets\.json$/;
const SUMS = "SHA256SUMS";

/** What each artifact publishes: one file of this kind, and nothing else. */
export const PUBLISHED = {
  server: { kind: "server archive", file: /^ownbase-server-[^/]+\.tar\.gz$/ },
  desktop: { kind: "Windows installer", file: /Setup[^/]*\.exe$/ },
  mac: { kind: "Mac disk image", file: /^OwnBase-[^/]+-universal\.dmg$/ },
};
/** Hex SHA-256 of a file. */
export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** What is wrong with one artifact's identity for this release, or null. */
export function identityProblem(name, identity, { revision, version }) {
  if (identity.revision !== revision)
    return `${name} was built from ${String(identity.revision).slice(0, 12)}, not ${revision.slice(0, 12)}`;
  if (identity.dirty !== false)
    return identity.dirty === null
      ? `${name} was built where git could not say whether its source had changed`
      : `${name} was built from source with uncommitted changes`;
  if (identity.version !== version)
    return `${name} is version ${identity.version}, but the tag names ${version}`;
  return null;
}

/** `v1.2.3` or `v1.2.3-rc.1` → `1.2.3`; null for a tag naming no version. */
export function tagVersion(tag) {
  return /^v(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(tag)?.[1] ?? null;
}

/** One file out of a `.tar.gz`, as `tar -czf … -C dir .` writes it, or null. */
export function readTarGzFile(archive, name) {
  const tar = gunzipSync(readFileSync(archive));
  const text = (at, length) => {
    const raw = tar.subarray(at, at + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end === -1 ? length : end).toString("utf8");
  };
  for (let at = 0; at + 512 <= tar.length;) {
    const path = text(at + 345, 155) ? `${text(at + 345, 155)}/${text(at, 100)}` : text(at, 100);
    if (!path) break;
    const size = parseInt(text(at + 124, 12).trim() || "0", 8);
    if (path.replace(/^\.\//, "") === name) return tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** The files a binding names, with their SHA-256, or a problem with it. */
function readBinding(name, value) {
  const files = value?.files;
  if (!files || typeof files !== "object" || Array.isArray(files))
    return { problem: `${name}.assets.json lists no files` };
  for (const [file, hash] of Object.entries(files))
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash) || basename(file) !== file)
      return { problem: `${name}.assets.json names ${file} without a SHA-256` };
  return { files };
}

/**
 * Checks `dir` and returns the checksum file's text and the release notes.
 * Throws with every problem at once. `notes` is the notes file's name when it
 * is kept in `dir`: an earlier run's notes are output, never input.
 */
export function prepareRelease({ dir, revision, tag, signed = false, notes: notesName = null }) {
  const version = tagVersion(tag);
  const problems = [];
  if (!version) problems.push(`tag ${tag} names no version (expected v1.2.3 or v1.2.3-rc.1)`);
  if (!/^[0-9a-f]{40}$/.test(revision)) problems.push(`revision ${revision} is not a commit`);

  const identities = [];
  const bindings = new Map();
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === SUMS || entry === notesName || !statSync(join(dir, entry)).isFile()) continue;
    const identity = IDENTITY.exec(entry);
    const binding = BINDING.exec(entry);
    let parsed;
    if (identity || binding) {
      try {
        parsed = JSON.parse(readFileSync(join(dir, entry), "utf8"));
      } catch {
        problems.push(`${entry} is not readable JSON`);
        continue;
      }
    }
    if (identity) {
      const shape = manifestProblem(parsed);
      if (shape) problems.push(`${entry} ${shape}`);
      else identities.push([identity[1], parsed]);
    } else if (binding) {
      const read = readBinding(binding[1], parsed);
      if (read.problem) problems.push(read.problem);
      else bindings.set(binding[1], read.files);
    } else files.push(entry);
  }
  if (identities.length === 0) problems.push("no artifact identity (<artifact>.build.json) found");
  if (files.length === 0) problems.push("nothing to publish");
  if (version)
    for (const [name, identity] of identities) {
      const problem = identityProblem(name, identity, { revision, version });
      if (problem) problems.push(problem);
    }

  // Each file published is one a tested build staged, unchanged since.
  const known = new Map(identities);
  const boundTo = new Map();
  for (const [name, published] of Object.entries(PUBLISHED)) {
    const staged = bindings.get(name);
    if (!staged) {
      problems.push(`no ${published.kind} was staged (${name}.assets.json)`);
      continue;
    }
    if (!known.has(name)) problems.push(`${name}.assets.json has no ${name}.build.json beside it`);
    const names = Object.keys(staged);
    if (names.length !== 1 || !published.file.test(names[0]))
      problems.push(
        `${name} must stage exactly one ${published.kind}, not ${names.join(", ") || "none"}`,
      );
    for (const file of names) boundTo.set(file, [name, staged[file]]);
  }
  for (const name of bindings.keys())
    if (!PUBLISHED[name]) problems.push(`${name}.assets.json stages files no release publishes`);
  for (const file of files) {
    const bound = boundTo.get(file);
    if (!bound) problems.push(`${file} was not staged by a tested build`);
    else if (sha256(join(dir, file)) !== bound[1])
      problems.push(`${file} is not the file ${bound[0]} staged: its SHA-256 differs`);
  }
  for (const [file, [name]] of boundTo)
    if (!files.includes(file)) problems.push(`${file}, staged by ${name}, is missing`);
  // The server archive carries its own identity; it must be the one tested.
  const server = known.get("server");
  for (const [file, [name]] of boundTo) {
    if (name !== "server" || !server || !files.includes(file)) continue;
    let carried = null;
    try {
      carried = JSON.parse(
        readTarGzFile(join(dir, file), "build.json")?.toString("utf8") ?? "null",
      );
    } catch {
      // Reported below.
    }
    if (carried?.revision !== server.revision || carried?.inputs !== server.inputs)
      problems.push(`${file} does not carry the server identity it was staged with`);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));

  const sums = files.map((file) => `${sha256(join(dir, file))}  ${file}`).join("\n") + "\n";
  const notes = [
    `Built and tested from ${revision}.`,
    "",
    "| Artifact | Version | Revision | Source inputs |",
    "| --- | --- | --- | --- |",
    ...identities.map(
      ([name, identity]) =>
        `| ${name} | ${identity.version} | \`${identity.revision.slice(0, 12)}\` | \`${identity.inputs}\` |`,
    ),
    "",
    "Diagnostics in the app, and `/api/server-info` on a server, report the same revision.",
    "",
    signed
      ? "The Windows installer is code-signed."
      : "The Windows installer is not code-signed, so Windows SmartScreen may warn before it runs; check its SHA-256 against `SHA256SUMS` first.",
    "",
    "The Mac app is signed ad hoc, not with an Apple Developer ID, and is not notarized. The first time it opens, macOS stops it; allow it under System Settings → Privacy & Security → Open Anyway.",
    "",
    "SHA-256:",
    "",
    "```",
    sums.trimEnd(),
    "```",
    "",
  ].join("\n");
  return { sums, notes, files };
}

/** Records the files a job staged for `artifact`, with their SHA-256, in `dir`. */
export function bindAssets(dir, artifact, paths) {
  const files = Object.fromEntries(paths.map((path) => [basename(path), sha256(path)]));
  writeFileSync(join(dir, `${artifact}.assets.json`), JSON.stringify({ files }, null, 2) + "\n");
  return files;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv[2] === "bind") {
  const [, dir, artifact, ...paths] = process.argv.slice(2);
  if (!dir || !artifact || paths.length === 0) {
    console.error("usage: release-manifest.mjs bind <dir> <artifact> <file>...");
    process.exit(2);
  }
  console.log(
    JSON.stringify(
      bindAssets(
        resolve(dir),
        artifact,
        paths.map((p) => resolve(p)),
      ),
    ),
  );
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir, ...rest] = process.argv.slice(2);
  const option = (name) => {
    const at = rest.indexOf(`--${name}`);
    return at === -1 ? undefined : rest[at + 1];
  };
  const revision = option("revision");
  const tag = option("tag");
  const notesPath = option("notes");
  if (!dir || !revision || !tag || !notesPath) {
    console.error(
      "usage: release-manifest.mjs <dir> --revision <sha> --tag <tag> --notes <file> [--signed]",
    );
    process.exit(2);
  }
  try {
    const { sums, notes } = prepareRelease({
      dir: resolve(dir),
      revision,
      tag,
      signed: rest.includes("--signed"),
      notes: dirname(resolve(notesPath)) === resolve(dir) ? basename(notesPath) : null,
    });
    writeFileSync(join(resolve(dir), SUMS), sums);
    writeFileSync(resolve(notesPath), notes);
    process.stdout.write(sums);
  } catch (error) {
    console.error(`Not releasing:\n${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
