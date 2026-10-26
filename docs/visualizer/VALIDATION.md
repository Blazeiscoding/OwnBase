# Atlas validation

These checks validate the project atlas. Creating the atlas changes
documentation, generation/preview tools and root commands; it does not change application runtime source.

## Generator and embedded source

Six focused Node checks pass:

- Every tracked input except the generated page is indexed, with unrelated
  audit directories, ignored dependencies and build outputs excluded.
- Every embedded text file equals its complete current source, with normalized
  LF line endings. Sizes and SHA-256 values match actual file bytes. Binary
  assets retain metadata.
- Counts, declaration positions, import links, reverse references and the
  aggregate digest agree. All 176 app/package runtime files have reviewed
  explanations; all guide, flow and improvement file/evidence paths exist.
- Workspace subpath exports and literal dynamic imports resolve to their actual
  repository modules.
- The HTML contains one JSON snapshot and one executable atlas script. Source
  dollar tokens, template markers and closing-script text remain safely embedded
  and byte-correct; application source is never executed by the reader.
- A disposable Git fixture accepts identical source after capture metadata and
  HEAD/tracked status change, rejects changed source, and leaves stale output
  untouched. It does not mutate the real repository's HEAD or output.

`pnpm visualizer:check` passes against the final inputs. Node syntax checks,
Prettier on the changed supported files and `git diff --check` pass.

## Browser checks, 6 October 2026

The redesigned page was driven with Playwright in Chromium, from the file itself
with no server, at 1440 × 900 and at 390 × 844 as a touch phone, in both themes.

- axe-core reports no violations on Overview, Files (tree, explanation, source,
  declarations, connections), How it works, an expanded improvement and Scope &
  limits, in Onyx and in White. That includes colour contrast for text, chart
  labels and syntax colours.
- Search typed into the search dialog or the tree filter as HTML creates no
  elements and runs nothing.
- The search dialog opens with Ctrl K and closes with Escape. Arrow keys move
  through the tree and open folders.
- A line number puts that line's address in the URL and on the clipboard; go to
  line, find in file, Back to the previous tab and a file's link to its journey
  step all land where they say.
- The measured filter shows 12 records and the open filter 13. The Contract layer
  link lists its 14 files.
- The theme choice survives a reload.
- The page makes no network requests and logs no errors.
- No view is wider than a 390-pixel screen.

A screen reader and printed output were not tried.

## Browser checks, 12 October 2026

The atlas was redesigned again: OwnBase's graphite theme, a wired map of every
file on Overview, journeys drawn small, and a board on Improvements. The same
Playwright setup checked it, from the file, at 1440 × 900 and at 390 × 844 as a
touch phone, in both themes.

- axe-core reports no violations on Overview, Files (tree, explanation, source,
  declarations, connections), How it works, an expanded improvement,
  Improvements and Scope & limits, in Onyx and White, at both sizes. On the
  phone it had found three problems that were already on the main branch: the
  search button had no name once its label was hidden, the closed navigation
  drawer kept its links in the Tab order, and the file tree had no top-level
  heading. All three are fixed.
- The map draws all ten wires, and their labels stay inside it. Pointing at a
  card lights its own wires and dims the rest; pointing at a dot names its file,
  and clicking it opens that file.
- On Improvements, the Measured filter shows 12 records and the Open filter 13.
  Filtering dims what the list hides on the board, and a bar on the board opens
  its record.
- Ctrl K opens search and Escape closes it; HTML typed into it creates no
  elements. The Contract layer link lists its 14 files. The theme choice
  survives a reload. The skip link moves focus into the page without leaving
  the view.
- No view is wider than a 390-pixel screen, the page makes no network requests
  and it logs no errors.
- The colours of the board's three statuses were run through a colour-vision
  check. The measured and implemented colours are too close for red-green
  colour blindness, so the board also tells them apart by shape: a ring is
  open, a target is measured, a solid dot is implemented.

## Plain words, 12 October 2026

The text people read first was rewritten for readers who do not write code:
the overview, the part names on the map, the 15 journeys, the 50 improvement
records, the limits, the glossary and every label. Each of the 264 explained
files also got one plain sentence, shown first on its page and in the map's
tooltip. The technical wording was kept and moved under "In the code".

- A script checked every rewritten field against the original it replaces:
  same records, same number of steps, measurements and limits, and none of a
  list of jargon words, code names, dashes or parentheses. All of it passes.
- Each improvement keeps its original title, summary, before, after and limits
  in `technical`; each journey, step, measurement and guide limit keeps its
  original in `detail`. Searching for an original title still finds the record.
- axe-core reports no violations on every view, in both themes, at both sizes,
  with every "In the code" section open.
- A link to a journey step opens that step's "In the code", and only that one.
  A record's "In the code" starts closed.
- Plain text was spot-checked against the original for the hosting and
  building journeys and for several records. One sentence that misread a
  cross-reference was corrected. Nobody without a coding background has read
  it yet.
