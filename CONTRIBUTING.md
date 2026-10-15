# Contributing

Develop each improvement on a branch and open a pull request against `main`.
Describe the user-visible change, validation performed, and any remaining limits.
Review the complete diff, resolve known issues within the PR's scope, and wait for
the applicable GitHub checks before merging. Keep unrelated follow-up work in
separate PRs rather than expanding a finished change indefinitely. After merging,
start the next branch from the updated `main`.

CI runs on pull requests, once for the code it checks. The account has 2,000
free Actions minutes a month and no budget beyond them, and in September 2026
checks used them up: every merge ran the whole suite again on `main`, and the
packaged Windows app, whose minutes count twice, ran on every pull request. So:

- `ci.yml` (Linux: formatting, types, unit and browser tests, both bundle
  checks) runs on every pull request that changes more than documentation. It
  does not run again on `main` after a merge. A pull request's run checks the
  result of merging it, so rebase a branch and let it run again if `main` has
  moved since.
- `desktop.yml` (the packaged Windows app) runs when a pull request changes the
  desktop app, the server, client or protocol, the screens its suite drives, or
  the lockfile. For anything else the packaged app shows, run it locally
  (below) or start it by hand: `gh workflow run desktop.yml --ref <branch>`.
- `container.yml` (the Docker image) runs when the server, the image's files or
  the lockfile change.
- `caches.yml` runs on `main` only when the lockfile changes. It refills the
  pnpm store and Chromium caches that pull requests restore, since a pull
  request can only use caches made on `main`.
- A pull request that changes only documentation starts nothing. Run
  `pnpm format` and `pnpm exec prettier --check .` before pushing it.

Push a branch when it is ready rather than after every commit: each push starts
a run, and a newer run for the same pull request cancels the older one only
after it has already been billed for a minute. If new tests are explicitly
deferred for a development phase, record that limit in the PR. Keep existing CI
checks enabled and distinguish passing existing tests from coverage of the new
behavior.

Do not upload build output as a CI artifact on every run. The account has
half a gigabyte of Actions storage, and GitHub keeps artifacts for ninety days
unless told otherwise, so one packaged desktop installer per push fills the whole
allowance in about five runs — this happened, and fifty-six copies of a 107 MB
installer had to be deleted by hand. Packaging is verified by building and then
launching the result; keeping the file afterwards is a separate decision that
belongs in a release workflow, on a tag, where somebody actually wants to
download it. If an artifact genuinely helps diagnose a failure, upload it under
`if: failure()` and set a short `retention-days`.

Releases come from `.github/workflows/release.yml`, on a `v1.2.3` tag or a
manual run naming the tag. It builds the server and the Windows installer from
that one commit and runs the unit, browser and desktop suites on them. On
Windows it also installs the installer silently, starts the app, checks it
registers `tandem://` and `slackoss://`, upgrades from the previous published
release if there is one, and checks uninstalling keeps the person's data. The
installed app is asked which data folder it is using
(`TANDEM_RELEASE_GATE_REPORT`), so an upgrade passes only when the new version
runs in the previous release's folder and reads what that release left there.
Each job lists the files it built and tested, with their SHA-256
(`release-manifest.mjs bind`), and `scripts/release-manifest.mjs` then refuses
any file not built from that commit, built from changed source, not listed, or
changed since, and writes `SHA256SUMS` and notes naming the revision. The result is a draft release; publishing it is a person's decision.
Its files are release assets, so the clean-up below never touches them. The
`release-*` artifacts that carry them between jobs are deleted by the release
run itself. A pull request that changes the release workflow or its scripts
runs every step except publishing.

CI also deletes what it leaves behind. GitHub counts storage for every hour an
artifact exists, and deleting one later does not give those hours back. So the
browser report a failing run uploads expires after a day, and the next run
deletes it sooner, along with anything else earlier runs left. A separate
`clean-up` job does the deleting, because it is the only job whose token may
delete. It starts only when there is something to delete, since every job that
starts counts as at least a minute of CI time.

The browser and desktop suites run against built output rather than the sources:
`tests/e2e/web.spec.ts` spawns `apps/server-cli/dist/`, and the desktop spec
launches the packaged app. Each build writes a `build.json` naming the source it
was built from, and both suites check it before they start: run against a build
older than your checkout, they stop and name the command that rebuilds it,
rather than quietly passing against the previous build (`node
scripts/build-identity.mjs check web server desktop` asks the same). Each scenario
in `web.spec.ts` gets a workspace of its own, a server on a free port with
fresh data, with Alice (the owner) and Bobby already registered; one tagged
`@unowned` starts with nobody. So a scenario runs the same alone (`pnpm
test:e2e tests/e2e/web.spec.ts:<line>`), in any order, and after another fails.

Requests are rationed by default, keyed on the account where there is one. A
test or script that seeds history by posting hundreds of messages in a loop is
indistinguishable from the flooding those limits exist to refuse, so start its
server with `rateLimits: false` (or `--no-rate-limits` for the CLI, or
`TANDEM_RATE_LIMITS=off` for a container) rather than raising the limits for
everybody. Rationing has its own suite, where it is the subject rather than a
background condition every other case has to work around.

Pull requests are scanned for secrets, and the scan reads every commit in the PR,
not only the final diff. A made-up key in a test that looks random — a hex string,
a long base64 value, anything shaped like `xoxb-` followed by noise — is reported
as a leaked credential and fails the check, and a later commit that changes it
does not clear it, because the earlier commit still contains it. Clearing it means
rewriting the branch. Give test keys obviously fake, low-entropy values such as
`"test-signing-secret-not-a-credential"`, or generate them at runtime, so the scan
never has anything to find.

Use Node 24+ and pnpm 10.23.0 (`corepack enable`). Install with
`pnpm install --frozen-lockfile`, then run `pnpm format`, `pnpm build`,
`pnpm typecheck`, `pnpm typecheck:automation` (the browser and desktop tests,
their configs and `scripts/`), and `pnpm test` before submitting a pull
request. CI checks
formatting, so an unformatted file fails the build rather than starting an
argument in review.

Browser checks: `pnpm exec playwright install chromium`, then `pnpm test:e2e`
after building. Windows checks: `pnpm build:win`,
then `pnpm test:desktop`. These tests use temporary workspaces and fake media.

The script every visit to the client downloads has a 700 kB budget. After
building, `node scripts/check-web-bundle.mjs` measures the browser client and
`node scripts/check-web-bundle.mjs apps/desktop/out/renderer` the desktop
renderer; CI runs both on Linux. A workspace package that others import declares
`"sideEffects": false`, or the bundler keeps every module in it, used or not.
A view opened now and then loads with `lazy()` inside `LazyPanel` or
`LazyDialog`, which say what is loading and offer a way out if it fails, and a
large library needed on one rare path loads with `import()` on that path.

A browser test that passes on Windows can still fail on Linux CI, where fonts
and line breaks differ. Moving the pointer onto a message raises its toolbar over
the top right of that message, so a click aimed at the middle of something long
in its first line, a link for instance, can land on the toolbar and time out
after retrying. Start the message with what is being clicked and click near its
start, or focus it and press Enter. After a message arrives, wait for
`toBeInViewport({ ratio: 1 })` before clicking in it: the default passes while
the row is still partly behind the composer.

Browsers offer some APIs only to secure pages: https, and this computer's own
`localhost` or `127.0.0.1`. The suites reach their servers on `127.0.0.1`, so
they cannot notice something that works there but not at
`http://192.168.1.20:8543`, which is how a workspace on a home or office network
is opened. The clipboard is one: `navigator.clipboard` is simply missing on such a
page, and every copy button failed for people on a LAN until PR #53. When a
feature uses one of these APIs, also test the page without it, as the invite
journey does by removing `writeText`.

A renamed setting has to fall back to its previous name everywhere it is passed
along, not only where the code reads it. The Compose file once passed
`TANDEM_ICE_SERVERS` with a default beside `SLACKOSS_ICE_SERVERS`, and that
default hid a value still set under the old name.

`pnpm test` runs every package at once, and the server tests allow five seconds
each. On a busy machine, one still packaging the desktop app for instance, a
handful of unrelated server tests can time out together. Rerun that package on
its own before chasing them; a real failure fails there too.

UI component checks belong in `packages/ui/test/*.dom.test.tsx`. They run with
jsdom, Testing Library, explicit cleanup, and the shared accessibility helper.
Other UI tests keep the Node environment, including static rendering tests.
The DOM setup approximates visible element boxes for focus checks; it cannot
test layout, colour contrast, or screen-reader output. Use the browser suite
for real geometry and check assistive technology separately.

Two things about the desktop suite are easy to trip over. A terminal inside an
Electron-based tool can export `ELECTRON_RUN_AS_NODE=1`, which makes any Electron
app it starts run as plain Node; the packaged app then refuses to launch with
"bad option: --remote-debugging-port". The desktop spec removes it, and anything
else that launches the app needs to as well. And the app asks before it quits
while hosting, in a native dialog no test can answer, so a desktop test that stops
part-way through with a workspace hosted must not end the app by quitting it: the
dialog opens on the screen of whoever ran the test and the run hangs until it
times out. The spec kills the app's process tree on failure instead. On Windows
that has to be the whole tree: Playwright starts the app through `cmd.exe`, the
process it hands back is that shell, and killing it leaves the app running.

Docker checks: `docker build -f docker/Dockerfile -t slackoss:local .`, then
`node tests/docker-smoke.mjs`. The smoke test starts an isolated container,
tests restart persistence and 6,000 socket deliveries, and removes its test data.
The image fetches its dependencies from the lockfile alone, before copying the
source, so a rebuild after a source edit reuses that work; `node
tests/docker-reuse.mjs` (needs `docker buildx`) checks that a source edit
reuses it and a lockfile edit does not, putting both files back afterwards.

Keep protocol changes compatible with existing clients where practical. Add a
new SQLite migration instead of modifying one already shipped. Test access
control with a member who should not see the affected resource. For performance
changes, include the workload, hardware, and measurement; do not claim universal
latency or memory guarantees from a local test.

This project uses the MIT license, matching the existing server package license.
Contributions are accepted under that license. SlackOSS is an independent project,
not affiliated with Slack or Salesforce.
