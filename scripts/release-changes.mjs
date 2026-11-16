/**
 * Lists the pull requests a release brings, for the "What changed" section
 * that opens its notes (scripts/release-manifest.mjs, `--changes`): those
 * merged into main since the newest release before it.
 *
 *   node scripts/release-changes.mjs --revision <sha> --tag <tag> --out <file> [--repo <owner/name>]
 *
 * Needs the whole history and its tags (a checkout with fetch-depth: 0) and
 * gh with a token that may read pull requests. Writes
 * `{ previousTag, changes: [{ number, title }] }`, oldest merge first.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/**
 * The newest release tag that `revision` contains, other than `tag`: a failed
 * release is rerun whole, and by then its own tag may already sit on
 * `revision`.
 */
export function previousTag({ cwd = process.cwd(), revision, tag }) {
  return git(cwd, "describe", "--tags", "--abbrev=0", "--match", "v*", "--exclude", tag, revision);
}

/** Pull request numbers from merge commits' subjects, one per line. */
export function mergedPullRequests(subjects) {
  return subjects
    .split("\n")
    .map((line) => /^Merge pull request #(\d+) from /.exec(line)?.[1])
    .filter(Boolean)
    .map(Number);
}

/**
 * The pull requests merged into the first-parent line between two commits,
 * oldest first. Commits pushed straight to main, such as the Atlas
 * workflow's, are not merges and are left out.
 */
export function pullRequestsBetween({ cwd = process.cwd(), from, to }) {
  return mergedPullRequests(
    git(cwd, "log", "--merges", "--first-parent", "--reverse", "--format=%s", `${from}..${to}`),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
  };
  const revision = option("revision");
  const tag = option("tag");
  const out = option("out");
  const repo = option("repo") ?? process.env.GITHUB_REPOSITORY ?? "Blazeiscoding/OwnBase";
  if (!revision || !tag || !out) {
    console.error(
      "usage: release-changes.mjs --revision <sha> --tag <tag> --out <file> [--repo <owner/name>]",
    );
    process.exit(2);
  }
  const from = previousTag({ revision, tag });
  const changes = pullRequestsBetween({ from, to: revision }).map((number) => ({
    number,
    title: execFileSync(
      "gh",
      ["pr", "view", String(number), "--repo", repo, "--json", "title", "--jq", ".title"],
      { encoding: "utf8" },
    ).trim(),
  }));
  writeFileSync(resolve(out), JSON.stringify({ previousTag: from, changes }, null, 2) + "\n");
  console.log(`Since ${from}:`);
  for (const { number, title } of changes) console.log(`  #${number} ${title}`);
}
