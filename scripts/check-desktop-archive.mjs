#!/usr/bin/env node
/**
 * Refuses a desktop package that carries anything it must not (REV-12): a
 * workspace database or its log, attachments, build logs, environment files,
 * or a workspace package's own source, which the build has already bundled
 * into `out/`. Reads an `app.asar` (and its `.unpacked` folder) or an
 * unpacked app folder, prints what is in it, and exits 1 naming what is
 * forbidden.
 *
 *   node scripts/check-desktop-archive.mjs apps/desktop/release/win-unpacked/resources/app.asar
 *
 * The archive header is read here rather than through @electron/asar, so the
 * gate needs nothing but Node and runs on any machine.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** What must never ship, and why, tested against archive paths with `/` separators. */
export const FORBIDDEN = [
  {
    pattern: /(^|\/)node_modules\/@ownbase\//,
    why: "a workspace package collected as a dependency; its code is bundled into out/",
  },
  { pattern: /\.(db|sqlite3?)(-wal|-shm|-journal)?$/i, why: "a database or its log" },
  { pattern: /(^|\/)\.turbo(\/|$)/, why: "build tool cache and logs" },
  { pattern: /\.log$/i, why: "a log file" },
  { pattern: /(^|\/)data\/files\//, why: "workspace attachments" },
  { pattern: /(^|\/)pre-upgrade\//, why: "a workspace's pre-upgrade copy" },
  { pattern: /(^|\/)\.env(\.[^/]*)?$/, why: "an environment file" },
  {
    pattern: /(^|\/)node_modules\/.*\.[cm]?ts$/,
    why: "a dependency's TypeScript source or declarations, which nothing loads at runtime (F15)",
  },
];

/**
 * Lists the files in an asar archive: its header is a pickled JSON tree of
 * folders (`files`) and files (`size`, `offset`), after an 8-byte size prefix.
 */
export function listAsar(path) {
  const fd = openSync(path, "r");
  try {
    const prefix = Buffer.alloc(16);
    readSync(fd, prefix, 0, 16, 0);
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (headerSize < 8 || jsonSize > headerSize) throw new Error(`${path} is not an asar archive`);
    const json = Buffer.alloc(jsonSize);
    readSync(fd, json, 0, jsonSize, 16);
    const files = [];
    const walk = (node, at) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const path = at ? `${at}/${name}` : name;
        if (entry.files) walk(entry, path);
        else files.push({ path, size: Number(entry.size ?? 0), unpacked: !!entry.unpacked });
      }
    };
    walk(JSON.parse(json.toString("utf8")), "");
    return files;
  } finally {
    closeSync(fd);
  }
}

/** Lists the files under a folder, with `/` separators, relative to it. */
export function listFolder(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        files.push({
          path: relative(root, full).split(sep).join("/"),
          size: statSync(full).size,
          unpacked: false,
        });
    }
  };
  walk(root);
  return files;
}

/** Every forbidden file, with the reason it is forbidden. */
export function findForbidden(files) {
  const found = [];
  for (const file of files) {
    const rule = FORBIDDEN.find(({ pattern }) => pattern.test(file.path));
    if (rule) found.push({ ...file, why: rule.why });
  }
  return found;
}

/** Files and bytes, and the largest dependencies, so a change in size shows. */
export function inventory(files) {
  const packages = new Map();
  for (const file of files) {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file.path);
    if (match) packages.set(match[1], (packages.get(match[1]) ?? 0) + file.size);
  }
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    dependencies: packages.size,
    largest: [...packages].sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}

function main(target) {
  if (!target || !existsSync(target)) {
    console.error("Usage: node scripts/check-desktop-archive.mjs <app.asar | unpacked app folder>");
    return 2;
  }
  const files = statSync(target).isDirectory() ? listFolder(target) : listAsar(target);
  // Files kept outside the archive are listed in it as unpacked, and live beside it.
  const beside = `${target}.unpacked`;
  if (!statSync(target).isDirectory() && existsSync(beside))
    for (const file of listFolder(beside)) files.push({ ...file, unpacked: true });
  const summary = inventory(files);
  console.log(
    `${target}: ${summary.files} files, ${(summary.bytes / 1024 / 1024).toFixed(1)} MiB, ${summary.dependencies} dependencies`,
  );
  for (const [name, bytes] of summary.largest)
    console.log(`  ${name}: ${(bytes / 1024).toFixed(0)} KiB`);
  const forbidden = findForbidden(files);
  if (forbidden.length === 0) {
    console.log("Nothing forbidden.");
    return 0;
  }
  console.error(`${forbidden.length} forbidden file${forbidden.length === 1 ? "" : "s"}:`);
  for (const file of forbidden.slice(0, 50)) console.error(`  ${file.path}: ${file.why}`);
  if (forbidden.length > 50) console.error(`  …and ${forbidden.length - 50} more`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = main(process.argv[2]);
