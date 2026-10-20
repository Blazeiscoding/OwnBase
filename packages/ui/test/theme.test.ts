import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { avatarColor } from "../src/lib/format.js";

const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");

/** The body of the first block that opens with `opening`. */
function block(opening: string): string {
  const start = css.indexOf(opening);
  if (start === -1) throw new Error(`theme.css has no ${opening}`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  throw new Error(`${opening} never closes`);
}

/** Onyx is the default, "dark"; White is "light". */
const THEME_BLOCKS = {
  dark: "@theme {",
  light: ':root[data-theme="light"] {',
} as const;
type ThemeName = keyof typeof THEME_BLOCKS;

/** A theme's colour tokens, by name without the prefix; the others inherit dark's. */
function colourTokens(theme: ThemeName = "dark"): Record<string, string> {
  const read = (text: string) => {
    const tokens: Record<string, string> = {};
    for (const [, name, value] of text.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})\b/gi))
      tokens[name!] = value!;
    return tokens;
  };
  const dark = read(block(THEME_BLOCKS.dark));
  return theme === "dark" ? dark : { ...dark, ...read(block(THEME_BLOCKS[theme])) };
}

/** WCAG 2 contrast ratio between two opaque sRGB colours, given as hex or as 0–1 channels. */
function contrast(a: string | number[], b: string | number[]): number {
  const channels = (colour: string | number[]) =>
    typeof colour === "string"
      ? [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16) / 255)
      : colour;
  const luminance = (colour: string | number[]) => {
    const [r, g, b] = channels(colour).map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** `oklch(L C h)` to gamma-encoded sRGB channels, clipped to the gamut. */
function oklchToSrgb(css: string): number[] {
  const [L, C, h] = css.match(/[\d.]+/g)!.map(Number) as [number, number, number];
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((x) => {
    const c = Math.min(1, Math.max(0, x));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  });
}

/** Every pair below this ratio, written "text on surface", so a failure names the pair. */
function unreadable(pairs: [string, string][], minimum = 4.5, theme: ThemeName = "dark"): string[] {
  const tokens = colourTokens(theme);
  return pairs
    .filter(([text, surface]) => contrast(tokens[text]!, tokens[surface]!) < minimum)
    .map(
      ([text, surface]) =>
        `${text} on ${surface}: ${contrast(tokens[text]!, tokens[surface]!).toFixed(2)}`,
    );
}

describe("the colour tokens", () => {
  it("are all declared", () => {
    expect(Object.keys(colourTokens())).toEqual(
      expect.arrayContaining([
        "deep",
        "ground",
        "raised",
        "lifted",
        "edge",
        "ink",
        "ink-dim",
        "ink-faint",
        "copper",
        "copper-deep",
        "online",
        "alert",
        "cream",
      ]),
    );
  });

  it("keep every ink readable on every surface", () => {
    const inks = ["ink", "ink-dim", "ink-faint", "copper", "online", "alert", "cream"];
    const surfaces = ["deep", "ground", "raised", "lifted"];
    expect(
      unreadable(inks.flatMap((ink) => surfaces.map((s): [string, string] => [ink, s]))),
    ).toEqual([]);
  });

  it("keep text written on the accent and alert fills readable", () => {
    // Buttons and badges on these fills write their text in the ground colour.
    expect(
      unreadable([
        ["ground", "copper"],
        ["ground", "copper-deep"],
        ["ground", "alert"],
      ]),
    ).toEqual([]);
  });
});

describe("the other themes", () => {
  const inks = ["ink", "ink-dim", "ink-faint", "copper", "online", "alert", "cream"];
  const surfaces = ["deep", "ground", "raised", "lifted"];
  const everyPair = inks.flatMap((ink) => surfaces.map((s): [string, string] => [ink, s]));
  const fills: [string, string][] = [
    ["ground", "copper"],
    ["ground", "copper-deep"],
    ["ground", "alert"],
  ];

  it("redefine every colour, so none is left from Onyx by accident", () => {
    for (const theme of ["light"] as const) {
      const own = [...block(THEME_BLOCKS[theme]).matchAll(/--color-([a-z-]+):/g)].map((m) => m[1]);
      expect(own.sort(), theme).toEqual(Object.keys(colourTokens("dark")).concat("mention").sort());
    }
  });

  it("keep White as readable as Onyx", () => {
    expect(unreadable([...everyPair, ...fills], 4.5, "light")).toEqual([]);
  });

  it("offer no theme the stylesheet does not define", () => {
    expect(css).not.toContain('data-theme="contrast"');
  });

  it("use White for the system theme on a device that prefers light, word for word", () => {
    const system = block("@media (prefers-color-scheme: light) {");
    const inner = system.slice(system.indexOf("{") + 1, system.lastIndexOf("}"));
    const normalise = (text: string) => text.replace(/\s+/g, " ").trim();
    expect(normalise(inner)).toBe(normalise(block(THEME_BLOCKS.light)));
  });
});

describe("the type scale and the radii", () => {
  // Every component's source, as written.
  const root = new URL("../src/", import.meta.url);
  const sources = Object.fromEntries(
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => [file, readFileSync(new URL(file, root), "utf8")]),
  );

  it("keep every fixed text size on the written-down scale", () => {
    const scale = new Set(["10px", "11px", "12px", "13px", "15px", "16px", "17px", "52px"]);
    const off = Object.entries(sources).flatMap(([file, text]) =>
      [...text.matchAll(/text-\[(\d+px)\]/g)]
        .map((m) => m[1]!)
        .filter((size) => !scale.has(size))
        .map((size) => `${file}: ${size}`),
    );
    expect(off).toEqual([]);
  });

  it("keep every radius to the written-down set", () => {
    const allowed = new Set([
      "rounded",
      "rounded-md",
      "rounded-lg",
      "rounded-xl",
      "rounded-2xl",
      "rounded-3xl",
      "rounded-full",
    ]);
    const off = Object.entries(sources).flatMap(([file, text]) =>
      [...text.matchAll(/(?<![\w-])(rounded(?:-[a-z0-9]+)?)(?![\w-])/g)]
        .map((m) => m[1]!)
        .filter((cls) => !allowed.has(cls))
        .map((cls) => `${file}: ${cls}`),
    );
    expect(off).toEqual([]);
  });
});

describe("colours written outside the stylesheet", () => {
  const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
  const hexes = (text: string) => [...text.matchAll(/#[0-9a-f]{6}\b/gi)].map(([hex]) => hex);

  it("match it, so no part of the app keeps the previous palette", () => {
    const tokens = colourTokens();
    const white = colourTokens("light");
    // What the window shows before the page paints, and the title bar drawn
    // over it: the window's own surface, in each theme.
    expect(hexes(read("apps/desktop/src/main/windowTheme.ts"))).toEqual([
      tokens.deep,
      tokens["ink-dim"],
      white.deep,
      white["ink-dim"],
    ]);
    expect(hexes(read("apps/desktop/src/main/index.ts"))).toEqual([]);
    for (const page of ["apps/web/index.html", "apps/desktop/src/renderer/index.html"])
      expect(hexes(read(page)), page).toEqual([tokens.deep]);
    // The browser's own bars, from the first paint and as the theme changes.
    for (const script of [
      "apps/web/public/first-paint.js",
      "apps/desktop/src/renderer/public/first-paint.js",
    ])
      expect(hexes(read(script)), script).toEqual([white.deep, tokens.deep]);
    expect(hexes(read("packages/ui/src/lib/appearance.ts"))).toEqual([tokens.deep, white.deep]);
    // What a phone shows while the installed client starts, and its bars.
    expect(hexes(read("apps/web/public/manifest.webmanifest"))).toEqual([tokens.deep, tokens.deep]);
    // The mark the favicon and the desktop icons are drawn from, as BrandMark draws it.
    for (const icon of [
      "apps/web/public/tandem.svg",
      "apps/desktop/src/renderer/public/tandem.svg",
    ])
      expect(hexes(read(icon)), icon).toEqual([tokens.copper, tokens.ground]);
  });
});

describe("the palette", () => {
  const repo = new URL("../../../", import.meta.url);

  it("is what scripts/generate-palette.mjs writes, so no colour was edited by hand", async () => {
    const { OUTPUTS } = (await import(new URL("scripts/generate-palette.mjs", repo).href)) as {
      OUTPUTS: Record<string, (text: string) => string>;
    };
    const stale = Object.entries(OUTPUTS)
      .filter(([path, write]) => {
        const text = readFileSync(new URL(path, repo), "utf8");
        return write(text) !== text;
      })
      .map(([path]) => path);
    expect(stale).toEqual([]);
  });

  it("keeps text on both ends of each gradient readable, and white on the mention red", () => {
    const declared = (opening: string, name: string) =>
      block(opening).match(new RegExp(`--${name}:([^;]*);`))![1]!;
    const stops = (opening: string, name: string) =>
      [...declared(opening, name).matchAll(/#[0-9a-f]{6}\b/gi)].map(([hex]) => hex);
    const dark = ":root {\n  color-scheme: dark;";
    const light = ':root[data-theme="light"] {\n  --shadow-float';
    const below = (ground: string, opening: string) =>
      ["accent-grad", "alert-grad"].flatMap((name) =>
        stops(opening, name)
          .filter((stop) => contrast(ground, stop) < 4.5)
          .map((stop) => `${name} ${stop}: ${contrast(ground, stop).toFixed(2)}`),
      );
    expect(below(colourTokens("dark").ground!, dark)).toEqual([]);
    expect(below(colourTokens("light").ground!, light)).toEqual([]);
    expect(contrast("#ffffff", declared(dark, "mention-red").trim())).toBeGreaterThanOrEqual(4.5);
  });
});

describe("avatar colours", () => {
  it("keep white initials readable on every one of them", () => {
    // The colour comes from a hash of the id, so enough ids reach every hue.
    const colours = new Set(Array.from({ length: 500 }, (_, i) => avatarColor(`U${i}`)));
    expect(colours.size).toBeGreaterThan(1);
    const white = [1, 1, 1];
    expect(
      [...colours]
        .map((css) => [css, contrast(white, oklchToSrgb(css))] as const)
        .filter(([, ratio]) => ratio < 4.5)
        .map(([css, ratio]) => `${css}: ${ratio.toFixed(2)}`),
    ).toEqual([]);
  });
});

describe("emoji in text", () => {
  it("come from an emoji face named after every text face, so no letter or digit does", () => {
    const theme = block("@theme {");
    const stack = (name: string) =>
      new RegExp(`--font-${name}:([^;]+);`)
        .exec(theme)![1]!
        .split(",")
        .map((face) => face.trim());
    expect(stack("sans").slice(-3)).toEqual([
      '"Apple Color Emoji"',
      '"Noto Color Emoji"',
      "sans-serif",
    ]);
    expect(stack("mono").slice(-3)).toEqual([
      '"Apple Color Emoji"',
      '"Noto Color Emoji"',
      "monospace",
    ]);
    // What holds only emoji takes them first.
    expect(stack("emoji")).toEqual([
      '"Apple Color Emoji"',
      '"Noto Color Emoji"',
      "var(--font-sans)",
    ]);
  });
});

describe("the emoji picker's grid", () => {
  it("shows its scrollbar before the pointer is over it, unlike the app's others", () => {
    // Every other scrollbar waits for the pointer.
    expect(block("until the pointer is over them. */\n* {")).toContain(
      "scrollbar-color: transparent transparent;",
    );
    const grid = block(".emoji-scroll {");
    expect(grid).toMatch(/scrollbar-color: color-mix\([^;]*var\(--color-ink\)[^;]*\) transparent;/);
    expect(grid).toContain("scrollbar-gutter: stable;");
  });
});
