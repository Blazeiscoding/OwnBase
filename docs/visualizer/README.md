# Tandem project atlas

Open [PROJECT-VISUALIZER.html](../PROJECT-VISUALIZER.html) in a browser. It is one
offline HTML file containing the inventory, reviewed runtime explanations,
complete text source, declaration/import indexes, guided flows and improvement
evidence. No server, CDN, login or application data is needed.

For a browser preview through a local server:

```sh
pnpm visualizer:build
pnpm visualizer:serve
```

Open `http://127.0.0.1:4178`. `VISUALIZER_PORT` changes the loopback port. The server
serves only the generated page and does not expose arbitrary repository files.

Press `/` or `Ctrl K` anywhere to search file names, declarations, journeys and
changes together.

- **Overview** is a map of the code. Each area is a card and each file is a dot
  in its card: a solid dot is source, a ring is a test and a faint dot is
  configuration, docs or an asset. A wire with a number counts the files in one
  area that import another, tests left out; a dotted wire is a connection made
  at runtime, such as the client reaching the server over HTTP and WebSocket.
  Point at a card to light its wires, or at a dot to name its file, and click
  either to open it. Below the map, each layer's share of the code and the
  areas in it, then every journey drawn small by the layers it passes through.
- **Files** is a folder tree beside a reader. Filter the tree by name, kind or
  layer, or tick **Search inside files too** to match source text. A file opens on
  one plain sentence about what it does, then its technical explanation; **Source** shows the whole file with find, go to line, line
  wrapping and an outline, **Declarations** lists what it defines and its named
  tests, and **Connections** draws what it imports and what imports it. Click a
  line number to copy a link to that line. Arrow keys move through the tree.
- **How it works** follows one everyday action, such as sending a message,
  step by step. Its map shows which part of Tandem works in each step, and
  each step's **In the code** opens the technical version and its files.
- **Improvements** opens on a board: every record as a dot in a row for its
  category, which layers the open findings reach into, and how much each
  measured change took away. Below it the records are grouped as open, measured
  and implemented, each with its before and after, mechanism, measurements,
  files and limits. Filtering the list dims what it hides on the board.
- **Scope & limits** says what the atlas can and cannot show.

Every view, file, tab and line has its own address, so Back, Forward and copied
links work. The page follows the device's light or dark setting; the button in
the top bar picks Onyx, White or the device setting and remembers the choice.
Beside the file tree and the journey list the navigation folds to icons. On a
phone it moves into a menu and the file tree and reader take turns.

## Maintaining the atlas

The generator reads `git ls-files` plus its explicitly owned atlas inputs. It
never scans ignored builds, dependencies, user data or unrelated untracked
directories. The generated output excludes itself to avoid recursive embedding.
Binary files retain size/hash metadata; text files are embedded in full.

The reviewed runtime narratives live in `content/client.json`, `server.json` and
`desktop.json`. `content/optimizations.json` records before/after behavior,
mechanisms, evidence and limits. `content/guide.json` provides the architecture,
reading guide and scope. Update these alongside a changed runtime file. Keep
unimplemented findings marked `follow-up`; do not turn a plan or diagnostic into
a completed optimization.

The pages people read first are written for someone who does not write code.
Journey titles, summaries and steps, improvement titles, summaries, before and
after, measurement labels and limits, and the guide's text use plain words: no
code names, and the part names the map uses (the screens, the app engine, the
shared rules, the server, the desktop app). The technical version is kept
beside each one and shown under **In the code**: a journey's and a step's
`detail`, an improvement's `technical` object, a measurement's `detail` and a
guide limit's `detail`. When the code changes, update both. Each explained file
also has a one-sentence `plain` description, shown first on its page and in the
map's tooltip; the generator writes one for files without an explanation. The
rest of a file's explanation stays technical, since that view is for reading
code.

```sh
pnpm exec prettier --write scripts/generate-project-visualizer.mjs scripts/serve-project-visualizer.mjs docs/visualizer
pnpm visualizer:build
pnpm visualizer:check
pnpm visualizer:test
```

The generator requires a reviewed entry for every `apps/*/src` and
`packages/*/src` runtime file, validates referenced paths and unique guide IDs,
and uses TypeScript's parser to extract declarations and literal imports.
Remaining file descriptions use structural metadata. Imports are a source
dependency map, not a dynamic call graph or proof of test execution.

`--check` compares the deterministic output to current inputs while preserving
the capture's base revision, date and tracked count, so committing the generated
file does not make identical inputs stale. The page shows the
checkout's base commit and an aggregate input SHA-256. It does not claim that
local modifications belong to the base commit. Runtime inputs are always the
actual current files, not an older commit's source. The page embeds source as
escaped JSON and renders text safely; it never executes embedded application
code. The generated HTML is intentionally excluded from Prettier because its
embedded source and data are deterministic generator output.

The page embeds the Latin subsets of Onest and Geist Mono from the web app's
installed `@fontsource-variable` packages, so it matches Tandem offline.
Run `pnpm install` first; the generator stops if they are missing. Layer colours
group the eleven areas into six layers so a colour can name one: the five hues
and the neutral were checked for colour-vision separation on both themes, and
every chart also labels its values.

The look follows the app's own theme (`packages/ui/src/theme.css`), and the
diagrams take after shots collected on [vibrant.design](https://vibrant.design):
the cards, ports and wires of the overview from the AI Node-Based Workflow
Canvas, a dot for every file from the dot-matrix map in Mintlify's Stats
Section, the thin share bars from the AI Model Router Dashboard, and the
Improvements board's panels from Modal's Bento Grid.

The [atlas validation record](VALIDATION.md) covers its generator and browser
interactions.
