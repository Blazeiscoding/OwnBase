// node scripts/generate-palette.mjs
//
// Tandem's palette, generated in OKLCH from the inputs below (UX-11). Each
// colour is a point on one scale: a lightness from 0 (black) to 1 (white), a
// chroma (how much colour) and a hue. Surfaces and inks share one graphite
// hue; the accent is Tandem's own orange, kept on purpose; online, alert, the
// highlight and the background washes each have a hue of their own. Where a
// colour falls outside what a screen shows (sRGB), its chroma is lowered until
// it fits, keeping its lightness and hue, and it is written as hex.
//
// Change the inputs, run this, and every file below follows. packages/ui/
// test/theme.test.ts fails when one of them was edited by hand, and checks
// that every ink still reads at 4.5:1 on every surface in both themes.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const INPUTS = {
  /** chaicode.com's orange: Tandem's accent, kept on purpose. */
  accent: "#f97316",
  /** Surfaces and inks: one graphite hue, this much colour at middle lightness, less toward black and white. */
  neutral: { hue: 282, chroma: 0.014 },
  hues: { online: 151, alert: 25, cream: 74, violet: 296, pink: 356 },
  /** Where each colour sits in each theme, as [lightness, chroma]; chroma is lowered to fit. */
  themes: {
    dark: {
      deep: 0.18,
      ground: 0.22,
      raised: 0.245,
      lifted: 0.285,
      edge: 0.3,
      ink: 0.965,
      "ink-dim": 0.79,
      "ink-faint": 0.7,
      // The accent itself; its deeper step for pressed and hovered.
      copper: null,
      "copper-deep": [0.665, 0.187],
      online: [0.8, 0.18],
      alert: [0.71, 0.17],
      cream: [0.885, 0.08],
    },
    light: {
      deep: 0.935,
      ground: 1,
      raised: 0.975,
      lifted: 0.945,
      edge: 0.91,
      ink: 0.17,
      "ink-dim": 0.43,
      "ink-faint": 0.49,
      // The orange, deepened until it reads at 4.5:1 on white.
      copper: [0.51, 0.187],
      "copper-deep": [0.465, 0.187],
      online: [0.465, 0.12],
      alert: [0.54, 0.19],
      cream: [0.45, 0.095],
    },
  },
  /**
   * The vibrant layer: each gradient's ends as steps from the colour in its
   * middle (lightness added, chroma multiplied, hue turned), and the washes.
   */
  vibrant: {
    dark: {
      accentGrad: { from: [0.09, 0.75, 9], to: [-0.05, 1.05, -8] },
      alertGrad: { from: [0.06, 0.8, 0], to: [-0.045, 1.1, 1] },
      textGrad: { from: [0.12, 0.7, 14], pink: [0.725, 0.175] },
    },
    light: {
      accentGrad: { from: [0.05, 1.1, 1], to: [-0.045, 1, 0] },
      alertGrad: { from: [0.03, 1, 0], to: [-0.04, 1, 0] },
      textGrad: { via: [0.02, 1.15, -7], pink: [0.525, 0.2] },
    },
    /** The washes the backgrounds are lit with, as [lightness, chroma]. */
    violet: [0.606, 0.25],
    pink: [0.656, 0.241],
    /** The aurora's violet on the sign-in page. */
    aurora: [0.672, 0.214],
    /** Discord's red for what names you: white on it reads at 4.5:1 in both themes. */
    mentionRed: [0.588, 0.2],
  },
};

// --- OKLCH and sRGB -------------------------------------------------------

/** Linear sRGB channels of `oklch(L C h)`, unclipped. */
function oklchToLinear([L, C, h]) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb) => rgb.every((c) => c >= -1e-6 && c <= 1 + 1e-6);

/** The same lightness and hue with chroma lowered until sRGB holds it. */
export function toGamut([L, C, h]) {
  const lightness = Math.min(1, Math.max(0, L));
  if (inGamut(oklchToLinear([lightness, C, h]))) return [lightness, C, h];
  let [low, high] = [0, C];
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (inGamut(oklchToLinear([lightness, mid, h]))) low = mid;
    else high = mid;
  }
  return [lightness, low, h];
}

const encode = (c) => {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
};

/** 0–255 sRGB channels of a colour on the scale. */
export function channels(lch) {
  return oklchToLinear(toGamut(lch)).map((c) => Math.round(encode(c) * 255));
}

export function hex(lch) {
  return `#${channels(lch)
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** `oklch(L C h)` of a hex colour. */
export function fromHex(value) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return [L, Math.hypot(A, B), h < 0 ? h + 360 : h];
}

// --- The palette ----------------------------------------------------------

const ROLE_HUE = {
  copper: "accent",
  "copper-deep": "accent",
  online: "online",
  alert: "alert",
  cream: "cream",
};

/** A step from `lch`: lightness added, chroma multiplied, hue turned. */
const step = ([L, C, h], [dL, kC, dh]) => toGamut([L + dL, C * kC, h + dh]);
const rgba = (lch, alpha) => `rgba(${channels(lch).join(", ")}, ${alpha})`;
const rgbSpace = (lch, alpha) => `rgb(${channels(lch).join(" ")} / ${alpha})`;

/** Every colour of one theme, on the scale, by token name. */
function themeColours(theme) {
  const accent = fromHex(INPUTS.accent);
  const hues = { ...INPUTS.hues, accent: accent[2] };
  const colours = {};
  for (const [name, value] of Object.entries(INPUTS.themes[theme])) {
    if (value === null) colours[name] = accent;
    else if (typeof value === "number") {
      const { hue, chroma } = INPUTS.neutral;
      colours[name] = toGamut([value, chroma * 4 * value * (1 - value), hue]);
    } else colours[name] = toGamut([value[0], value[1], hues[ROLE_HUE[name]]]);
  }
  return colours;
}

/** Each theme's tokens and the declarations made from them, as CSS values by name. */
export function palette() {
  const accent = fromHex(INPUTS.accent);
  const { vibrant, hues } = INPUTS;
  const violet = toGamut([...vibrant.violet, hues.violet]);
  const pink = toGamut([...vibrant.pink, hues.pink]);
  const dark = themeColours("dark");
  const light = themeColours("light");
  const tokens = (colours) =>
    Object.fromEntries(Object.entries(colours).map(([name, lch]) => [`--color-${name}`, hex(lch)]));
  const grad = (angle, stops) =>
    `linear-gradient(${angle}deg, ${stops.map(([lch, at]) => `${hex(lch)} ${at}%`).join(", ")})`;

  const d = vibrant.dark;
  const l = vibrant.light;
  const lightInk = light.ink;
  return {
    /** The dark theme's tokens, in `@theme`. */
    darkTokens: { ...tokens(dark), "--color-mention": rgba(dark.copper, 0.08) },
    /** The dark theme's vibrant layer, and what both themes share, in `:root`. */
    darkRoot: {
      "--glow": rgba(accent, 0.2),
      "--accent-grad": grad(135, [
        [step(dark.copper, d.accentGrad.from), 0],
        [dark.copper, 48],
        [step(dark.copper, d.accentGrad.to), 100],
      ]),
      "--accent-glow": rgba(dark.copper, 0.45),
      "--alert-grad": grad(135, [
        [step(dark.alert, d.alertGrad.from), 0],
        [dark.alert, 50],
        [step(dark.alert, d.alertGrad.to), 100],
      ]),
      "--aura-1": rgba(accent, 0.14),
      "--aura-2": rgba(violet, 0.12),
      "--aura-3": rgba(pink, 0.08),
      "--text-grad": grad(100, [
        [step(dark.copper, d.textGrad.from), 0],
        [dark.copper, 45],
        [toGamut([...d.textGrad.pink, hues.pink]), 100],
      ]),
      "--aurora-violet": hex([...vibrant.aurora, hues.violet]),
      "--mention-red": hex([...vibrant.mentionRed, hues.alert]),
      // The theme picker shows both themes at once, whichever is on.
      "--onyx-deep": hex(dark.deep),
      "--onyx-ground": hex(dark.ground),
      "--onyx-edge": hex(dark.edge),
      "--white-deep": hex(light.deep),
      "--white-ground": hex(light.ground),
      "--white-edge": hex(light.edge),
    },
    /** The light theme's tokens and cards. */
    lightTokens: {
      ...tokens(light),
      "--color-mention": rgba(light.copper, 0.06),
      "--card-edge": rgba(lightInk, 0.09),
      "--card-edge-hover": rgba(lightInk, 0.18),
      "--glow": rgba(accent, 0.12),
      "--hex": `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='31.18' height='54' viewBox='0 0 31.18 54'%3E%3Cpath d='M15.59 0L31.18 9v18L15.59 36 0 27V9zM15.59 36v18' fill='none' stroke='rgba(${channels(lightInk).join(",")},0.06)'/%3E%3C/svg%3E")`,
    },
    /** The light theme's shadows and vibrant layer. */
    lightVibrant: {
      // Each "\n\t" starts a line, indented two more than the declaration.
      "--shadow-float": `\n\t0 0 0 1px ${rgbSpace(lightInk, 0.06)}, 0 2px 4px -1px ${rgbSpace(lightInk, 0.06)},\n\t0 12px 32px -8px ${rgbSpace(lightInk, 0.16)}`,
      "--shadow-dialog": `0 0 0 1px ${rgbSpace(lightInk, 0.06)}, 0 32px 80px -16px ${rgbSpace(lightInk, 0.28)}`,
      "--accent-grad": grad(135, [
        [step(light.copper, l.accentGrad.from), 0],
        [light.copper, 55],
        [step(light.copper, l.accentGrad.to), 100],
      ]),
      "--accent-glow": rgba(light.copper, 0.32),
      "--alert-grad": grad(135, [
        [step(light.alert, l.alertGrad.from), 0],
        [light.alert, 55],
        [step(light.alert, l.alertGrad.to), 100],
      ]),
      "--aura-1": rgba(accent, 0.1),
      "--aura-2": rgba(violet, 0.08),
      "--aura-3": rgba(pink, 0.06),
      "--text-grad": grad(100, [
        [light.copper, 0],
        [step(light.copper, l.textGrad.via), 45],
        [toGamut([...l.textGrad.pink, hues.pink]), 100],
      ]),
    },
  };
}

// --- The files ------------------------------------------------------------

/** Every range of `text` that is the body of a block opening with `opening`. */
function blocks(text, opening) {
  const found = [];
  for (let start = text.indexOf(opening); start !== -1; start = text.indexOf(opening, start + 1)) {
    const open = text.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}" && --depth === 0) {
        found.push([open + 1, i]);
        break;
      }
    }
  }
  return found;
}

/** `text` with each named declaration in the blocks opening with `opening` set to its value. */
function setDeclarations(text, opening, values, { every = 1 } = {}) {
  const ranges = blocks(text, opening);
  if (ranges.length !== every)
    throw new Error(`Expected ${every} block(s) opening "${opening}", found ${ranges.length}.`);
  let out = text;
  // From the last, so earlier ranges keep their places.
  for (const [start, end] of ranges.reverse()) {
    let body = out.slice(start, end);
    for (const [name, value] of Object.entries(values)) {
      const pattern = new RegExp(`^( *)(${name.replace(/-/g, "\\-")}:)\\s*[^;]*;`, "m");
      if (!pattern.test(body)) throw new Error(`"${opening}" has no ${name}.`);
      body = body.replace(pattern, (_, indent, head) => {
        const written = value.replaceAll("\t", `${indent}  `);
        return `${indent}${head}${written.startsWith("\n") ? "" : " "}${written};`;
      });
    }
    out = out.slice(0, start) + body + out.slice(end);
  }
  return out;
}

/** `text` with its hex colours, in order, replaced by `colours`; there must be exactly as many. */
function setHexes(text, colours) {
  const found = text.match(/#[0-9a-f]{6}\b/gi) ?? [];
  if (found.length !== colours.length)
    throw new Error(`Expected ${colours.length} hex colours, found ${found.length}.`);
  let i = 0;
  return text.replace(/#[0-9a-f]{6}\b/gi, () => colours[i++]);
}

/** White's bar colour, then Onyx's, as first-paint.js chooses between them. */
function firstPaintBars(text) {
  const { darkTokens: d, lightTokens: l } = palette();
  return setHexes(text, [l["--color-deep"], d["--color-deep"]]);
}

export const OUTPUTS = {
  "packages/ui/src/theme.css": (text) => {
    const p = palette();
    let out = setDeclarations(text, "@theme {", p.darkTokens);
    out = setDeclarations(out, ":root {\n  color-scheme: dark;", p.darkRoot);
    out = setDeclarations(
      out,
      ':root[data-theme="light"] {\n  color-scheme: light;',
      p.lightTokens,
    );
    out = setDeclarations(
      out,
      ':root[data-theme="system"] {\n    color-scheme: light;',
      p.lightTokens,
    );
    out = setDeclarations(out, ':root[data-theme="light"] {\n  --shadow-float', p.lightVibrant);
    out = setDeclarations(out, ':root[data-theme="system"] {\n    --shadow-float', p.lightVibrant);
    return out;
  },
  // What the window shows before the page paints, and the title bar drawn over
  // it, in each theme.
  "apps/desktop/src/main/windowTheme.ts": (text) => {
    const { darkTokens: d, lightTokens: l } = palette();
    return setHexes(text, [
      d["--color-deep"],
      d["--color-ink-dim"],
      l["--color-deep"],
      l["--color-ink-dim"],
    ]);
  },
  // The browser's own bars: from the first paint, and as the theme changes.
  "apps/web/public/first-paint.js": firstPaintBars,
  "apps/desktop/src/renderer/public/first-paint.js": firstPaintBars,
  "packages/ui/src/lib/appearance.ts": (text) => {
    const { darkTokens: d, lightTokens: l } = palette();
    return setHexes(text, [d["--color-deep"], l["--color-deep"]]);
  },
  "apps/web/index.html": (text) => setHexes(text, [palette().darkTokens["--color-deep"]]),
  "apps/desktop/src/renderer/index.html": (text) =>
    setHexes(text, [palette().darkTokens["--color-deep"]]),
  "apps/web/public/manifest.webmanifest": (text) => {
    const deep = palette().darkTokens["--color-deep"];
    return setHexes(text, [deep, deep]);
  },
  // The mark; scripts/generate-icons.mjs draws the app icons from it.
  "apps/web/public/tandem.svg": (text) => {
    const t = palette().darkTokens;
    return setHexes(text, [t["--color-copper"], t["--color-ground"]]);
  },
  "apps/desktop/src/renderer/public/tandem.svg": (text) => {
    const t = palette().darkTokens;
    return setHexes(text, [t["--color-copper"], t["--color-ground"]]);
  },
};

const root = new URL("../", import.meta.url);
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [path, write] of Object.entries(OUTPUTS)) {
    const file = new URL(path, root);
    const before = readFileSync(file, "utf8");
    const after = write(before);
    if (after !== before) {
      writeFileSync(file, after);
      console.log(`wrote ${path}`);
    }
  }
}
