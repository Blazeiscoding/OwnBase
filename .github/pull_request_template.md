## What changes

<!-- What someone using Tandem will notice, then what changed underneath. -->

## Checked

<!-- What you ran and what you looked at, and anything left for later. -->

- [ ] `pnpm exec prettier --check .` passes
- [ ] New runtime files have an atlas entry, and `pnpm visualizer:build` was run

If something on screen changes, check these too.
[CONTRIBUTING.md](https://github.com/Blazeiscoding/Tandem/blob/main/CONTRIBUTING.md) says how.

- [ ] It opens in the right place: a side panel to read beside the conversation, a dialog for a short task, a page for settings
- [ ] It works from the keyboard, Escape closes it, and focus goes back to what opened it
- [ ] Focus is visible on everything that takes it
- [ ] Looked at in Onyx and White, and axe in a real browser is clean in both
- [ ] It works 390 px wide and on a touch screen
- [ ] Empty, loading and failed states say what is going on
- [ ] No submit button is disabled until the form is filled in
- [ ] No Refresh button on data the socket keeps current
