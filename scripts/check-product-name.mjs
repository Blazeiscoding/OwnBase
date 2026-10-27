// Fails when one of the product's earlier names is still there (P2, P2b):
//
//   node scripts/check-product-name.mjs [dir ...]   built output, by default the browser client
//   node scripts/check-product-name.mjs --repo      every text file git tracks
//
// OwnBase was called SlackOSS, then Gatherline, then Tandem. Nobody runs a
// build from before, so nothing reads those names any more: not settings,
// links, storage keys, package names, or the GitHub repository's.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Names the product had before, in any case and inside longer names too. */
export const EARLIER_NAMES = /slackoss|gatherline|tandem/gi;
const TEXT = /\.(?:m?js|html|css|json|webmanifest|svg|txt)$/;
/**
 * Tracked files that name the earlier names on purpose: this check and its
 * test, and the atlas, which embeds them.
 */
const NAMES_THEM = new Set([
  "scripts/check-product-name.mjs",
  "scripts/check-product-name.test.mjs",
  "docs/PROJECT-VISUALIZER.html",
]);

/** Each earlier name in `text`, as `<where>:<line>: <around it>`. */
function namesIn(text, where) {
  const found = [];
  text.split("\n").forEach((line, i) => {
    for (const match of line.matchAll(EARLIER_NAMES)) {
      const at = match.index ?? 0;
      const around = line.slice(Math.max(0, at - 40), at + 40).trim();
      found.push(`${where}:${i + 1}: ${around}`);
    }
  });
  return found;
}

/** Every earlier name in `dir`'s text files. */
export function findEarlierNames(dir) {
  const found = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (TEXT.test(entry.name))
        found.push(
          ...namesIn(readFileSync(path, "utf8"), relative(dir, path).replaceAll("\\", "/")),
        );
    }
  };
  walk(dir);
  return found;
}

/** Every earlier name in the text files git tracks in `repo`, binary files aside. */
export function findEarlierNamesInRepo(repo) {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" })
    .split("\0")
    .filter((file) => file && !NAMES_THEM.has(file));
  const found = [];
  for (const file of files) {
    let body;
    try {
      body = readFileSync(join(repo, file));
    } catch {
      continue; // deleted, not yet staged
    }
    if (body.subarray(0, 8000).includes(0)) continue;
    found.push(...namesIn(body.toString("utf8"), file));
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const checks =
    args[0] === "--repo"
      ? [["the repository", findEarlierNamesInRepo(args[1] ?? ".")]]
      : (args.length ? args : ["apps/web/dist"]).map((dir) => [dir, findEarlierNames(dir)]);
  let failed = false;
  for (const [where, found] of checks) {
    if (found.length === 0) {
      console.log(`${where}: no earlier product name`);
      continue;
    }
    failed = true;
    console.error(`${where} still has an earlier product name:`);
    for (const line of found) console.error(`  ${line}`);
  }
  if (failed) process.exit(1);
}
