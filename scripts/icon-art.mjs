// The app icon: the cabin from the landing page's scene (apps/site/scene.js),
// whose orange window is your server, at dusk on its teal shore. It is drawn on
// a 32-pixel grid, and again by hand on 16 for sizes under 24, where 32 would
// blur: the tray and a browser tab.
//
// scripts/generate-palette.mjs writes the SVGs and BrandMark's pixels from
// here, and scripts/generate-icons.mjs draws the PNG and ICO icons.

const HOST = [249, 115, 22];
const HOST_HI = [255, 186, 112];
const MULLION = [180, 80, 20];
const STAR = [255, 238, 200];
const HILL = [29, 58, 72];
const PINE = [19, 42, 54];
const GROUND = [19, 40, 50];
const GRASS = [30, 59, 65];
const WALL = [44, 34, 58];
const PLANK = [36, 27, 48];
const ROOF = [24, 18, 36];
const RIDGE = [62, 46, 76];
const ANTENNA = [74, 60, 92];
const SMOKE = [150, 140, 170];
// The lower half of the hero's dusk sky.
const DUSK = [
  [48, 35, 94],
  [63, 42, 104],
  [85, 51, 116],
  [115, 62, 127],
  [151, 73, 127],
  [189, 90, 128],
  [223, 118, 127],
  [242, 154, 124],
];

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x, y) => BAYER[(y & 3) * 4 + (x & 3)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function canvas(size) {
  const cells = Array.from({ length: size * size }, () => null);
  const inside = (x, y) => x >= 0 && y >= 0 && x < size && y < size;
  const set = (x, y, c) => {
    if (inside(x, y)) cells[y * size + x] = c;
  };
  const blend = (x, y, c, a) => {
    if (inside(x, y) && cells[y * size + x]) cells[y * size + x] = mix(cells[y * size + x], c, a);
  };
  /** The sky down to `horizon`, in steps dithered into each other. */
  const sky = (horizon) => {
    for (let y = 0; y < horizon; y++) {
      for (let x = 0; x < size; x++) {
        const p = (y / horizon) * (DUSK.length - 1);
        const i = Math.floor(p);
        set(x, y, p - i > bayer(x, y) ? DUSK[i + 1] : DUSK[i]);
      }
    }
  };
  /** Cuts the corners off, a quarter circle of `r` pixels each. */
  const round = (r) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = Math.max(r - (x + 0.5), x + 0.5 - (size - r), 0);
        const dy = Math.max(r - (y + 0.5), y + 0.5 - (size - r), 0);
        if (Math.hypot(dx, dy) > r) cells[y * size + x] = null;
      }
    }
  };
  return { size, cells, set, blend, sky, round };
}

/**
 * The cabin on a `size` grid, its ground row at `gy` and its middle at `cx`, as
 * scene.js builds it, with the window lit and smoke leaving the chimney.
 */
function large(size, { cx, gy }) {
  const c = canvas(size);
  const { set, blend } = c;
  // The sky, the far shore with its pines, and the ground the cabin stands on.
  const horizon = gy - 4;
  c.sky(horizon);
  for (const [x, y] of [
    [cx - 11, 3],
    [cx - 6, 7],
    [cx + 12, 9],
    [cx - 13, 12],
  ])
    set(x, y, STAR);
  for (let y = horizon; y < size; y++) for (let x = 0; x < size; x++) set(x, y, HILL);
  for (const [px, h] of [
    [cx - 13, 7],
    [cx - 10, 5],
    [cx + 11, 6],
    [cx + 14, 8],
  ]) {
    for (let i = 0; i < h; i++) {
      const half = Math.floor(((h - i) / h) * 2.4);
      for (let dx = -half; dx <= half; dx++) set(px + dx, gy - i, PINE);
    }
  }
  for (let x = 0; x < size; x++) {
    set(x, gy + 1, GRASS);
    for (let y = gy + 2; y < size; y++) set(x, y, GROUND);
  }

  // Light from the window, in steps, on the shore around the cabin.
  const wx = cx - 5;
  const wy = gy - 6;
  for (let y = horizon; y <= gy; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot((x - wx - 2) * 0.8, y - wy - 1.5);
      if (d > 8) continue;
      const a = Math.ceil((1 - d / 8) * 3) / 3;
      if (a * 0.5 > bayer(x, y)) blend(x, y, HOST, 0.22 * a + 0.06);
    }
  }

  // The cabin, its chimney, door and antenna.
  for (let y = gy - 8; y <= gy; y++) {
    for (let x = cx - 7; x <= cx + 7; x++) set(x, y, (gy - y) % 2 ? WALL : PLANK);
  }
  for (let i = 0; i < 6; i++) {
    for (let x = cx - 9 + i; x <= cx + 9 - i; x++) set(x, gy - 9 - i, i === 5 ? RIDGE : ROOF);
  }
  for (let y = gy - 17; y <= gy - 12; y++) for (let x = cx + 4; x <= cx + 5; x++) set(x, y, ROOF);
  for (let y = gy - 4; y <= gy; y++) for (let x = cx + 2; x <= cx + 4; x++) set(x, y, ROOF);
  for (let y = gy - 21; y <= gy - 15; y++) set(cx - 3, y, ANTENNA);
  for (let x = cx - 4; x <= cx - 2; x++) set(x, gy - 19, ANTENNA);
  set(cx - 3, gy - 22, HOST_HI);

  // Smoke, thinning as it drifts up and right.
  for (const [dx, dy, a] of [
    [4, 18, 0.55],
    [5, 18, 0.55],
    [5, 19, 0.5],
    [6, 20, 0.45],
    [6, 21, 0.42],
    [5, 22, 0.38],
    [6, 22, 0.38],
    [6, 23, 0.34],
    [7, 24, 0.3],
    [8, 24, 0.28],
    [8, 25, 0.24],
    [9, 26, 0.2],
    [9, 27, 0.16],
  ])
    blend(cx + dx, gy - dy, SMOKE, a);

  // The window, lit.
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++)
      set(wx + x, wy + y, x === 2 ? MULLION : x === 1 && y === 1 ? HOST_HI : HOST);
  }
  return c;
}

// The same cabin redrawn at half the size, one letter to a pixel. A dot is sky.
const SMALL = [
  "................",
  ".....l..........",
  "....aaa.....s...",
  ".....a.....s....",
  ".....a....cc....",
  "....rrrrrrrr....",
  "...RRRRRRRRRR...",
  "..RRRRRRRRRRRR..",
  "~~~WWWWWWWWWW~~~",
  "~~~PoOPPPPDDP~~~",
  "~~~WOOWWWWDDW~~~",
  "~~~PPPPPPPDDP~~~",
  "ggghhhgggggggggg",
  "GGGGGGGGGGGGGGGG",
  "GGGGGGGGGGGGGGGG",
  "GGGGGGGGGGGGGGGG",
];
const SMALL_KEY = {
  "~": HILL,
  h: mix(GRASS, HOST, 0.3),
  G: GROUND,
  g: GRASS,
  W: WALL,
  P: PLANK,
  R: ROOF,
  c: ROOF,
  D: ROOF,
  r: RIDGE,
  a: ANTENNA,
  l: HOST_HI,
  O: HOST,
  o: HOST_HI,
  s: SMOKE,
};

function small() {
  const c = canvas(16);
  c.sky(8);
  SMALL.forEach((row, y) => [...row].forEach((ch, x) => ch !== "." && c.set(x, y, SMALL_KEY[ch])));
  return c;
}

/**
 * The icon's pixels. `small` is the 16-pixel drawing; otherwise `size` is the
 * grid, 32 for the icon itself and larger for more scenery around the cabin.
 * `rounded` cuts the corners; without it the scene fills the square, for a
 * launcher that applies its own shape.
 */
export function pixels({ small: tiny = false, size = 32, rounded = true } = {}) {
  const pad = (size - 32) / 2;
  const art = tiny ? small() : large(size, { cx: 16 + pad, gy: 25 + pad });
  if (rounded) art.round(art.size / 4);
  return art;
}

const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

/** One path per colour, a rectangle for each run of it along a row: [fill, d][]. */
export function paths(art) {
  const runs = new Map();
  const { size } = art;
  const cells = art.cells.map((c) => c && hex(c));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size;) {
      const fill = cells[y * size + x];
      let end = x + 1;
      while (end < size && cells[y * size + end] === fill) end++;
      if (fill) runs.set(fill, (runs.get(fill) ?? "") + `M${x} ${y}h${end - x}v1h-${end - x}z`);
      x = end;
    }
  }
  return [...runs].sort(([a], [b]) => (a < b ? -1 : 1));
}

const group = (art, attrs = "") =>
  `  <g${attrs}>\n` +
  paths(art)
    .map(([fill, d]) => `    <path fill="${fill}" d="${d}"/>\n`)
    .join("") +
  "  </g>\n";

/**
 * The icon as an SVG on its grid, crisp at whole multiples of it. With `both`,
 * the 16-pixel drawing takes over when the image is shown under 24 pixels
 * across, as a favicon is. Where a content security policy keeps the style
 * out, the 32-pixel drawing shows at every size.
 */
export function svg({ both = false, ...options } = {}) {
  const art = pixels(options);
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${art.size} ${art.size}" shape-rendering="crispEdges">\n`;
  if (!both) return `${open}${group(art)}</svg>\n`;
  const tiny = pixels({ small: true, rounded: options.rounded });
  return (
    open +
    "  <style>@media (max-width:23.5px){.large{display:none}.small{display:inline}}</style>\n" +
    group(art, ' class="large"') +
    group(tiny, ` class="small" display="none" transform="scale(${art.size / 16})"`) +
    "</svg>\n"
  );
}
