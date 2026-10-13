# Third-party notices

Tandem is released under the MIT License (see [LICENSE](LICENSE)). It also
contains material adapted from the project below, which keeps its own license.

## Its Hover

- Project: <https://github.com/itshover/itshover> (<https://www.itshover.com>)
- License: Apache License 2.0, <https://www.apache.org/licenses/LICENSE-2.0>

Six icons in `packages/ui/src/components/Icon.tsx` (smile, reply, thread,
bookmark, edit and dots) and their hover motion in `packages/ui/src/theme.css`
are adapted from Its Hover's `meh`, `arrow-back-up`, `message-circle`,
`bookmark`, `pen` and `dots-vertical` icons.

What was changed: the drawings were redrawn as plain SVG paths on one 24-unit
grid with round joins, the level mouth of `meh` was turned up into a smile, and
the motion was rewritten as CSS keyframes and transitions, so that it needs no
animation library.
