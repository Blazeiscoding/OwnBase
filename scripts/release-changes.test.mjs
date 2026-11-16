import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mergedPullRequests, previousTag, pullRequestsBetween } from "./release-changes.mjs";

test("reads pull request numbers from merge commits' subjects", () => {
  const subjects = [
    "Merge pull request #501 from Blazeiscoding/fix/site-downloads-from-r2",
    "Merge remote-tracking branch 'origin/main' into refactor/untangle-r1-ui-infra",
    "Merge pull request #503 from Blazeiscoding/feat/site-demo-video",
    "",
  ].join("\n");
  assert.deepEqual(mergedPullRequests(subjects), [501, 503]);
  assert.deepEqual(mergedPullRequests(""), []);
});

/** A repository whose main line has a release, two merged pull requests and a bot commit. */
function history() {
  const cwd = mkdtempSync(join(tmpdir(), "release-changes-"));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        ...args,
      ],
      { cwd, encoding: "utf8" },
    ).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "first");
  git("tag", "v0.1.0");
  for (const [number, branch] of [
    [5, "fix/one"],
    [6, "feat/two"],
  ]) {
    git("checkout", "-q", "-b", branch);
    git("commit", "-q", "--allow-empty", "-m", `work on ${branch}`);
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", branch, "-m", `Merge pull request #${number} from x/${branch}`);
    git("commit", "-q", "--allow-empty", "-m", "docs(atlas): rebuild [skip ci]");
  }
  return { cwd, git, head: git("rev-parse", "HEAD") };
}

test("finds the release before and the pull requests merged since", () => {
  const { cwd, head } = history();
  try {
    const from = previousTag({ cwd, revision: head, tag: "v0.2.0" });
    assert.equal(from, "v0.1.0");
    assert.deepEqual(pullRequestsBetween({ cwd, from, to: head }), [5, 6]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a rerun whose own tag is already on the commit still finds the release before", () => {
  const { cwd, git, head } = history();
  try {
    git("tag", "v0.2.0");
    assert.equal(previousTag({ cwd, revision: head, tag: "v0.2.0" }), "v0.1.0");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
