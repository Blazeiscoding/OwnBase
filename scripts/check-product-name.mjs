// Fails when a built client or server still shows one of the product's
// earlier names (P2): node scripts/check-product-name.mjs [dir ...], by
// default the browser client. Built code drops comments, so what is left
// there is what a person can see, or code that would show it. Names kept on
// purpose, such as storage keys from before, are lowercase and pass.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Names the product had before, as a person read them. */
export const EARLIER_NAMES = /\b(?:Tandem|Gatherline)\b/g;
/** Where an earlier name is still right: the repository, until it is renamed. */
const ALLOWED = [/github\.com\/Blazeiscoding\/Tandem\b/g];
const TEXT = /\.(?:m?js|html|css|json|webmanifest|svg|txt)$/;

/** Every earlier name in `dir`'s text files, as `file:line: text`. */
export function findEarlierNames(dir) {
  const found = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (TEXT.test(entry.name)) {
        const lines = readFileSync(path, "utf8").split("\n");
        lines.forEach((line, i) => {
          const rest = ALLOWED.reduce((text, allowed) => text.replace(allowed, ""), line);
          for (const match of rest.matchAll(EARLIER_NAMES)) {
            const at = match.index ?? 0;
            const around = rest.slice(Math.max(0, at - 40), at + 40).trim();
            found.push(`${relative(dir, path).replaceAll("\\", "/")}:${i + 1}: ${around}`);
          }
        });
      }
    }
  };
  walk(dir);
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2);
  let failed = false;
  for (const dir of dirs.length ? dirs : ["apps/web/dist"]) {
    const found = findEarlierNames(dir);
    if (found.length === 0) {
      console.log(`${dir}: no earlier product name`);
      continue;
    }
    failed = true;
    console.error(`${dir} still shows an earlier product name:`);
    for (const line of found) console.error(`  ${line}`);
  }
  if (failed) process.exit(1);
}
