// Fails when the script every visit to the client downloads grows past 750 kB,
// so an addition that crosses it is a decision rather than a warning scrolled
// past in a build log. Anything opened now and then belongs in a chunk of its
// own, loaded on first use.
//
//   node scripts/check-web-bundle.mjs [built client directory...]
//
// Defaults to the browser client; the desktop app's renderer is
// apps/desktop/out/renderer once it has been built.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Bytes. Vite's 500 kB warning size left no room for features by October 2026,
 * when parsing cost about 0.02 ms a kB; this still fails an accidental jump like
 * the 125 kB of request schemas one import once brought in (#57). Raised from
 * 700 kB in November 2026 for React 19.3, which added about 30 kB. The Vite
 * configs warn at the same size.
 */
const ENTRY_LIMIT = 750_000;

const dirs = process.argv.slice(2);
if (dirs.length === 0) dirs.push("apps/web/dist");

let failed = false;
for (const dir of dirs) {
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const entries = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)].map(
    (match) => match[1],
  );
  if (entries.length === 0) {
    console.error(`${dir}: index.html loads no module script, so there is nothing to measure`);
    failed = true;
    continue;
  }
  // Chunks the entry imports statically download before it runs too. Vite
  // lists each of them as a modulepreload link, so they count against the
  // budget with it: a bundler that splits the entry up cannot hide its size.
  const preloads = [
    ...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g),
  ].map((match) => match[1]);
  const files = [...entries, ...preloads].map((src) => join(dir, src.replace(/^\.?\//, "")));
  const size = files.reduce((total, file) => total + statSync(file).size, 0);
  const named = preloads.length > 0 ? `${files[0]} and ${preloads.length} more` : files[0];
  const line = `${named}: ${(size / 1000).toFixed(1)} kB of ${ENTRY_LIMIT / 1000} kB`;
  if (size > ENTRY_LIMIT) {
    console.error(`Too large, ${line}. Load what is opened now and then on first use.`);
    failed = true;
  } else {
    console.log(line);
  }
}
if (failed) process.exit(1);
