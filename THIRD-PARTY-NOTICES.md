# Third-party notices

OwnBase is released under the MIT License (see [LICENSE](LICENSE)). It also
contains material from the projects below, each under its own license.

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

The emoji picker's section marks in `packages/ui/src/components/EmojiPicker.tsx`
for Animals & Nature, Food & Drink, Activity, Travel & Places and Symbols are
Its Hover's `paw-print`, `coffee`, `trophy`, `airplane` and `heart` drawings,
without their motion.

## Lucide

- Project: <https://github.com/lucide-icons/lucide>
- License: ISC

The emoji picker's marks for Objects and Flags are Lucide's `lightbulb` and
`flag` drawings.

> Copyright (c) 2026 Lucide Icons and Contributors
>
> Permission to use, copy, modify, and/or distribute this software for any
> purpose with or without fee is hereby granted, provided that the above
> copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
> REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
> AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
> INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
> LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
> OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
> PERFORMANCE OF THIS SOFTWARE.

## Noto Color Emoji

- Project: <https://github.com/googlefonts/noto-emoji>, through
  `@fontsource/noto-color-emoji`
- License: SIL Open Font License 1.1, in
  [`packages/ui/fonts/OFL.txt`](packages/ui/fonts/OFL.txt) beside the
  font

`packages/ui/fonts/noto-color-emoji.woff2` is the font with its SVG table
removed, which held a second copy of every glyph; the COLRv1 glyphs it keeps
are unchanged. `scripts/generate-emoji.mjs` makes it.

## emoji-mart data

- Project: <https://github.com/missive/emoji-mart>, as `@emoji-mart/data`
- License: MIT

`packages/ui/src/lib/emojiData.json` is written from its emoji list: each
emoji's shortcodes, name, keywords and skin tones, with the flags reordered.

> Copyright (c) Missive.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to
> deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
> sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
