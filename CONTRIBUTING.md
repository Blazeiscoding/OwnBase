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

The project atlas, `docs/PROJECT-VISUALIZER.html`, explains every runtime file
and embeds the text of every tracked one. A new file under `apps/*/src` or
`packages/*/src` needs an entry in `docs/visualizer/content/*.json`, or
`pnpm visualizer:build` stops and names it. Run `pnpm visualizer:build` after a
change so the atlas matches it; `pnpm visualizer:check` says whether it does.
The [atlas guide](docs/visualizer/README.md) has the rest.

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

A view in the client opens in one of three places, chosen by what it is for:

- A side panel holds what someone reads beside the conversation: a thread, the
  members, pinned messages, Activity, Threads, Saved, Scheduled, Direct
  messages and search results. One is open at a time. It loads in `LazyPanel`
  and takes focus and hands it back with `usePanelFocus`. Below 1024 px wide it
  covers the conversation, and what it covers goes inert. On a phone it stops
  above the bottom bar, whose height the workspace keeps free.
- A dialog is a short task with an end, such as creating a channel, starting a
  message, inviting people or answering a confirmation. `Dialog` owns its
  focus, Escape and the inert page behind it, and it loads in `LazyDialog`.
- A full page is for settings someone sets up and comes back to: preferences,
  workspace settings and hosting. Account settings shows how: a `Modal` that
  fills the window below the desktop title bar, its sections and a search on
  one side, the open section scrolling on the other, and choices that save
  themselves saying "Saved" through `useSaved`.

A few actions on one control are a `Menu`, which is a sheet on a touch phone and
a dropdown elsewhere. A small form on one control, like Send later, is a
`Popover`. Tabs inside any of these use `useTabs`. A panel or dialog worth
coming back to has an address in `packages/ui/src/lib/route.ts`, so Back,
Forward and a copied link reach it. Forms, pickers and search get none.

Some views break the rule today, so follow the rule rather than them. Manage
hosting is a dialog with four tabs, and there is no Workspace settings yet.
Search results and Friends are lists, and both open as dialogs.

New interface code is built from the shared parts in
`packages/ui/src/components` rather than from restyled native elements:
`Button`, `IconButton` for a button that shows only an icon, `TextField` for a
field with its label, hint and error, and `Kbd` for a key, beside `Modal`,
`Menu`, `Popover`, `Tooltip`, `Toast` and `ListStatus`. A field drawn by hand
takes its classes from `inputClass` in `TextField.tsx`. Move older code over
when you touch it, not in one sweep. The gallery shows each part in its states
in Onyx and in White, and is what a review compares against: run
`pnpm --filter @slackoss/web dev` and open `http://localhost:5173/#/gallery`,
or `#/gallery/onyx` or `#/gallery/white` for one theme. Only the development
server has it; a build leaves it out.

Check a change to the interface against this list before asking for review. The
pull request template repeats it in short.

- It works from the keyboard alone, in a sensible Tab order. Escape closes the
  top layer and focus goes back to what opened it. `Dialog`, `Menu`, `Popover`
  and `usePanelFocus` already do both, so build on them. An icon-only button
  is an `IconButton`, whose label is both its name and its tooltip.
- Focus is visible on everything that takes it. `theme.css` draws the ring on
  buttons, links and `tabindex="0"`, and fields show focus in their border.
  Anything else draws its own, as the New channel cards do with
  `has-[:focus-visible]`.
- It reads well in Onyx and in White, and axe in a real browser finds nothing in
  either. The DOM tests' `accessibilityProblems` leaves out colour contrast,
  because jsdom cannot judge it.
- It works 390 px wide and in 844 by 390 landscape, with nothing to tap smaller
  than 24 px, which axe's `target-size` rule checks. Whatever appears on hover
  also appears on focus. A touch screen has no hover, so there it is always
  shown or offered in a menu.
- A view says when it is empty, loading or failed. A list says it through
  `ListStatus`: rows shaped like what is coming, what failed with Retry, and for
  an empty list what fills it. A long list reads more with `LoadMore`, not
  Previous and Next.
- No submit button is disabled until the form is filled in. The form checks on
  submit, says what is missing next to the field, and moves focus to the first
  field with a problem; a refusal about one field is said under that field. Sent
  with nothing changed, a form says there is nothing to save, a small edit in
  place just closes, and a setting whose saving does something, such as the call
  relay, saves again. A button may wait while its request runs, marked with
  `aria-disabled` rather than `disabled` so focus stays on it, and Send stays off
  while a message is empty, as Save does when editing one.
- No Refresh button sits on data the socket already delivers. Such a list
  updates itself while it is open, and `PagedList` reads it again in place.
  Retry is only for a load that failed.
- A view opened now and then loads on first use, inside `LazyPanel` or
  `LazyDialog`, so the entry stays within the budget above.

Three buttons still wait for something to be typed or chosen: Connect on the
join screen, for an address; Schedule in Send later, for a time; and Transfer
ownership, for the owner's username. Fix one when you touch it.

To look at a change, start a throwaway workspace that serves the web build, on
this computer only, and fill it with the demo:

```sh
pnpm build
node apps/server-cli/dist/slackoss-server.js --data <empty folder> --port 18600 --host 127.0.0.1 --no-mdns --web apps/web/dist
node scripts/seed-demo.mjs http://127.0.0.1:18600
```

The server reads `apps/web/dist` from disk, so after
`pnpm --filter @slackoss/web build` a reload shows the change. Drive it with
Playwright for screenshots and axe. A context needs `isMobile: true` and
`hasTouch: true` before `(hover: none)` matches; a phone-sized window alone
keeps hover. Injecting axe needs `bypassCSP: true`, because the server's content
security policy allows only its own scripts. Headless Chromium prefers light, so
pass `colorScheme: "dark"` to see Onyx.

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
